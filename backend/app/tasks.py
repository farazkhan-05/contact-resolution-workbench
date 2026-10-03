import json
import logging
from time import monotonic

from celery import Task
from celery.exceptions import Retry
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.core.database import SessionLocal
from app.core.observability import annotate
from app.models.case import Case
from app.models.job import Job
from app.schemas.resolution import CaseQuery, CaseResolution
from app.services.case_service import ingest_csv, persist_case_resolution
from app.services.csv_importer import CsvValidationError
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.job_service import fail_job, utcnow
from app.services.resolution_service import ResolutionService

logger = logging.getLogger(__name__)


class AIFinalizationIntegrityError(RuntimeError):
    """Durable result cannot be reconciled safely; operator inspection is required."""


def _fail_unstructured_job(
    job_id: str,
    workspace_id: str,
    code: str,
    message: str,
    *,
    reconcile_finalization: bool = False,
    expected_resolution: CaseResolution | None = None,
    expected_case_id: str | None = None,
) -> str:
    """Reconcile/record failure using a fresh session and locked durable state.

    The payload's workspace/case_number is the existing unique result identity.
    No finalization is replayed here, and terminal Jobs are never downgraded.
    """
    with SessionLocal() as db:
        job = db.scalar(
            select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id).with_for_update()
        )
        if job is None:
            raise AIFinalizationIntegrityError("AI Job disappeared during reconciliation")
        if reconcile_finalization:
            data = json.loads(job.payload)
            case = db.scalar(
                select(Case).where(
                    Case.workspace_id == workspace_id, Case.case_number == data["case_number"]
                )
            )
            if job.status == "SUCCEEDED":
                if (
                    case is None
                    or job.successful_rows != 1
                    or job.processed_rows != 1
                    or job.total_rows != 1
                    or job.completed_at is None
                    or not {"CASE_INGESTED", "SCORED_AND_ROUTED"}.issubset(
                        {entry.event_type for entry in case.audit_logs}
                    )
                    or (expected_case_id is not None and case.id != expected_case_id)
                ):
                    raise AIFinalizationIntegrityError("AI terminal result is incomplete")
                if expected_resolution is not None:
                    ingestion_events = [
                        entry for entry in case.audit_logs if entry.event_type == "CASE_INGESTED"
                    ]
                    if (
                        len(ingestion_events) != 1
                        or ingestion_events[0].payload.get("source") != "gemini_unstructured_ingest"
                        or ingestion_events[0]
                        .payload.get("ai_extraction", {})
                        .get("originating_job_id")
                        != job.id
                    ):
                        raise AIFinalizationIntegrityError("AI provenance is inconsistent")
                    actual = (
                        len(case.candidates),
                        sum(len(candidate.evidence) for candidate in case.candidates),
                        sum(len(candidate.contradictions) for candidate in case.candidates),
                    )
                    expected = (
                        len(expected_resolution.candidates),
                        sum(
                            len(candidate.field_evidence)
                            for candidate in expected_resolution.candidates
                        ),
                        sum(
                            len(candidate.contradictions)
                            for candidate in expected_resolution.candidates
                        ),
                    )
                    if actual != expected:
                        raise AIFinalizationIntegrityError("AI resolution records are incomplete")
            elif case is not None:
                # This may be a historical contradiction or a conflicting domain identity.
                # Neither justifies creating another Case or guessing a terminal result.
                raise AIFinalizationIntegrityError("AI non-success result already has a Case")
        if job.status in {"SUCCEEDED", "FAILED"}:
            return job.status
        if job.status not in {"PENDING", "RUNNING"}:
            raise AIFinalizationIntegrityError("AI Job is in an ineligible state")
        fail_job(db, job, code, message)
        return "FAILED"


@celery_app.task(acks_late=True, reject_on_worker_lost=True)  # type: ignore[untyped-decorator]
def investigate_evidence(investigation_run_id: str) -> None:
    from app.services.investigation_failure import CheckpointUnavailable, investigation_failure
    from app.services.investigation_service import execute_run, postgres_checkpointer

    entered = False
    completed = False
    try:
        with postgres_checkpointer() as saver:
            entered = True
            execute_run(investigation_run_id, saver)
            completed = True
    except Exception as exc:
        # Only context acquisition is necessarily a checkpoint failure. Execution
        # failures are classified by their sanitized type, never by this catch's location.
        code, message = investigation_failure(
            exc if entered and not completed else CheckpointUnavailable()
        )
        logger.warning("investigation.failure run_id=%s category=%s", investigation_run_id, code)
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
                    last_error_code=code,
                    last_error_message=message,
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
            job.total_rows = exc.total_rows
            job.rejected_rows = exc.total_rows or 0
            job.processed_rows = job.rejected_rows
            fail_job(db, job, "INVALID_CSV", _safe_csv_failure(exc))
            return
        except IntegrityError:
            db.rollback()
            # A duplicate delivery after a commit is harmless; inspect the job state.
            job = db.get(Job, job_id)
            if job and job.status == "SUCCEEDED":
                return
            if job and job.status == "RUNNING":
                fail_job(db, job, "PERSISTENCE_ERROR", "Could not save the CSV. Try again.")
            return
        job.status = "SUCCEEDED"
        job.total_rows = result.ingested_count
        job.processed_rows = result.ingested_count
        job.successful_rows = result.created_count
        job.completed_at = utcnow()
        # Cases, read-back count and terminal result become visible in ONE commit.
        db.commit()
        db.refresh(job)
        annotate(**{"operation.status": job.status, "ingestion.record_count": job.successful_rows})
    except (ConnectionError, TimeoutError) as exc:
        db.rollback()
        committed_job = db.scalar(
            select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id)
        )
        if committed_job and committed_job.status == "SUCCEEDED":
            return
        _retry_if_transient(self, db, job_id, workspace_id, exc)
    except Retry:
        raise
    except Exception:
        db.rollback()
        job = db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id))
        # A lost commit acknowledgement must never overwrite an already durable success.
        if job and job.status == "RUNNING":
            fail_job(db, job, "WORKER_ERROR", "Could not save the CSV. Try again.")
        return
    finally:
        db.close()


@celery_app.task(  # type: ignore[untyped-decorator]
    bind=True, max_retries=3, soft_time_limit=100, time_limit=110
)
def ingest_unstructured_job(self: Task, job_id: str, workspace_id: str) -> None:
    """Run Gemini extraction outside an HTTP request, then deterministic resolution."""
    started = monotonic()
    phase = "claim"
    commit_attempted = False
    resolution: CaseResolution | None = None
    case_id: str | None = None
    db = SessionLocal()
    try:
        claimed = db.execute(
            update(Job)
            .where(
                Job.id == job_id,
                Job.workspace_id == workspace_id,
                Job.status == "PENDING",
                Job.job_type == "GEMINI_UNSTRUCTURED_INGEST",
            )
            .values(status="RUNNING", started_at=utcnow())
        ).rowcount  # type: ignore[attr-defined]
        if not claimed:
            db.rollback()
            return
        job = db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id))
        if job is None:
            raise AIFinalizationIntegrityError("Claimed AI Job disappeared")
        data = json.loads(job.payload)
        # Materialize input in the short claim transaction, then release the connection.
        db.commit()
        db.close()
        phase = "extraction"
        try:
            extracted = GeminiExtractor().extract_from_unstructured_text(
                data["raw_evidence_text"], retry_transient=True
            )
        except GeminiExtractionError as exc:
            _fail_unstructured_job(job_id, workspace_id, exc.code, exc.public_message)
            return
        if not extracted.name or not extracted.name.strip():
            _fail_unstructured_job(
                job_id,
                workspace_id,
                "INVALID_EXTRACTION",
                "No useful contact evidence was found in this text.",
            )
            return
        query = CaseQuery(
            name=extracted.name.strip(),
            email=extracted.email,
            phone=extracted.phone,
            employer=extracted.employer,
            location=extracted.location,
        )
        resolution = ResolutionService().resolve(query)
        phase = "finalization"
        db = SessionLocal()
        job = db.scalar(
            select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id).with_for_update()
        )
        if job is None or job.status != "RUNNING":
            raise AIFinalizationIntegrityError("AI Job is no longer eligible for finalization")
        case = persist_case_resolution(
            db,
            job.workspace_id,
            data["case_number"],
            data.get("source_identifier") or "UNSTRUCTURED_EVIDENCE_GEMINI",
            query,
            resolution,
            "gemini_unstructured_ingest",
            originating_job=job,
            extracted_job_title=extracted.job_title,
        )
        case_id = case.id
        job.status = "SUCCEEDED"
        job.successful_rows = 1
        job.processed_rows = 1
        job.total_rows = 1
        job.completed_at = utcnow()
        db.flush()
        phase = "commit"
        commit_attempted = True
        logger.info("ai.finalization job_id=%s phase=commit attempt=1", job_id)
        # The only finalization commit: Case, all resolution records and terminal Job.
        db.commit()
        phase = "committed"
        logger.info("ai.finalization job_id=%s outcome=committed terminal=SUCCEEDED", job_id)
        annotate(**{"operation.status": "SUCCEEDED", "ingestion.record_count": 1})
    except AIFinalizationIntegrityError:
        logger.error("ai.finalization job_id=%s phase=%s outcome=inconsistent", job_id, phase)
        raise
    except Exception:
        # Invalidate rather than reuse a possibly poisoned/disconnected transaction.
        # Any commit exception is conservatively ambiguous, even a non-driver error.
        db.invalidate()
        logger.warning(
            "ai.finalization job_id=%s phase=%s outcome=%s",
            job_id,
            phase,
            "ambiguous" if commit_attempted else "rolled_back",
        )
        try:
            terminal = _fail_unstructured_job(
                job_id,
                workspace_id,
                "WORKER_ERROR",
                "The ingestion worker could not complete this job.",
                reconcile_finalization=phase in {"finalization", "commit", "committed"},
                expected_resolution=resolution,
                expected_case_id=case_id,
            )
        except Exception:
            logger.error("ai.finalization job_id=%s outcome=reconciliation_unavailable", job_id)
            # Do not guess or replay if the fresh durable read cannot establish the outcome.
            raise AIFinalizationIntegrityError(
                "AI finalization requires operator inspection"
            ) from None
        logger.info(
            "ai.finalization job_id=%s outcome=%s terminal=%s",
            job_id,
            "reconciled_success" if terminal == "SUCCEEDED" else "reconciled_not_committed",
            terminal,
        )
    finally:
        db.close()
        logger.info(
            "ai.finalization job_id=%s phase=%s duration_ms=%d",
            job_id,
            phase,
            int((monotonic() - started) * 1000),
        )


@celery_app.task(bind=True, max_retries=3, default_retry_delay=5)  # type: ignore[untyped-decorator]
def ingest_source_job(self: Task, job_id: str, workspace_id: str) -> None:
    from app.models.source import Source, SourceIngestion
    from app.schemas.source import SourceBatch
    from app.services.source_service import process_batch

    with SessionLocal() as db:
        try:
            claimed = db.execute(
                update(Job)
                .where(
                    Job.id == job_id,
                    Job.workspace_id == workspace_id,
                    Job.job_type == "SOURCE_INGEST",
                    Job.status == "PENDING",
                )
                .values(status="RUNNING", started_at=utcnow())
            ).rowcount  # type: ignore[attr-defined]
            db.commit()
            if not claimed:
                return
            job = db.get(Job, job_id)
            assert job is not None
            run = db.scalar(select(SourceIngestion).where(SourceIngestion.job_id == job.id))
            assert run is not None
            source = db.scalar(
                select(Source).where(
                    Source.id == run.source_id, Source.workspace_id == workspace_id
                )
            )
            assert source is not None
            annotate(
                **{
                    "ingestion.mechanism": "source_api",
                    "ingestion.source_type": source.source_type,
                    "ingestion.record_count": job.total_rows or 0,
                }
            )
            process_batch(db, source, run, SourceBatch.model_validate_json(job.payload))
            job.status = "SUCCEEDED"
            job.processed_rows = job.total_rows or 0
            job.successful_rows = job.processed_rows
            job.completed_at = utcnow()
            db.commit()
            annotate(**{"operation.status": "SUCCEEDED"})
        except (ConnectionError, TimeoutError) as exc:
            _retry_if_transient(self, db, job_id, workspace_id, exc)
        except Retry:
            raise
        except Exception:
            db.rollback()
            job = db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id))
            if job:
                job.rejected_rows = job.total_rows or 0
                job.processed_rows = job.rejected_rows
                fail_job(db, job, "WORKER_ERROR", "The source batch could not be processed.")
