from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.case_service import export_reviewed_cases_csv

router = APIRouter(prefix="/export", tags=["export"])


@router.get("/csv")
def export_csv(db: Session = Depends(get_db)) -> Response:
    """Download reviewed cases as CSV."""
    csv_content = export_reviewed_cases_csv(db)
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="reviewed_cases.csv"'},
    )
