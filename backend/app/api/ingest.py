import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.core.auth import WorkspaceContext, get_workspace_context
from app.core.database import get_db
from app.core.observability import traced
from app.models.job import Job
from app.schemas.api import (
    JobResponse,
    SampleIngestResponse,
    UnstructuredEvidenceIngestRequest,
)
from app.services.case_service import ingest_sample_cases
from app.services.resolution_service import ProviderError
from app.tasks import ingest_csv_job, ingest_unstructured_job

router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("/sample", response_model=SampleIngestResponse)
def ingest_sample(
    context: WorkspaceContext = Depends(get_workspace_context), db: Session = Depends(get_db)
) -> SampleIngestResponse:
    """Ingest standard 8 synthetic benchmark cases idempotently."""
    try:
        return ingest_sample_cases(db, context.workspace.id)
    except ProviderError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Candidate evidence could not be retrieved. {e}",
        ) from e


@router.post("/csv", response_model=JobResponse, status_code=202)
@traced("api.job.enqueue", **{"job.type": "CSV_INGEST"})
def upload_csv(
    file: UploadFile = File(...),
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> JobResponse:
    """Persist a bounded CSV payload and enqueue durable background ingestion."""
    try:
        uploaded_bytes = file.file.read(256_001)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to read uploaded file: {e}") from e
    if len(uploaded_bytes) > 256_000:
        raise HTTPException(
            status_code=413, detail="CSV exceeds the 256 KB asynchronous upload limit."
        )
    try:
        content = uploaded_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise HTTPException(
            status_code=422,
            detail=f"Could not read uploaded file as UTF-8 text: {e}",
        ) from e

    # Structural validation happens in the worker so deterministic failures are inspectable Jobs.
    job = Job(
        workspace_id=context.workspace.id,
        job_type="CSV_INGEST",
        status="PENDING",
        source_label=file.filename or "upload.csv",
        payload=content,
    )
    db.add(job)
    db.commit()
    try:
        async_result = ingest_csv_job.delay(job.id, context.workspace.id)
        job.celery_task_id = async_result.id
        db.commit()
    except Exception:
        job.status = "FAILED"
        job.failure_code = "BROKER_UNAVAILABLE"
        job.failure_message = "The ingestion queue is unavailable. Please try again later."
        job.completed_at = datetime.now(UTC)
        db.commit()
    return JobResponse.model_validate(job, from_attributes=True)


@router.post("/unstructured", response_model=JobResponse, status_code=202)
@traced("api.job.enqueue", **{"job.type": "UNSTRUCTURED_INGEST"})
def ingest_unstructured(
    request: UnstructuredEvidenceIngestRequest,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> JobResponse:
    """Queue bounded Gemini evidence extraction; worker receives only the Job ID."""
    case_number = request.case_number or f"CASE-AI-{int(datetime.now(UTC).timestamp())}"
    job = Job(
        workspace_id=context.workspace.id,
        job_type="GEMINI_UNSTRUCTURED_INGEST",
        status="PENDING",
        source_label=request.source_identifier,
        payload=json.dumps(
            {
                "raw_evidence_text": request.raw_evidence_text,
                "source_identifier": request.source_identifier,
                "case_number": case_number,
            }
        ),
    )
    db.add(job)
    db.commit()
    try:
        result = ingest_unstructured_job.delay(job.id, context.workspace.id)
        job.celery_task_id = result.id
        db.commit()
    except Exception:
        job.status = "FAILED"
        job.failure_code = "BROKER_UNAVAILABLE"
        job.failure_message = "The ingestion queue is unavailable. Please try again later."
        job.completed_at = datetime.now(UTC)
        db.commit()
    return JobResponse.model_validate(job, from_attributes=True)
