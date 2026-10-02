"""Disposable PostgreSQL checkpoints and real Celery; no live model required."""

import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.audit import AuditLog
from app.models.case import Case
from app.models.investigation import InvestigationRun
from app.schemas.investigation import HumanResponse
from app.services.investigation_graph import build_graph
from app.services.investigation_operations import InvestigationOperations
from app.services.investigation_service import (
    execute_run,
    postgres_checkpointer,
    queue_resume,
    setup_checkpoints,
)
from app.tasks import investigate_evidence
from tests.mcp_worker import investigate_mcp_fixture
from tests.test_investigations import FakeExtractor, counts, seed_run

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_ASYNC_INTEGRATION") != "1",
    reason="requires explicitly enabled disposable PostgreSQL and Redis",
)


@pytest.fixture(autouse=True)
def disposable_only() -> None:
    from sqlalchemy.engine import make_url

    assert make_url(settings.DATABASE_URL).host in {"localhost", "127.0.0.1", "postgres"}
    setup_checkpoints()


def test_postgres_checkpoint_survives_reconstruction_and_resume() -> None:
    run = seed_run(SessionLocal)
    model = FakeExtractor()
    with postgres_checkpointer() as saver:
        execute_run(run.id, saver, SessionLocal, model)
        persisted = saver.get_tuple({"configurable": {"thread_id": run.thread_id}})
        assert persisted is not None
        assert persisted.checkpoint["channel_values"]["notes_used"]
        # Verify actual rows, not just the saver API.
        assert (
            saver.conn.execute(  # type: ignore[union-attr]
                "SELECT count(*) AS n FROM checkpoints WHERE thread_id = %s", (run.thread_id,)
            ).fetchone()["n"]
            > 0
        )
    before = counts(SessionLocal)
    # New saver connection AND new compiled graph after closing the first context.
    with SessionLocal() as db:
        current = db.get(InvestigationRun, run.id)
        assert current is not None and current.status == "WAITING_FOR_HUMAN"
        queue_resume(db, current, HumanResponse(action="STOP"))
    with postgres_checkpointer() as recreated:
        execute_run(run.id, recreated, SessionLocal, FakeExtractor())
        snapshot = build_graph(SessionLocal, recreated, FakeExtractor()).get_state(
            {"configurable": {"thread_id": run.thread_id}}
        )
        assert snapshot.values["outcome"] == "HUMAN_REVIEW_REQUIRED"
        assert not snapshot.next
        execute_run(run.id, recreated, SessionLocal, FakeExtractor())
    after = counts(SessionLocal)
    assert after[:2] == before[:2]
    assert after[2] == before[2] + 2
    assert model.extraction_calls == 1
    with SessionLocal() as db:
        current = db.get(InvestigationRun, run.id)
        assert current is not None and current.status == "SUCCEEDED"
        assert current.thread_id == run.thread_id
        assert db.get(Case, run.case_id).review_decision == "PENDING"


def test_concurrent_duplicate_worker_delivery_serializes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = seed_run(SessionLocal)
    model = FakeExtractor()
    original = InvestigationOperations.retrieve
    import threading

    started, release = threading.Event(), threading.Event()

    def slow(self: InvestigationOperations, state: Any) -> Any:
        started.set()
        assert release.wait(timeout=10)
        return original(self, state)

    monkeypatch.setattr(InvestigationOperations, "retrieve", slow)

    def execute() -> None:
        with postgres_checkpointer() as saver:
            execute_run(run.id, saver, SessionLocal, model)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(execute)
        assert started.wait(timeout=10)
        duplicate = pool.submit(execute)
        duplicate.result(timeout=10)
        release.set()
        first.result(timeout=10)
    assert model.plan_calls == model.extraction_calls == 1


def wait_status(run_id: str, expected: str) -> None:
    for _ in range(40):
        with SessionLocal() as db:
            run = db.get(InvestigationRun, run_id)
            assert run is not None
            assert run.status != "FAILED", run.last_error_message
            if run.status == expected:
                return
        time.sleep(0.5)
    pytest.fail("Worker did not complete investigation transition.")


def test_investigation_crosses_real_broker_worker_interrupt_resume() -> None:
    # No approved notes for this name: safe human direction without a Gemini call.
    run = seed_run(SessionLocal)
    with SessionLocal() as db:
        case = db.get(Case, run.case_id)
        case.raw_name = "No Approved Synthetic Artifact"
        db.commit()
    investigate_evidence.delay(run.id)
    investigate_evidence.delay(run.id)
    wait_status(run.id, "WAITING_FOR_HUMAN")
    before = counts(SessionLocal)
    with SessionLocal() as db:
        queue_resume(db, db.get(InvestigationRun, run.id), HumanResponse(action="STOP"))
    investigate_evidence.delay(run.id)
    investigate_evidence.delay(run.id)
    wait_status(run.id, "SUCCEEDED")
    with SessionLocal() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.outcome == "HUMAN_REVIEW_REQUIRED"
        assert current.thread_id == run.thread_id
        assert db.scalar(select(Case.review_decision).where(Case.id == run.case_id)) == "PENDING"
    after = counts(SessionLocal)
    assert after[:2] == before[:2]
    assert after[2] == before[2] + 2


def test_celery_postgres_resume_obtains_mcp_evidence_idempotently() -> None:
    run = seed_run(SessionLocal)
    investigate_mcp_fixture.delay(run.id)
    investigate_mcp_fixture.delay(run.id)
    wait_status(run.id, "WAITING_FOR_HUMAN")
    with SessionLocal() as db:
        queue_resume(
            db, db.get(InvestigationRun, run.id), HumanResponse(action="RETRIEVE_SYNTHETIC_NOTES")
        )
    investigate_mcp_fixture.delay(run.id)
    wait_status(run.id, "WAITING_FOR_HUMAN")
    with postgres_checkpointer() as saver:
        checkpoint = saver.get_tuple({"configurable": {"thread_id": run.thread_id}})
        assert checkpoint is not None
        assert checkpoint.checkpoint["channel_values"]["notes_used"]
        assert checkpoint.checkpoint["channel_values"]["deterministic_routing"]
    with SessionLocal() as db:
        events = db.scalars(
            select(AuditLog).where(
                AuditLog.case_id == run.case_id, AuditLog.event_type == "INVESTIGATION_MCP_TOOL"
            )
        ).all()
        assert {row.payload["mcp_tool"] for row in events} == {
            "get_resolution_case",
            "request_human_review",
            "retrieve_synthetic_notes",
            "get_case_evidence",
        }
        evidence = db.scalar(
            select(AuditLog).where(
                AuditLog.case_id == run.case_id,
                AuditLog.event_type == "INVESTIGATION_EVIDENCE_ADDED",
            )
        )
        assert evidence.payload["mcp_tool"] == "retrieve_synthetic_notes"
        queue_resume(db, db.get(InvestigationRun, run.id), HumanResponse(action="STOP"))
    before = counts(SessionLocal)
    investigate_mcp_fixture.delay(run.id)
    wait_status(run.id, "SUCCEEDED")
    after = counts(SessionLocal)
    assert before[:2] == after[:2]
    assert after[2] == before[2] + 1  # Completion; review-tool provenance already exists.
    investigate_mcp_fixture.delay(run.id)
    # A synchronous redelivery after the worker transition also leaves effects unchanged.
    with postgres_checkpointer() as saver:
        execute_run(run.id, saver, SessionLocal, FakeExtractor())
    assert counts(SessionLocal) == after
    with SessionLocal() as db:
        assert db.get(Case, run.case_id).review_decision == "PENDING"
