from collections.abc import Generator

import pytest
from celery.exceptions import Retry
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

import app.services.case_service as case_service
import app.tasks as task_module
from app.api import ingest
from app.core import auth
from app.core.database import Base, get_db
from app.main import app
from app.models.case import Case
from app.models.job import Job
from app.services.case_service import persist_case_resolution as persist_case
from app.services.extractor import GeminiExtractionError
from app.tasks import ingest_csv_job, ingest_unstructured_job


@pytest.fixture
def jobs_client(
    monkeypatch: pytest.MonkeyPatch,
) -> Generator[tuple[TestClient, sessionmaker[Session]]]:
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(
        auth, "verify_firebase_id_token", lambda _: auth.FirebaseIdentity("jobs-user", None, True)
    )

    def override() -> Generator[Session]:
        db = maker()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    try:
        yield TestClient(app), maker
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)


def _workspace(client: TestClient) -> dict[str, str]:
    response = client.post("/api/v1/auth/bootstrap", headers={"Authorization": "Bearer token"})
    return {
        "Authorization": "Bearer token",
        "X-Workspace-ID": response.json()["workspaces"][0]["id"],
    }


def test_broker_failure_persists_sanitized_failed_job(
    jobs_client: tuple[TestClient, sessionmaker[Session]], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, maker = jobs_client
    monkeypatch.setattr(
        ingest.ingest_csv_job,
        "delay",
        lambda *_: (_ for _ in ()).throw(RuntimeError("redis://secret@host")),
    )
    response = client.post(
        "/api/v1/ingest/csv",
        headers=_workspace(client),
        files={"file": ("a.csv", "case_number,full_name\nA,One\n")},
    )
    assert response.status_code == 202
    assert response.json()["status"] == "FAILED"
    assert response.json()["failure_code"] == "BROKER_UNAVAILABLE"
    assert "secret" not in response.json()["failure_message"]
    with maker() as db:
        assert db.query(Job).count() == 1


def test_csv_task_is_idempotent(
    jobs_client: tuple[TestClient, sessionmaker[Session]], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, maker = jobs_client
    headers = _workspace(client)
    monkeypatch.setattr(ingest.ingest_csv_job, "delay", lambda *_: type("R", (), {"id": "fake"})())
    response = client.post(
        "/api/v1/ingest/csv",
        headers=headers,
        files={"file": ("a.csv", "case_number,full_name\nA,One\n")},
    )
    job_id = response.json()["id"]
    monkeypatch.setattr(task_module, "SessionLocal", maker)
    with maker() as db:
        workspace_id = db.get(Job, job_id).workspace_id
    ingest_csv_job.run(job_id, workspace_id)
    ingest_csv_job.run(job_id, workspace_id)
    with maker() as db:
        assert db.get(Job, job_id).status == "SUCCEEDED"
        assert db.query(Case).count() == 1


def test_csv_batch_rolls_back_partial_case_writes(
    jobs_client: tuple[TestClient, sessionmaker[Session]], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, maker = jobs_client
    monkeypatch.setattr(ingest.ingest_csv_job, "delay", lambda *_: type("R", (), {"id": "fake"})())
    response = client.post(
        "/api/v1/ingest/csv",
        headers=_workspace(client),
        files={"file": ("batch.csv", "case_number,full_name\nA,Alpha\nB,Beta\n")},
    )
    job_id = response.json()["id"]
    monkeypatch.setattr(task_module, "SessionLocal", maker)
    with maker() as db:
        workspace_id = db.get(Job, job_id).workspace_id
    calls = 0

    def fail_second(*args: object, **kwargs: object) -> Case:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("controlled persistence interruption")
        return persist_case(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(case_service, "persist_case_resolution", fail_second)
    ingest_csv_job.run(job_id, workspace_id)
    with maker() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "FAILED"
        assert job.failure_code == "WORKER_ERROR"
        assert db.scalar(select(Case.id).where(Case.workspace_id == workspace_id)) is None


def test_transient_gemini_timeout_releases_claim_for_bounded_retry(
    jobs_client: tuple[TestClient, sessionmaker[Session]], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, maker = jobs_client
    headers = _workspace(client)
    monkeypatch.setattr(
        ingest.ingest_unstructured_job,
        "delay",
        lambda *_: type("R", (), {"id": "fake"})(),
    )
    response = client.post(
        "/api/v1/ingest/unstructured",
        headers=headers,
        json={"raw_evidence_text": "synthetic provider evidence", "case_number": "GEMINI-RETRY"},
    )
    job_id = response.json()["id"]
    monkeypatch.setattr(task_module, "SessionLocal", maker)
    with maker() as db:
        workspace_id = db.get(Job, job_id).workspace_id

    class TimeoutExtractor:
        def extract_from_unstructured_text(self, _: str) -> None:
            try:
                raise TimeoutError("temporary provider timeout")
            except TimeoutError as exc:
                raise GeminiExtractionError("temporary provider failure") from exc

    retry_options: dict[str, object] = {}

    def request_retry(**kwargs: object) -> None:
        retry_options.update(kwargs)
        raise Retry("transient task retry")

    monkeypatch.setattr(task_module, "GeminiExtractor", TimeoutExtractor)
    monkeypatch.setattr(ingest_unstructured_job, "retry", request_retry)
    with pytest.raises(Retry):
        ingest_unstructured_job.run(job_id, workspace_id)
    with maker() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "PENDING"
        assert job.failure_code is None
        assert retry_options["countdown"] == 5
        assert job.celery_task_id == "fake"
        assert db.scalar(select(Case.id).where(Case.workspace_id == workspace_id)) is None
