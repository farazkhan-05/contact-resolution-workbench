from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.auth import WorkspaceContext, get_workspace_context
from app.core.database import get_db
from app.models.case import Case
from app.models.investigation import InvestigationRun
from app.schemas.investigation import HumanResponse, InvestigationResponse
from app.services.investigation_service import create_run, get_run, queue_resume, run_response
from app.tasks import investigate_evidence

router = APIRouter(tags=["investigations"])


def enqueue(db: Session, run: InvestigationRun) -> None:
    try:
        investigate_evidence.delay(run.id)
    except Exception:
        # A concurrent delivery may already be running; never overwrite its result.
        db.execute(
            update(InvestigationRun)
            .where(InvestigationRun.id == run.id, InvestigationRun.status == "PENDING")
            .values(
                status="FAILED",
                last_error_code="BROKER_UNAVAILABLE",
                last_error_message="The investigation queue is unavailable. Try again later.",
                completed_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
        )
        db.commit()
        db.refresh(run)


@router.post(
    "/cases/{case_id}/investigations", response_model=InvestigationResponse, status_code=202
)
def start(
    case_id: str,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> InvestigationResponse:
    try:
        run = create_run(db, context.workspace.id, context.user.id, case_id)
    except LookupError as exc:
        raise HTTPException(404, "Case not found.") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if run.status == "PENDING":
        enqueue(db, run)
    return run_response(run)


@router.get("/cases/{case_id}/investigations", response_model=list[InvestigationResponse])
def list_for_case(
    case_id: str,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> list[InvestigationResponse]:
    case = db.scalar(
        select(Case).where(Case.id == case_id, Case.workspace_id == context.workspace.id)
    )
    if case is None:
        raise HTTPException(404, "Case not found.")
    runs = db.scalars(
        select(InvestigationRun)
        .where(
            InvestigationRun.case_id == case_id,
            InvestigationRun.workspace_id == context.workspace.id,
        )
        .order_by(InvestigationRun.created_at.desc())
        .limit(10)
    ).all()
    return [run_response(run) for run in runs]


@router.get("/investigations/{investigation_id}", response_model=InvestigationResponse)
def get(
    investigation_id: str,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> InvestigationResponse:
    run = get_run(db, context.workspace.id, investigation_id)
    if run is None:
        raise HTTPException(404, "Investigation not found.")
    return run_response(run)


@router.post(
    "/investigations/{investigation_id}/resume",
    response_model=InvestigationResponse,
    status_code=202,
)
def resume(
    investigation_id: str,
    response: HumanResponse,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> InvestigationResponse:
    run = get_run(db, context.workspace.id, investigation_id)
    if run is None:
        raise HTTPException(404, "Investigation not found.")
    try:
        queue_resume(db, run, response, actor=f"user:{context.user.id}")
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    enqueue(db, run)
    return run_response(run)
