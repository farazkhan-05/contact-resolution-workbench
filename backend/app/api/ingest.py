from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.api import CsvIngestResponse, SampleIngestResponse
from app.services.case_service import ingest_csv, ingest_sample_cases
from app.services.csv_importer import CsvValidationError
from app.services.resolution_service import ProviderError

router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("/sample", response_model=SampleIngestResponse)
def ingest_sample(db: Session = Depends(get_db)) -> SampleIngestResponse:
    """Ingest standard 8 synthetic benchmark cases idempotently."""
    try:
        return ingest_sample_cases(db)
    except ProviderError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Candidate evidence could not be retrieved. {e}",
        ) from e


@router.post("/csv", response_model=CsvIngestResponse)
def upload_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> CsvIngestResponse:
    """Upload and validate synthetic profile CSV batch."""
    try:
        content = file.file.read().decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise HTTPException(
            status_code=422,
            detail=f"Could not read uploaded file as UTF-8 text: {e}",
        ) from e
    except Exception as e:
        raise HTTPException(
            status_code=422,
            detail=f"Failed to read uploaded file: {e}",
        ) from e

    try:
        return ingest_csv(db, content)
    except CsvValidationError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except ProviderError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Candidate evidence could not be retrieved. {e}",
        ) from e
