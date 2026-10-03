from collections.abc import Generator

import pytest
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
from app.services.extractor import GeminiExtractor
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


def test_ai_publication_failure_cannot_downgrade_completed_worker(
    jobs_client: tuple[TestClient, sessionmaker[Session]], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.schemas.resolution import ExtractedCandidateProfile

    client, maker = jobs_client
    headers = _workspace(client)
    monkeypatch.setattr(task_module, "SessionLocal", maker)
    monkeypatch.setattr(
        GeminiExtractor,
        "extract_from_unstructured_text",
        lambda *args, **kwargs: ExtractedCandidateProfile(name="Claire Reynolds"),
    )

    def publish(job_id: str, workspace_id: str) -> None:
        ingest_unstructured_job.run(job_id, workspace_id)
        raise ConnectionError("synthetic publication acknowledgement failure")

    monkeypatch.setattr(ingest.ingest_unstructured_job, "delay", publish)
    response = client.post(
        "/api/v1/ingest/unstructured",
        headers=headers,
        json={"raw_evidence_text": "synthetic", "case_number": "F06-PUBLICATION"},
    )
    assert response.status_code == 202
    assert response.json()["status"] == "SUCCEEDED"
    with maker() as db:
        assert db.query(Case).count() == 1
        assert db.get(Job, response.json()["id"]).failure_code is None


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


@pytest.mark.parametrize(
    "status,exhaust,expected_code,calls",
    [
        (429, False, None, 2),
        (429, True, "RATE_LIMITED", 2),
        (504, False, None, 2),
        (504, True, "PROVIDER_TIMEOUT", 3),
        (503, False, None, 2),
        (408, False, None, 2),
        (400, True, "PROVIDER_REJECTED", 1),
        (401, True, "PROVIDER_AUTH_ERROR", 1),
        (403, True, "PROVIDER_AUTH_ERROR", 1),
        (402, True, "PROVIDER_QUOTA_EXHAUSTED", 1),
    ],
)
def test_provider_retries_preserve_durable_job_and_exactly_one_case(
    jobs_client: tuple[TestClient, sessionmaker[Session]],
    monkeypatch: pytest.MonkeyPatch,
    status: int,
    exhaust: bool,
    expected_code: str | None,
    calls: int,
) -> None:
    from unittest.mock import MagicMock

    from google.genai.errors import ClientError, ServerError

    client, maker = jobs_client
    headers = _workspace(client)
    monkeypatch.setattr(
        ingest.ingest_unstructured_job, "delay", lambda *_: type("R", (), {"id": "test"})()
    )
    response = client.post(
        "/api/v1/ingest/unstructured",
        headers=headers,
        json={
            "raw_evidence_text": "Şule Demo Çelik works at Mavişehir Teknoloji.",
            "case_number": "RETRY-TEST",
        },
    )
    job_id, workspace = response.json()["id"], headers["X-Workspace-ID"]
    monkeypatch.setattr(task_module, "SessionLocal", maker)
    provider = MagicMock()
    error = (ClientError if status < 500 else ServerError)(
        status,
        {
            "error": {
                "message": "sensitive synthetic provider message",
            }
        },
    )
    success = MagicMock(text='{"name":"Şule Demo Çelik","employer":"Mavişehir Teknoloji"}')
    provider.models.generate_content.side_effect = error if exhaust else [error, success]
    monkeypatch.setattr(GeminiExtractor, "_get_client", lambda self: provider)
    delays = []

    def sleep(delay: float) -> None:
        delays.append(delay)
        with maker() as db:
            assert db.get(Job, job_id).status == "RUNNING"
            assert db.query(Case).count() == 0
        ingest_unstructured_job.run(job_id, workspace)

    monkeypatch.setattr("app.services.extractor.time.sleep", sleep)
    ingest_unstructured_job.run(job_id, workspace)
    with maker() as db:
        job = db.get(Job, job_id)
        assert job.status == ("FAILED" if exhaust else "SUCCEEDED")
        assert job.failure_code == expected_code
        assert db.query(Case).count() == (0 if exhaust else 1)
        if not exhaust:
            assert db.query(Case).one().raw_name == "Şule Demo Çelik"
            assert db.query(Case).one().raw_employer == "Mavişehir Teknoloji"
        else:
            assert "sensitive" not in job.failure_message
    assert provider.models.generate_content.call_count == calls
    assert len(delays) == calls - 1
    # Redelivery of both successful and failed Jobs is a no-op.
    ingest_unstructured_job.run(job_id, workspace)
    assert provider.models.generate_content.call_count == calls


@pytest.mark.parametrize(
    "text,code",
    [
        ("{}", "INVALID_EXTRACTION"),
        ("not json", "EXTRACTION_MALFORMED_OUTPUT"),
        ('{"name": ["invalid"]}', "EXTRACTION_SCHEMA_INVALID"),
    ],
)
def test_empty_or_invalid_output_is_terminal_without_retry(
    jobs_client: tuple[TestClient, sessionmaker[Session]],
    monkeypatch: pytest.MonkeyPatch,
    text: str,
    code: str,
) -> None:
    from unittest.mock import MagicMock

    client, maker = jobs_client
    headers = _workspace(client)
    monkeypatch.setattr(
        ingest.ingest_unstructured_job, "delay", lambda *_: type("R", (), {"id": "test"})()
    )
    response = client.post(
        "/api/v1/ingest/unstructured",
        headers=headers,
        json={
            "raw_evidence_text": "No contact evidence.",
            "case_number": "EMPTY-TEST",
        },
    )
    monkeypatch.setattr(task_module, "SessionLocal", maker)
    provider = MagicMock()
    provider.models.generate_content.return_value = MagicMock(text=text)
    monkeypatch.setattr(GeminiExtractor, "_get_client", lambda self: provider)
    sleep = MagicMock()
    monkeypatch.setattr("app.services.extractor.time.sleep", sleep)
    ingest_unstructured_job.run(response.json()["id"], headers["X-Workspace-ID"])
    with maker() as db:
        job = db.get(Job, response.json()["id"])
        assert job.status == "FAILED" and job.failure_code == code
        assert db.query(Case).count() == 0
    assert provider.models.generate_content.call_count == 1
    sleep.assert_not_called()


def test_transient_gemini_timeout_keeps_claim_during_provider_retry(
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

    from unittest.mock import MagicMock

    provider = MagicMock()
    provider.models.generate_content.side_effect = TimeoutError("temporary provider timeout")
    monkeypatch.setattr(GeminiExtractor, "_get_client", lambda self: provider)

    def sleep(_: float) -> None:
        with maker() as db:
            assert db.get(Job, job_id).status == "RUNNING"
        # A duplicate delivery while retrying cannot acquire this Job.
        ingest_unstructured_job.run(job_id, workspace_id)

    monkeypatch.setattr("app.services.extractor.time.sleep", sleep)
    ingest_unstructured_job.run(job_id, workspace_id)
    with maker() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "FAILED"
        assert job.failure_code == "PROVIDER_TIMEOUT"
        assert provider.models.generate_content.call_count == 3
        assert job.celery_task_id == "fake"
        assert db.scalar(select(Case.id).where(Case.workspace_id == workspace_id)) is None
