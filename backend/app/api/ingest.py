from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.api import (
    CsvIngestResponse,
    SampleIngestResponse,
    UnstructuredEvidenceIngestRequest,
    UnstructuredIngestResponse,
)
from app.schemas.resolution import CaseQuery
from app.services.case_service import ingest_csv, ingest_sample_cases, persist_case_resolution
from app.services.csv_importer import CsvValidationError
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.resolution_service import ProviderError, ResolutionService

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


@router.post("/unstructured", response_model=UnstructuredIngestResponse)
def ingest_unstructured(
    request: UnstructuredEvidenceIngestRequest,
    db: Session = Depends(get_db),
) -> UnstructuredIngestResponse:
    """Extract structured fields from messy provider evidence via Gemini and resolve."""
    extractor = GeminiExtractor()
    try:
        extracted = extractor.extract_from_unstructured_text(request.raw_evidence_text)
    except GeminiExtractionError as e:
        raise HTTPException(
            status_code=422,
            detail=f"Unstructured evidence extraction failed: {e}",
        ) from e

    if not extracted.name or not extracted.name.strip():
        raise HTTPException(
            status_code=422,
            detail="Extraction failed to identify a valid person name from the provided evidence.",
        )

    query = CaseQuery(
        name=extracted.name.strip(),
        email=extracted.email.strip() if extracted.email else None,
        phone=extracted.phone.strip() if extracted.phone else None,
        employer=extracted.employer.strip() if extracted.employer else None,
        location=extracted.location.strip() if extracted.location else None,
    )

    resolver = ResolutionService()
    try:
        resolution = resolver.resolve(query)
    except ProviderError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Candidate evidence could not be retrieved. {e}",
        ) from e

    case_number = request.case_number or f"CASE-AI-{int(datetime.now(UTC).timestamp())}"
    case = persist_case_resolution(
        db=db,
        case_number=case_number,
        source_identifier=request.source_identifier or "UNSTRUCTURED_EVIDENCE_GEMINI",
        query=query,
        resolution=resolution,
        source_type="gemini_unstructured_ingest",
    )
    db.commit()

    return UnstructuredIngestResponse(
        case_id=case.id,
        case_number=case.case_number,
        extracted_profile=extracted,
        routing_status=resolution.routing_status,
        top_score=resolution.top_score,
        candidate_count=len(resolution.candidates),
    )
