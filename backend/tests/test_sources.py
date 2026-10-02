import uuid
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

import app.tasks as tasks
from app.api import sources
from app.core import auth
from app.core.database import Base, get_db
from app.core.observability import safe_attributes
from app.main import app
from app.models.case import Case
from app.models.job import Job
from app.models.source import ReferenceRecord, Source, SourceAudit, SourceIngestion
from app.models.workspace import WorkspaceMembership


@pytest.fixture
def setup(
    monkeypatch: pytest.MonkeyPatch,
) -> Generator[tuple[TestClient, sessionmaker[Session], dict[str, str], dict[str, str]]]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(
        auth, "verify_firebase_id_token", lambda token: auth.FirebaseIdentity(token, None, True)
    )
    monkeypatch.setattr(tasks, "SessionLocal", maker)
    monkeypatch.setattr(
        sources.ingest_source_job,
        "delay",
        lambda *_: type("Result", (), {"id": str(uuid.uuid4())})(),
    )

    def override() -> Generator[Session]:
        with maker() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def workspace(token: str) -> dict[str, str]:
        data = client.post(
            "/api/v1/auth/bootstrap", headers={"Authorization": "Bearer " + token}
        ).json()
        return {"Authorization": "Bearer " + token, "X-Workspace-ID": data["workspaces"][0]["id"]}

    try:
        yield client, maker, workspace("alice"), workspace("bob")
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def create(client: TestClient, headers: dict[str, str], kind: str = "REFERENCE") -> dict[str, str]:
    response = client.post(
        "/api/v1/sources", headers=headers, json={"name": "CRM Feed", "source_type": kind}
    )
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def batch(name: str = "Alex Example") -> dict[str, object]:
    return {
        "records": [
            {
                "external_record_id": "customer-1842",
                "full_name": name,
                "old_email": "alex@example.test",
                "old_phone": "+1 202 555 0123",
                "employer": "Example Company",
                "location": "Example City",
            }
        ]
    }


def post(
    client: TestClient,
    key: str,
    payload: dict[str, object] | None = None,
    retry: str = "batch-001",
    **headers: str,
):
    return client.post(
        "/api/v1/source-ingestions",
        headers={"Authorization": "Bearer " + key, "Idempotency-Key": retry, **headers},
        json=payload or batch(),
    )


def execute(maker: sessionmaker[Session], response: dict[str, object]) -> None:
    job_id = response["job"]["id"]
    with maker() as db:
        job = db.get(Job, job_id)
        assert job is not None
        workspace = job.workspace_id
    tasks.ingest_source_job.run(job_id, workspace)
    tasks.ingest_source_job.run(job_id, workspace)


def test_one_time_secret_storage_audit_and_safe_telemetry(setup, caplog):
    client, maker, a, _ = setup
    source = create(client, a)
    key = source["api_key"]
    for route in [
        "/api/v1/sources",
        "/api/v1/sources/" + source["id"],
        "/api/v1/sources/" + source["id"] + "/ingestions",
    ]:
        response = client.get(route, headers=a)
        assert response.status_code == 200
        assert key not in response.text and '"api_key"' not in response.text
    with maker() as db:
        row = db.get(Source, source["id"])
        assert row.workspace_id == a["X-Workspace-ID"]
        assert row.key_digest != key and len(row.key_digest) == 64
        for table in [Source, SourceAudit]:
            for record in db.scalars(select(table)):
                assert key not in str(record.__dict__)
    assert (
        safe_attributes(
            {"api_key": key, "Authorization": key, "records": batch(), "Idempotency-Key": "private"}
        )
        == {}
    )


def test_workspace_isolation_and_machine_authority(setup):
    client, maker, a, b = setup
    source = create(client, a)
    for method, path, body in [
        ("get", "", None),
        ("get", "/ingestions", None),
        ("post", "/rotate", None),
        ("patch", "", {"status": "DISABLED"}),
    ]:
        response = client.request(
            method, "/api/v1/sources/" + source["id"] + path, headers=b, json=body
        )
        assert response.status_code == 404
    assert client.get("/api/v1/sources", headers=b).json() == []
    denied = client.get("/api/v1/sources", headers={**a, "X-Workspace-ID": b["X-Workspace-ID"]})
    assert denied.status_code == 403
    result = post(client, source["api_key"], **{"X-Workspace-ID": b["X-Workspace-ID"]})
    assert result.status_code == 202
    assert result.json()["job"]["workspace_id"] == a["X-Workspace-ID"]
    assert client.get("/api/v1/jobs/" + result.json()["job"]["id"], headers=b).status_code == 404
    assert (
        client.get(
            "/api/v1/cases", headers={"Authorization": "Bearer " + source["api_key"]}
        ).status_code
        == 401
    )


def test_owner_only_management(setup):
    client, maker, a, _ = setup
    source = create(client, a)
    with maker() as db:
        membership = db.scalar(
            select(WorkspaceMembership).where(
                WorkspaceMembership.workspace_id == a["X-Workspace-ID"]
            )
        )
        membership.role = "MEMBER"
        db.commit()
    assert client.get("/api/v1/sources", headers=a).status_code == 200
    assert (
        client.post(
            "/api/v1/sources", headers=a, json={"name": "x", "source_type": "REFERENCE"}
        ).status_code
        == 403
    )
    assert client.post("/api/v1/sources/" + source["id"] + "/rotate", headers=a).status_code == 403
    assert (
        client.patch(
            "/api/v1/sources/" + source["id"], headers=a, json={"status": "DISABLED"}
        ).status_code
        == 403
    )


def test_rotation_disabled_enabled_and_history(setup):
    client, maker, a, _ = setup
    source = create(client, a)
    accepted = post(client, source["api_key"])
    new = client.post("/api/v1/sources/" + source["id"] + "/rotate", headers=a)
    assert new.status_code == 200
    assert post(client, source["api_key"]).status_code == 401
    key = new.json()["api_key"]
    assert post(client, key).json()["id"] == accepted.json()["id"]
    for state, status in [("DISABLED", 401), ("ACTIVE", 202)]:
        assert (
            client.patch(
                "/api/v1/sources/" + source["id"], headers=a, json={"status": state}
            ).status_code
            == 200
        )
        assert post(client, key).status_code == status
    assert len(client.get("/api/v1/sources/" + source["id"] + "/ingestions", headers=a).json()) == 1
    with maker() as db:
        assert {event.event_type for event in db.scalars(select(SourceAudit))} == {
            "SOURCE_CREATED",
            "SOURCE_CREDENTIAL_ROTATED",
            "SOURCE_DISABLED",
            "SOURCE_ENABLED",
        }


@pytest.mark.parametrize("key", ["random", "crw_src_" + "0" * 24 + "_invalid", ""])
def test_invalid_keys_rejected(setup, key):
    client, _, _, _ = setup
    assert post(client, key).status_code == 401


def test_http_idempotency_and_source_namespace(setup):
    client, maker, a, _ = setup
    first = create(client, a)
    second = create(client, a)
    initial = post(client, first["api_key"])
    assert initial.status_code == 202
    repeated = post(client, first["api_key"]).json()
    assert repeated["id"] == initial.json()["id"]
    assert repeated["job"]["id"] == initial.json()["job"]["id"]
    assert post(client, first["api_key"], batch("Changed")).status_code == 409
    assert post(client, second["api_key"]).json()["id"] != initial.json()["id"]
    with maker() as db:
        assert db.query(Job).count() == 2
        assert db.query(SourceIngestion).count() == 2
        assert all(
            run.idempotency_digest != "batch-001" for run in db.scalars(select(SourceIngestion))
        )


def test_reference_upsert_source_collision_and_duplicate_delivery(setup):
    client, maker, a, _ = setup
    first, second = create(client, a), create(client, a)
    for source in [first, second]:
        execute(maker, post(client, source["api_key"]).json())
    execute(maker, post(client, first["api_key"], batch("Updated Name"), retry="batch-002").json())
    with maker() as db:
        records = list(db.scalars(select(ReferenceRecord)))
        assert len(records) == 2
        assert {record.full_name for record in records} == {"Updated Name", "Alex Example"}
        assert len({record.source_id for record in records}) == 2
        assert all(
            job.status == "SUCCEEDED" and job.successful_rows == 1
            for job in db.scalars(select(Job))
        )


def test_incoming_uses_existing_matcher_and_provenance(setup):
    client, maker, a, b = setup
    reference = create(client, a)
    execute(maker, post(client, reference["api_key"]).json())
    incoming = create(client, a, "INCOMING")
    response = post(client, incoming["api_key"])
    execute(maker, response.json())
    with maker() as db:
        cases = list(db.scalars(select(Case)))
        assert len(cases) == 1
        case = cases[0]
        assert case.source_id == incoming["id"]
        assert case.ingestion_id == response.json()["id"]
        assert case.external_record_id == "customer-1842"
        assert case.candidates[0].total_score == 100
        assert case.routing_status == "LIKELY_MATCH"
        case_id = case.id
    detail = client.get("/api/v1/cases/" + case_id, headers=a).json()
    assert detail["ingestion_id"] == response.json()["id"]
    assert client.get("/api/v1/cases/" + case_id, headers=b).status_code == 404
    assert client.get("/api/v1/cases", headers=b).json() == []


@pytest.mark.parametrize(
    "field", ["workspace_id", "user_id", "role", "score", "decision", "candidate_id"]
)
def test_reject_system_owned_fields(setup, field):
    client, _, a, _ = setup
    source = create(client, a, "INCOMING")
    payload = batch()
    payload["records"][0][field] = "attacker"
    response = post(client, source["api_key"], payload)
    assert response.status_code == 422 and "attacker" not in response.text
    assert post(client, source["api_key"], {**batch(), field: "attacker"}).status_code == 422


def test_batch_limits_and_required_idempotency(setup):
    client, _, a, _ = setup
    source = create(client, a)
    assert post(client, source["api_key"], {"records": []}).status_code == 422
    assert post(client, source["api_key"], {"records": batch()["records"] * 101}).status_code == 422
    assert post(client, source["api_key"], {"records": [{"full_name": "x"}]}).status_code == 422
    assert (
        client.post(
            "/api/v1/source-ingestions",
            headers={"Authorization": "Bearer " + source["api_key"]},
            json=batch(),
        ).status_code
        == 422
    )
    response = client.post(
        "/api/v1/source-ingestions",
        headers={"Authorization": "Bearer " + source["api_key"], "Idempotency-Key": "large"},
        content="x" * 256001,
    )
    assert response.status_code == 413


def test_atomic_batch_rollback(setup, monkeypatch):
    client, maker, a, _ = setup
    source = create(client, a, "INCOMING")
    records = batch()["records"]
    payload = {"records": records + [{**records[0], "external_record_id": "second"}]}
    response = post(client, source["api_key"], payload)
    import app.services.source_service as service

    original = service.persist_case_resolution
    calls = 0

    def fail(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("secret PII should not reach failure metadata")
        return original(*args, **kwargs)

    monkeypatch.setattr(service, "persist_case_resolution", fail)
    execute(maker, response.json())
    with maker() as db:
        assert db.query(Case).count() == 0
        job = db.get(Job, response.json()["job"]["id"])
        assert job.status == "FAILED" and job.rejected_rows == 2
        assert "secret" not in job.failure_message


def test_reference_population_is_scoped_and_csv_uses_same_provider(setup, monkeypatch):
    client, maker, a, b = setup
    reference = create(client, a)
    execute(maker, post(client, reference["api_key"]).json())
    incoming = create(client, b, "INCOMING")
    execute(maker, post(client, incoming["api_key"]).json())
    with maker() as db:
        case = db.scalar(select(Case).where(Case.workspace_id == b["X-Workspace-ID"]))
        assert case is not None and case.candidates == []
    from app.api import ingest

    monkeypatch.setattr(
        ingest.ingest_csv_job, "delay", lambda *_: type("R", (), {"id": str(uuid.uuid4())})()
    )
    response = client.post(
        "/api/v1/ingest/csv",
        headers=a,
        files={
            "file": (
                "incoming.csv",
                "case_number,full_name,old_email\nCSV-SOURCE,Alex Example,alex@example.test\n",
            )
        },
    )
    tasks.ingest_csv_job.run(response.json()["id"], a["X-Workspace-ID"])
    with maker() as db:
        case = db.scalar(select(Case).where(Case.case_number == "CSV-SOURCE"))
        assert case is not None and case.candidates[0].provider_source == "WORKSPACE_REFERENCE"
        assert case.ingestion_id is None
