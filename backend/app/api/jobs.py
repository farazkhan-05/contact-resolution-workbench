from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import WorkspaceContext, get_workspace_context
from app.core.database import get_db
from app.models.job import Job
from app.schemas.api import JobResponse

router = APIRouter(prefix="/jobs", tags=["jobs"])


def response(job: Job) -> JobResponse:
    return JobResponse.model_validate(job, from_attributes=True)


@router.get("", response_model=list[JobResponse])
def list_jobs(
    context: WorkspaceContext = Depends(get_workspace_context), db: Session = Depends(get_db)
) -> list[JobResponse]:
    return [
        response(job)
        for job in db.scalars(
            select(Job)
            .where(Job.workspace_id == context.workspace.id)
            .order_by(Job.created_at.desc())
        ).all()
    ]


@router.get("/{job_id}", response_model=JobResponse)
def get_job(
    job_id: str,
    context: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> JobResponse:
    job = db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == context.workspace.id))
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return response(job)
