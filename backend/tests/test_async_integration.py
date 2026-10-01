"""Real broker/worker verification; enabled only by the dedicated CI job."""

import os
import time

import pytest
from redis import Redis
from sqlalchemy import func, select

from app.core.database import SessionLocal
from app.models.case import Case
from app.models.job import Job
from app.models.workspace import Workspace
from app.tasks import ingest_csv_job

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_ASYNC_INTEGRATION") != "1", reason="requires Redis and PostgreSQL services"
)


def test_csv_job_crosses_real_broker_and_worker() -> None:
    with SessionLocal() as db:
        workspace = Workspace(name="Async integration")
        unrelated_workspace = Workspace(name="Other integration workspace")
        db.add_all([workspace, unrelated_workspace])
        db.flush()
        job = Job(
            workspace_id=workspace.id,
            job_type="CSV_INGEST",
            status="PENDING",
            source_label="integration.csv",
            payload="case_number,full_name\nASYNC-1,Async Example\n",
        )
        db.add(job)
        db.commit()
        job_id = job.id
        workspace_id = workspace.id
        unrelated_workspace_id = unrelated_workspace.id
    ingest_csv_job.delay(job_id, workspace_id)
    # Duplicate broker delivery is expected to be harmless, including while a worker claims it.
    ingest_csv_job.delay(job_id, workspace_id)
    for _ in range(30):
        time.sleep(1)
        with SessionLocal() as db:
            job = db.get(Job, job_id)
            if job and job.status in {"SUCCEEDED", "FAILED"}:
                assert job.status == "SUCCEEDED", job.failure_message
                assert db.scalar(
                    select(Case).where(
                        Case.workspace_id == workspace_id, Case.case_number == "ASYNC-1"
                    )
                )
                assert (
                    db.scalar(
                        select(Case.id).where(
                            Case.workspace_id == unrelated_workspace_id,
                            Case.case_number == "ASYNC-1",
                        )
                    )
                    is None
                )
                # Redelivery after success must leave the Case count unchanged.
                before_count = db.scalar(
                    select(func.count()).select_from(Case).where(Case.workspace_id == workspace_id)
                )
                ingest_csv_job.delay(job_id, workspace_id)
                redis_client = Redis.from_url(os.environ["CELERY_BROKER_URL"])
                for _ in range(10):
                    if redis_client.llen("celery") == 0:
                        break
                    time.sleep(0.5)
                time.sleep(1)
                after_count = db.scalar(
                    select(func.count()).select_from(Case).where(Case.workspace_id == workspace_id)
                )
                assert before_count == after_count == 1
                return
    pytest.fail("worker did not complete the Job")
