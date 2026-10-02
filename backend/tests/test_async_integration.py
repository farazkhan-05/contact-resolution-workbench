"""Real broker/worker verification; enabled only by the dedicated CI job."""

import os
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from redis import Redis
from sqlalchemy import func, select

from app.core import auth
from app.core.database import SessionLocal
from app.main import app
from app.models.case import Case
from app.models.job import Job
from app.models.workspace import Workspace
from app.tasks import ingest_csv_job

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_ASYNC_INTEGRATION") != "1", reason="requires Redis and PostgreSQL services"
)


def test_csv_job_crosses_real_broker_and_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    # kind uses real HTTP; the ordinary service integration uses the same application
    # in process. Only Firebase verification is mocked; persistence and enqueue are real.
    api_url = os.environ.get("ASYNC_API_URL")
    token = os.environ.get("KIND_TEST_TOKEN", "synthetic-integration-token")
    monkeypatch.setattr(
        auth, "verify_firebase_id_token", lambda _: auth.FirebaseIdentity("async-user", None, True)
    )
    client = httpx.Client(base_url=api_url, timeout=10) if api_url else TestClient(app)
    with client:
        headers = {"Authorization": f"Bearer {token}"}
        bootstrap = client.post("/api/v1/auth/bootstrap", headers=headers)
        assert bootstrap.status_code == 200, bootstrap.text
        workspace_id = bootstrap.json()["workspaces"][0]["id"]
        headers["X-Workspace-ID"] = workspace_id
        submitted = client.post(
            "/api/v1/ingest/csv",
            headers=headers,
            files={"file": ("integration.csv", "case_number,full_name\nASYNC-1,Async Example\n")},
        )
        assert submitted.status_code == 202, submitted.text
        job_id = submitted.json()["id"]
    with SessionLocal() as db:
        unrelated_workspace = Workspace(name="Other integration workspace")
        db.add(unrelated_workspace)
        db.commit()
        submitted_job = db.get(Job, job_id)
        assert submitted_job is not None and submitted_job.workspace_id == workspace_id
        unrelated_workspace_id = unrelated_workspace.id
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


def test_source_batches_cross_real_broker_and_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    import uuid

    from app.models.source import ReferenceRecord, SourceIngestion
    from app.tasks import ingest_source_job

    monkeypatch.setattr(
        auth,
        "verify_firebase_id_token",
        lambda _: auth.FirebaseIdentity("async-source-user", None, True),
    )
    client = TestClient(app)
    headers = {"Authorization": "Bearer synthetic-integration-token"}
    bootstrap = client.post("/api/v1/auth/bootstrap", headers=headers)
    headers["X-Workspace-ID"] = bootstrap.json()["workspaces"][0]["id"]
    payload = {
        "records": [
            {
                "external_record_id": "async-" + uuid.uuid4().hex,
                "full_name": "Source Async Example",
                "old_email": "source@example.test",
            }
        ]
    }
    workspace = headers["X-Workspace-ID"]
    for kind in ["REFERENCE", "INCOMING"]:
        source = client.post(
            "/api/v1/sources", headers=headers, json={"name": "Async " + kind, "source_type": kind}
        )
        assert source.status_code == 201
        machine_headers = {
            "Authorization": "Bearer " + source.json()["api_key"],
            "Idempotency-Key": "async-batch",
        }
        submitted = client.post("/api/v1/source-ingestions", headers=machine_headers, json=payload)
        assert submitted.status_code == 202
        run_id, job_id = submitted.json()["id"], submitted.json()["job"]["id"]
        assert (
            client.post("/api/v1/source-ingestions", headers=machine_headers, json=payload).json()[
                "id"
            ]
            == run_id
        )
        ingest_source_job.delay(job_id, workspace)
        for _ in range(60):
            with SessionLocal() as db:
                job = db.get(Job, job_id)
                assert job is not None
                if job.status in {"SUCCEEDED", "FAILED"}:
                    assert job.status == "SUCCEEDED", job.failure_code
                    assert job.celery_task_id and job.successful_rows == 1
                    assert db.get(SourceIngestion, run_id).job_id == job_id
                    break
            time.sleep(0.5)
        else:
            pytest.fail("Source Job did not complete through worker")
        # Observe task-succeeded for a specific post-success duplicate, rather than queue emptiness.
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event

        from celery.exceptions import TimeoutError as CeleryTimeoutError

        from app.celery_app import celery_app

        ready = Event()
        completed = Event()
        duplicate_id = str(uuid.uuid4())

        def observe() -> None:
            with celery_app.connection() as connection:
                receiver = celery_app.events.Receiver(
                    connection,
                    handlers={
                        "task-succeeded": lambda event: (
                            completed.set() if event.get("uuid") == duplicate_id else None
                        ),
                    },
                )
                ready.set()
                try:
                    for _ in receiver.itercapture(limit=None, timeout=15, wakeup=True):
                        if completed.is_set():
                            return
                except CeleryTimeoutError:
                    return

        celery_app.control.enable_events()
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(observe)
                assert ready.wait(5)
                time.sleep(1)
                ingest_source_job.apply_async(args=[job_id, workspace], task_id=duplicate_id)
                assert completed.wait(15), "Duplicate source task did not complete"
                future.result(timeout=20)
        finally:
            celery_app.control.disable_events()
        with SessionLocal() as db:
            if kind == "REFERENCE":
                assert (
                    db.scalar(
                        select(func.count())
                        .select_from(ReferenceRecord)
                        .where(ReferenceRecord.ingestion_id == run_id)
                    )
                    == 1
                )
            else:
                case = db.scalar(select(Case).where(Case.ingestion_id == run_id))
                assert case is not None and len(case.candidates) >= 1
                assert (
                    db.scalar(
                        select(func.count()).select_from(Case).where(Case.ingestion_id == run_id)
                    )
                    == 1
                )
