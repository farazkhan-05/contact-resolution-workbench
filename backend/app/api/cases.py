from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.core.auth import WorkspaceContext, get_workspace_context
from app.core.constants import ReviewDecision, RoutingStatus
from app.core.database import get_db
from app.schemas.api import (
    CaseDetailResponse,
    CaseSummaryResponse,
    DecisionRequest,
    SourceContextResponse,
)
from app.services.case_service import (
    get_case_detail,
    get_source_context,
    list_cases,
    record_decision,
)

router = APIRouter(prefix="/cases", tags=["cases"])


@router.get("", response_model=list[CaseSummaryResponse])
def get_cases(
    routing_status: RoutingStatus | None = None,
    review_decision: ReviewDecision | None = None,
    search: str | None = None,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> list[CaseSummaryResponse]:
    """Retrieve case queue with optional filters and keyword search."""
    return list_cases(
        db=db,
        workspace_id=context.workspace.id,
        routing_status=routing_status,
        review_decision=review_decision,
        search=search,
    )


@router.get("/{case_id}", response_model=CaseDetailResponse)
def get_case(
    case_id: str,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> CaseDetailResponse:
    """Retrieve full detail for a single investigation case."""
    detail = get_case_detail(db, context.workspace.id, case_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Case not found.")
    return detail


@router.post("/{case_id}/decision", response_model=CaseDetailResponse)
def submit_decision(
    case_id: str,
    request: DecisionRequest,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> CaseDetailResponse:
    """Submit human reviewer decision and update case resolution state."""
    try:
        return record_decision(
            db, context.workspace.id, case_id, request, actor=f"user:{context.user.id}"
        )
    except ValueError as e:
        msg = str(e)
        if "not found" in msg.lower():
            raise HTTPException(status_code=404, detail=msg) from e
        raise HTTPException(status_code=422, detail=msg) from e


@router.get("/{case_id}/source-context", response_model=SourceContextResponse)
def source_context(
    case_id: str,
    response: Response,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> SourceContextResponse:
    """Expose retained source text only through authenticated workspace membership."""
    headers = {"Cache-Control": "no-store, private", "Vary": "Authorization, X-Workspace-ID"}
    detail = get_source_context(db, context.workspace.id, case_id)
    if detail is None:
        raise HTTPException(404, "Source context unavailable.", headers=headers)
    response.headers.update(headers)
    return detail
