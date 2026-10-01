"""Application ownership, worker coordination and official checkpoint lifecycle."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any, cast

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.types import Command
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.audit import AuditLog
from app.models.case import Case
from app.models.investigation import InvestigationRun
from app.schemas.investigation import HumanResponse, InterruptContext, InvestigationResponse
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.investigation_graph import (
    build_graph,
    is_transient,
)
from app.services.investigation_mcp import MCPToolFailure
from app.services.investigation_operations import InvestigationState, interrupt_context


@contextmanager
def postgres_checkpointer() -> Iterator[PostgresSaver]:
    url = settings.DATABASE_URL.replace("postgresql+psycopg://", "postgresql://", 1)
    if not url.startswith("postgresql://"):
        raise RuntimeError("Investigations require PostgreSQL checkpoints.")
    with PostgresSaver.from_conn_string(url) as saver:
        yield saver


def setup_checkpoints() -> None:
    """Explicit initialization command, run once with migrations; never in an API request."""
    with postgres_checkpointer() as saver:
        saver.setup()


def get_run(db: Session, workspace_id: str, run_id: str) -> InvestigationRun | None:
    return db.scalar(
        select(InvestigationRun)
        .join(Case, Case.id == InvestigationRun.case_id)
        .where(
            InvestigationRun.id == run_id,
            InvestigationRun.workspace_id == workspace_id,
            Case.workspace_id == workspace_id,
        )
    )


def run_response(run: InvestigationRun) -> InvestigationResponse:
    response = InvestigationResponse.model_validate(run)
    if run.status == "WAITING_FOR_HUMAN":
        # Only read an internal thread after application ownership was verified by caller.
        with postgres_checkpointer() as saver:
            checkpoint = saver.get_tuple({"configurable": {"thread_id": run.thread_id}})
            if checkpoint:
                state = checkpoint.checkpoint["channel_values"]
                response.interrupt = InterruptContext.model_validate(
                    interrupt_context(cast(InvestigationState, state))
                )
    return response


def create_run(db: Session, workspace_id: str, user_id: str, case_id: str) -> InvestigationRun:
    # Case lock serializes starts; workspace authorization precedes this function.
    case = db.scalar(
        select(Case).where(Case.id == case_id, Case.workspace_id == workspace_id).with_for_update()
    )
    if case is None:
        raise LookupError("Case not found.")
    if case.routing_status != "NEEDS_REVIEW" or case.review_decision not in (
        "PENDING",
        "NEED_MORE_EVIDENCE",
    ):
        raise ValueError("Investigation requires an unresolved review case.")
    existing = db.scalar(
        select(InvestigationRun).where(
            InvestigationRun.case_id == case_id,
            InvestigationRun.workspace_id == workspace_id,
            InvestigationRun.status.in_(["PENDING", "RUNNING", "WAITING_FOR_HUMAN"]),
        )
    )
    if existing:
        return existing
    run = InvestigationRun(workspace_id=workspace_id, case_id=case_id, created_by_user_id=user_id)
    db.add(run)
    db.flush()
    db.add(
        AuditLog(
            case_id=case_id,
            event_type="INVESTIGATION_STARTED",
            actor=f"user:{user_id}",
            payload={"investigation_id": run.id},
        )
    )
    db.commit()
    return run


def queue_resume(
    db: Session, run: InvestigationRun, response: HumanResponse, actor: str = "system"
) -> None:
    context = run_response(run).interrupt
    if run.status != "WAITING_FOR_HUMAN" or context is None:
        raise ValueError("Investigation is not waiting for human input.")
    if response.action not in context.allowed_actions:
        raise ValueError("Human action is unavailable.")
    with postgres_checkpointer() as saver:
        snapshot = build_graph(SessionLocal, saver).get_state(
            {"configurable": {"thread_id": run.thread_id}}
        )
        if len(snapshot.interrupts) != 1:
            raise ValueError("Investigation has no pending interrupt.")
        resume_input = {
            "interrupt_id": snapshot.interrupts[0].id,
            "response": response.model_dump(),
        }
    count = db.execute(
        update(InvestigationRun)
        .where(
            InvestigationRun.id == run.id,
            InvestigationRun.workspace_id == run.workspace_id,
            InvestigationRun.status == "WAITING_FOR_HUMAN",
        )
        .values(status="PENDING", resume_input=resume_input, updated_at=datetime.now(UTC))
    )
    if count.rowcount != 1:  # type: ignore[attr-defined]
        db.rollback()
        raise ValueError("Investigation is not waiting for human input.")
    db.add(
        AuditLog(
            case_id=run.case_id,
            event_type="INVESTIGATION_RESUME_REQUESTED",
            actor=actor,
            payload={"investigation_id": run.id, "action": response.action},
        )
    )
    db.commit()
    db.refresh(run)


def execute_run(
    run_id: str,
    saver: BaseCheckpointSaver[Any],
    sessions: sessionmaker[Session] = SessionLocal,
    extractor: GeminiExtractor | None = None,
) -> None:
    # Persist RUNNING before the execution lock. A dead worker leaves a recoverable RUNNING
    # row; redelivery reconstructs the checkpoint. Concurrent delivery skips the locked row.
    with sessions() as db:
        db.execute(
            update(InvestigationRun)
            .where(InvestigationRun.id == run_id, InvestigationRun.status == "PENDING")
            .values(
                status="RUNNING",
                started_at=func.coalesce(InvestigationRun.started_at, datetime.now(UTC)),
                updated_at=datetime.now(UTC),
            )
        )
        db.commit()
    with sessions() as coordination:
        run = coordination.scalar(
            select(InvestigationRun)
            .where(InvestigationRun.id == run_id)
            .with_for_update(skip_locked=True, key_share=True)
        )
        if run is None or run.status != "RUNNING":
            return
        # Separate short business transactions keep evidence durable across checkpoint gaps.
        # NO KEY UPDATE permits FK checks from those transactions while serializing workers.
        graph = build_graph(sessions, saver, extractor)
        config: RunnableConfig = {"configurable": {"thread_id": run.thread_id}}
        snapshot = graph.get_state(config)
        initial: InvestigationState = {
            "investigation_run_id": run.id,
            "workspace_id": run.workspace_id,
            "case_id": run.case_id,
        }
        graph_input: Any = initial
        if snapshot.values:
            graph_input = (
                Command(resume={run.resume_input["interrupt_id"]: run.resume_input["response"]})
                if (
                    run.resume_input
                    and any(
                        item.id == run.resume_input["interrupt_id"] for item in snapshot.interrupts
                    )
                )
                else None
            )
        try:
            if not snapshot.values or snapshot.next:
                result = graph.invoke(graph_input, config, durability="sync")
            else:
                result = snapshot.values
            waiting = bool(result.get("__interrupt__")) or bool(
                graph.get_state(config).next == ("human_input",) and not run.resume_input
            )
            run.status = "WAITING_FOR_HUMAN" if waiting else "SUCCEEDED"
            run.current_step = "human_input" if waiting else "complete"
            run.outcome = result.get("outcome")
            if not waiting:
                run.completed_at = datetime.now(UTC)
            event = "INVESTIGATION_PAUSED" if waiting else "INVESTIGATION_COMPLETED"
        except Exception as exc:
            run.status = "FAILED"
            run.outcome = (
                "PROVIDER_UNAVAILABLE"
                if (
                    isinstance(exc, GeminiExtractionError)
                    or is_transient(exc)
                    or isinstance(exc, MCPToolFailure)
                    and exc.error.category == "provider_failure"
                )
                else "INSUFFICIENT_EVIDENCE"
            )
            run.last_error_code = (
                exc.error.category.upper()
                if isinstance(exc, MCPToolFailure)
                else "EVIDENCE_OPERATION_FAILED"
            )
            run.last_error_message = "Investigation could not obtain validated evidence."
            run.completed_at = datetime.now(UTC)
            event = "INVESTIGATION_FAILED"
        run.resume_input = None
        run.updated_at = datetime.now(UTC)
        # One event per transition, atomically committed with application status.
        coordination.add(
            AuditLog(
                case_id=run.case_id,
                event_type=event,
                actor="system",
                payload={"investigation_id": run.id, "outcome": run.outcome},
            )
        )
        coordination.commit()


if __name__ == "__main__":
    setup_checkpoints()
