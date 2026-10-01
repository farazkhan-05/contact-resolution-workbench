import json

from celery import Task
from celery.exceptions import Retry
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.core.database import SessionLocal
from app.core.observability import annotate
from app.models.job import Job
from app.schemas.resolution import CaseQuery
from app.services.case_service import ingest_csv, persist_case_resolution
from app.services.csv_importer import CsvValidationError
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.job_service import fail_job, utcnow
from app.services.resolution_service import ResolutionService


@celery_app.task(acks_late=True, reject_on_worker_lost=True)  # type: ignore[untyped-decorator]
def investigate_evidence(investigation_run_id: str) -> None:
    from app.services.investigation_service import execute_run, postgres_checkpointer

    try:
        with postgres_checkpointer() as saver:
            execute_run(investigation_run_id, saver)
    except Exception:
        from app.models.investigation import InvestigationRun

        with SessionLocal() as db:
            db.execute(
                update(InvestigationRun)
                .where(
                    InvestigationRun.id == investigation_run_id,
                    InvestigationRun.status.in_(["PENDING", "RUNNING"]),
                )
                .values(
                    status="FAILED",
                    last_error_code="CHECKPOINT_UNAVAILABLE",
                    last_error_message="Investigation persistence is unavailable.",
                    completed_at=utcnow(),
                    updated_at=utcnow(),
                )
            )
            db.commit()
            annotate(**{"operation.status": "FAILED"})


def _retry_if_transient(
    task: Task, db: Session, job_id: str, workspace_id: str, exc: Exception
) -> None:
    """Release the atomic claim before a bounded retry of rolled-back work."""
    db.rollback()
    db.execute(
        update(Job)
        .where(Job.id == job_id, Job.workspace_id == workspace_id, Job.status == "RUNNING")
        .values(status="PENDING")
    )
    db.commit()
    annotate(**{"operation.status": "RETRY"})
    raise task.retry(exc=exc, countdown=min(60, 5 * (2**task.request.retries)))


def _safe_csv_failure(exc: CsvValidationError) -> str:
    message = str(exc)
    if "duplicate case_number" in message:
        return "CSV contains duplicate case numbers."
    if "already exists in database" in message:
        return "A case number in this CSV already exists in this workspace."
    return message


@celery_app.task(bind=True, max_retries=3, default_retry_delay=5)  # type: ignore[untyped-decorator]
def ingest_csv_job(self: Task, job_id: str, workspace_id: str) -> None:
    """Idempotent ingestion keyed by durable Job ID; no browser credentials enter Celery."""
    db = SessionLocal()
    try:
        # Claim exactly one pending Job atomically. A duplicate delivery observes zero rows.
        claimed = db.execute(
            update(Job)
            .where(
                Job.id == job_id,
                Job.workspace_id == workspace_id,
                Job.status == "PENDING",
            )
            .values(status="RUNNING", started_at=utcnow())
        ).rowcount  # type: ignore[attr-defined]
        db.commit()
        if not claimed:
            return
        job = db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id))
        if job is None:
            return
        try:
            result = ingest_csv(db, job.payload, job.workspace_id, commit=False)
        except CsvValidationError as exc:
            fail_job(db, job, "INVALID_CSV", _safe_csv_failure(exc))
            return
        except IntegrityError:
            db.rollback()
            # A duplicate delivery after a commit is harmless; inspect the job state.
            job = db.get(Job, job_id)
            if job and job.status == "SUCCEEDED":
                return
            if job:
                fail_job(db, job, "PERSISTENCE_ERROR", "Could not persist the CSV batch.")
            return
        job.status = "SUCCEEDED"
        job.total_rows = result.ingested_count
        job.processed_rows = result.ingested_count
        job.successful_rows = result.created_count
        job.completed_at = utcnow()
        db.commit()
    except (ConnectionError, TimeoutError) as exc:
        _retry_if_transient(self, db, job_id, workspace_id, exc)
    except Retry:
        raise
    except Exception:
        db.rollback()
        job = db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id))
        if job:
            fail_job(db, job, "WORKER_ERROR", "The ingestion worker could not complete this job.")
        return
    finally:
        db.close()


@celery_app.task(bind=True, max_retries=3, default_retry_delay=5)  # type: ignore[untyped-decorator]
def ingest_unstructured_job(self: Task, job_id: str, workspace_id: str) -> None:
    """Run Gemini extraction outside an HTTP request, then deterministic resolution."""
    db = SessionLocal()
    try:
        claimed = db.execute(
            update(Job)
            .where(
                Job.id == job_id,
                Job.workspace_id == workspace_id,
                Job.status == "PENDING",
            )
            .values(status="RUNNING", started_at=utcnow())
        ).rowcount  # type: ignore[attr-defined]
        db.commit()
        if not claimed:
            return
        job = db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id))
        if job is None:
            return
        data = json.loads(job.payload)
        try:
            extracted = GeminiExtractor().extract_from_unstructured_text(data["raw_evidence_text"])
        except GeminiExtractionError as exc:
            if isinstance(exc.__cause__, (ConnectionError, TimeoutError)):
                _retry_if_transient(self, db, job_id, workspace_id, exc)
            fail_job(
                db,
                job,
                "GEMINI_EXTRACTION_FAILED",
                "Gemini could not extract valid structured evidence.",
            )
            return
        if not extracted.name or not extracted.name.strip():
            fail_job(db, job, "INVALID_EXTRACTION", "No valid person name was extracted.")
            return
        query = CaseQuery(
            name=extracted.name.strip(),
            email=extracted.email,
            phone=extracted.phone,
            employer=extracted.employer,
            location=extracted.location,
        )
        resolution = ResolutionService().resolve(query)
        persist_case_resolution(
            db,
            job.workspace_id,
            data["case_number"],
            data.get("source_identifier") or "UNSTRUCTURED_EVIDENCE_GEMINI",
            query,
            resolution,
            "gemini_unstructured_ingest",
        )
        db.commit()
        job = db.get(Job, job_id)
        if job:
            job.status = "SUCCEEDED"
            job.successful_rows = 1
            job.processed_rows = 1
            job.total_rows = 1
            job.completed_at = utcnow()
            db.commit()
    except (ConnectionError, TimeoutError) as exc:
        _retry_if_transient(self, db, job_id, workspace_id, exc)
    except Retry:
        raise
    except Exception:
        db.rollback()
        job = db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id))
        if job:
            fail_job(db, job, "WORKER_ERROR", "The ingestion worker could not complete this job.")
        return
    finally:
        db.close()
