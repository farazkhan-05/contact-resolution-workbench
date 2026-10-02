import hmac
import json
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import WorkspaceContext, get_workspace_context
from app.core.database import get_db
from app.core.observability import annotate, traced
from app.models.job import Job
from app.models.source import Source, SourceAudit, SourceIngestion
from app.schemas.api import JobResponse
from app.schemas.source import (
    IngestionResponse,
    SourceBatch,
    SourceCreate,
    SourceCredential,
    SourceResponse,
    SourceStatus,
)
from app.services.job_service import fail_job, utcnow
from app.services.source_service import digest, rotate
from app.tasks import ingest_source_job

router = APIRouter(tags=["sources"])
machine_bearer = HTTPBearer(auto_error=False)
Context = Annotated[WorkspaceContext, Depends(get_workspace_context)]
Database = Annotated[Session, Depends(get_db)]


def owner(context: WorkspaceContext) -> None:
    if context.membership.role != "OWNER":
        raise HTTPException(403, "Only workspace owners can manage source credentials.")


def scoped(db: Session, context: WorkspaceContext, source_id: str) -> Source:
    source = db.scalar(
        select(Source).where(Source.id == source_id, Source.workspace_id == context.workspace.id)
    )
    if source is None:
        raise HTTPException(404, "Source not found.")
    return source


def audit(db: Session, source: Source, context: WorkspaceContext, event: str) -> None:
    db.add(SourceAudit(source_id=source.id, actor=context.user.id, event_type=event))


def credential(source: Source, key: str) -> SourceCredential:
    return SourceCredential(**SourceResponse.model_validate(source).model_dump(), api_key=key)


def run_response(db: Session, run: SourceIngestion) -> IngestionResponse:
    job = db.get(Job, run.job_id)
    assert job is not None
    return IngestionResponse(
        id=run.id,
        source_id=run.source_id,
        created_at=run.created_at,
        job=JobResponse.model_validate(job, from_attributes=True),
    )


@router.post("/sources", response_model=SourceCredential, status_code=201)
def create_source(
    body: SourceCreate, context: Context, db: Database, response: Response
) -> SourceCredential:
    owner(context)
    source = Source(
        workspace_id=context.workspace.id,
        created_by=context.user.id,
        name=body.name,
        source_type=body.source_type,
    )
    key = rotate(source)
    db.add(source)
    db.flush()
    audit(db, source, context, "SOURCE_CREATED")
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return credential(source, key)


@router.get("/sources", response_model=list[SourceResponse])
def list_sources(context: Context, db: Database) -> list[Source]:
    return list(
        db.scalars(
            select(Source)
            .where(Source.workspace_id == context.workspace.id)
            .order_by(Source.created_at.desc())
        )
    )


@router.get("/sources/{source_id}", response_model=SourceResponse)
def get_source(source_id: str, context: Context, db: Database) -> Source:
    return scoped(db, context, source_id)


@router.post("/sources/{source_id}/rotate", response_model=SourceCredential)
def rotate_source(
    source_id: str, context: Context, db: Database, response: Response
) -> SourceCredential:
    owner(context)
    source = scoped(db, context, source_id)
    key = rotate(source)
    audit(db, source, context, "SOURCE_CREDENTIAL_ROTATED")
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return credential(source, key)


@router.patch("/sources/{source_id}", response_model=SourceResponse)
def source_status(source_id: str, body: SourceStatus, context: Context, db: Database) -> Source:
    owner(context)
    source = scoped(db, context, source_id)
    if source.status != body.status:
        source.status = body.status
        audit(
            db, source, context, "SOURCE_ENABLED" if body.status == "ACTIVE" else "SOURCE_DISABLED"
        )
        db.commit()
    return source


@router.get("/sources/{source_id}/ingestions", response_model=list[IngestionResponse])
def history(source_id: str, context: Context, db: Database) -> list[IngestionResponse]:
    scoped(db, context, source_id)
    runs = db.scalars(
        select(SourceIngestion)
        .where(SourceIngestion.source_id == source_id)
        .order_by(SourceIngestion.created_at.desc())
        .limit(50)
    )
    return [run_response(db, run) for run in runs]


def machine_source(
    db: Database,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(machine_bearer)],
) -> Source:
    key = credentials.credentials if credentials else ""
    # token_urlsafe secrets may contain underscores: the fixed identifier is 32 characters.
    prefix = key[:32] if key.startswith("crw_src_") else ""
    source = db.scalar(select(Source).where(Source.key_prefix == prefix))
    if (
        source is None
        or source.status != "ACTIVE"
        or len(key) > 200
        or not hmac.compare_digest(source.key_digest, digest(key))
    ):
        raise HTTPException(401, "Invalid or disabled source credential.")
    return source


@router.post("/source-ingestions", response_model=IngestionResponse, status_code=202)
@traced("api.job.enqueue", **{"ingestion.mechanism": "source_api"})
async def ingest_source(
    request: Request,
    db: Database,
    source: Annotated[Source, Depends(machine_source)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
) -> IngestionResponse:
    # Bound the stream before JSON parsing; never echo validation input.
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > 256_000:
            raise HTTPException(413, "JSON batch exceeds 256 KB.")
    try:
        batch = SourceBatch.model_validate_json(content)
    except ValidationError:
        raise HTTPException(
            422,
            "Invalid canonical batch. Supply 1-100 records with unique external_record_id "
            "and full_name; only old_email, old_phone, employer and location are optional.",
        ) from None
    payload = json.dumps(batch.model_dump(), sort_keys=True, separators=(",", ":"))
    retry_digest, payload_digest = digest(idempotency_key), digest(payload)

    def existing() -> SourceIngestion | None:
        return db.scalar(
            select(SourceIngestion).where(
                SourceIngestion.source_id == source.id,
                SourceIngestion.idempotency_digest == retry_digest,
            )
        )

    run = existing()
    if run is None:
        job = Job(
            workspace_id=source.workspace_id,
            job_type="SOURCE_INGEST",
            status="PENDING",
            source_label="source_api",
            payload=payload,
            total_rows=len(batch.records),
        )
        db.add(job)
        db.flush()
        run = SourceIngestion(
            source_id=source.id,
            job_id=job.id,
            idempotency_digest=retry_digest,
            payload_digest=payload_digest,
        )
        db.add(run)
        source.last_ingested_at = utcnow()
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            run = existing()
            if run is None:
                raise HTTPException(503, "Ingestion persistence unavailable.") from None
        else:
            try:
                task = ingest_source_job.delay(job.id, source.workspace_id)
                job.celery_task_id = task.id
                db.commit()
            except Exception:
                db.rollback()
                fail_job(db, job, "BROKER_UNAVAILABLE", "The ingestion queue is unavailable.")
    if not hmac.compare_digest(run.payload_digest, payload_digest):
        raise HTTPException(409, "Idempotency-Key already used with a different payload.")
    annotate(
        **{
            "ingestion.source_type": source.source_type,
            "ingestion.record_count": len(batch.records),
        }
    )
    return run_response(db, run)
