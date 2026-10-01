from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.observability import annotate
from app.models.job import Job


def utcnow() -> datetime:
    return datetime.now(UTC)


def get_job(db: Session, workspace_id: str, job_id: str) -> Job | None:
    return db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id))


def fail_job(db: Session, job: Job, code: str, message: str) -> None:
    job.status = "FAILED"
    job.failure_code = code
    job.failure_message = message[:500]
    job.completed_at = utcnow()
    db.commit()
    annotate(**{"operation.status": "FAILED"})
