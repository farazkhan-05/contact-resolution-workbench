from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.core.auth import WorkspaceContext, get_workspace_context
from app.core.database import get_db
from app.services.case_service import export_reviewed_cases_csv

router = APIRouter(prefix="/export", tags=["export"])


@router.get("/csv")
def export_csv(
    context: WorkspaceContext = Depends(get_workspace_context), db: Session = Depends(get_db)
) -> Response:
    """Download reviewed cases as CSV."""
    csv_content = export_reviewed_cases_csv(db, context.workspace.id)
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="reviewed_cases.csv"'},
    )
