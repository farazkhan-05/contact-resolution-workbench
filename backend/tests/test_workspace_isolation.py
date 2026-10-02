import json
import logging
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import auth
from app.core.bootstrap_diagnostics import BootstrapDiagnostics
from app.core.database import Base, get_db
from app.main import app
from app.models.workspace import User, Workspace, WorkspaceMembership


@pytest.fixture
def isolated_client(
    monkeypatch: pytest.MonkeyPatch,
) -> Generator[tuple[TestClient, sessionmaker[Session]]]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False, "autocommit": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, expire_on_commit=False)
    identities = {
        "user-a": auth.FirebaseIdentity("firebase-a", "a@example.demo", False),
        "user-b": auth.FirebaseIdentity("firebase-b", "b@example.demo", False),
        "anonymous-a": auth.FirebaseIdentity("anonymous-a", None, True),
        "anonymous-b": auth.FirebaseIdentity("anonymous-b", None, True),
    }

    def verify(token: str) -> auth.FirebaseIdentity:
        if token not in identities:
            raise auth._unauthorized()
        return identities[token]

    def override_get_db() -> Generator[Session]:
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setattr(auth, "verify_firebase_id_token", verify)
    app.dependency_overrides.clear()
    app.dependency_overrides[get_db] = override_get_db
    try:
        yield TestClient(app), testing_session
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)


def bootstrap(client: TestClient, token: str) -> str:
    response = client.post("/api/v1/auth/bootstrap", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    return response.json()["workspaces"][0]["id"]


def headers(token: str, workspace_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "X-Workspace-ID": workspace_id}


def test_authentication_bootstrap_and_workspace_isolation(
    isolated_client: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, testing_session = isolated_client
    assert client.get("/api/v1/cases").status_code == 401
    assert client.get("/api/v1/cases", headers={"Authorization": "Bearer bad"}).status_code == 401

    workspace_a = bootstrap(client, "user-a")
    assert bootstrap(client, "user-a") == workspace_a
    workspace_b = bootstrap(client, "user-b")
    assert workspace_a != workspace_b

    with testing_session() as db:
        assert len(db.scalars(select(User)).all()) == 2
        assert len(db.scalars(select(WorkspaceMembership)).all()) == 2

    assert client.get("/api/v1/cases", headers=headers("user-a", workspace_b)).status_code == 403
    sample_a = client.post("/api/v1/ingest/sample", headers=headers("user-a", workspace_a))
    assert sample_a.status_code == 200
    assert sample_a.json()["created_count"] == 8
    assert (
        client.post("/api/v1/ingest/sample", headers=headers("user-a", workspace_a)).json()[
            "existing_count"
        ]
        == 8
    )
    sample_b = client.post("/api/v1/ingest/sample", headers=headers("user-b", workspace_b))
    assert sample_b.json()["created_count"] == 8

    queue_a = client.get("/api/v1/cases", headers=headers("user-a", workspace_a)).json()
    queue_b = client.get("/api/v1/cases", headers=headers("user-b", workspace_b)).json()
    assert len(queue_a) == len(queue_b) == 8
    case_a = queue_a[0]["id"]
    case_b = queue_b[0]["id"]
    assert (
        client.get(f"/api/v1/cases/{case_a}", headers=headers("user-b", workspace_b)).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/cases/{case_a}/decision",
            headers=headers("user-b", workspace_b),
            json={"decision": "REJECTED"},
        ).status_code
        == 404
    )

    candidate_b = client.get(
        f"/api/v1/cases/{case_b}", headers=headers("user-b", workspace_b)
    ).json()["candidates"][0]["id"]
    assert (
        client.post(
            f"/api/v1/cases/{case_a}/decision",
            headers=headers("user-a", workspace_a),
            json={"decision": "ACCEPTED", "selected_candidate_id": candidate_b},
        ).status_code
        == 422
    )

    arthur = next(case for case in queue_a if case["case_number"] == "CASE-1005")
    arthur_detail = client.get(
        f"/api/v1/cases/{arthur['id']}", headers=headers("user-a", workspace_a)
    ).json()
    assert arthur_detail["candidates"][0]["has_serious_contradiction"] is True


def test_workspace_scoped_csv_and_export(
    isolated_client: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = isolated_client
    workspace_a = bootstrap(client, "user-a")
    workspace_b = bootstrap(client, "user-b")
    content = "case_number,full_name\nCASE-SHARED,Jamie Example\n"
    upload_a = client.post(
        "/api/v1/ingest/csv",
        headers=headers("user-a", workspace_a),
        files={"file": ("a.csv", content, "text/csv")},
    )
    assert upload_a.status_code == 202
    assert (
        client.post(
            "/api/v1/ingest/csv",
            headers=headers("user-b", workspace_b),
            files={"file": ("b.csv", content, "text/csv")},
        ).status_code
        == 202
    )
    job_a = upload_a.json()["id"]
    assert (
        client.get(f"/api/v1/jobs/{job_a}", headers=headers("user-b", workspace_b)).status_code
        == 404
    )

    assert (
        client.post("/api/v1/ingest/sample", headers=headers("user-a", workspace_a)).status_code
        == 200
    )
    case_a = client.get("/api/v1/cases", headers=headers("user-a", workspace_a)).json()[0]
    candidate_a = client.get(
        f"/api/v1/cases/{case_a['id']}", headers=headers("user-a", workspace_a)
    ).json()["candidates"][0]["id"]
    assert (
        client.post(
            f"/api/v1/cases/{case_a['id']}/decision",
            headers=headers("user-a", workspace_a),
            json={"decision": "ACCEPTED", "selected_candidate_id": candidate_a},
        ).status_code
        == 200
    )
    assert (
        case_a["case_number"]
        in client.get("/api/v1/export/csv", headers=headers("user-a", workspace_a)).text
    )
    export_b = client.get("/api/v1/export/csv", headers=headers("user-b", workspace_b)).text
    assert case_a["case_number"] not in export_b


def test_anonymous_accounts_receive_distinct_demo_workspaces(
    isolated_client: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = isolated_client
    workspace_a = bootstrap(client, "anonymous-a")
    workspace_b = bootstrap(client, "anonymous-b")
    assert workspace_a != workspace_b
    assert (
        client.post(
            "/api/v1/ingest/sample", headers=headers("anonymous-a", workspace_a)
        ).status_code
        == 200
    )
    assert client.get("/api/v1/cases", headers=headers("anonymous-b", workspace_b)).json() == []


def diagnostic_records(caplog: pytest.LogCaptureFixture) -> list[dict[str, object]]:
    return [
        json.loads(record.message)
        for record in caplog.records
        if record.name == "uvicorn.error.bootstrap"
    ]


def test_bootstrap_reuses_existing_records_and_emits_safe_phases(
    isolated_client: tuple[TestClient, sessionmaker[Session]], caplog: pytest.LogCaptureFixture
) -> None:
    client, testing_session = isolated_client
    caplog.set_level(logging.INFO, logger="uvicorn.error.bootstrap")
    first = client.post("/api/v1/auth/bootstrap", headers={"Authorization": "Bearer user-a"})
    second = client.post("/api/v1/auth/bootstrap", headers={"Authorization": "Bearer user-a"})
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    with testing_session() as db:
        assert len(db.scalars(select(User)).all()) == 1
        assert len(db.scalars(select(Workspace)).all()) == 1
        assert len(db.scalars(select(WorkspaceMembership)).all()) == 1
    records = diagnostic_records(caplog)
    assert len({record["request_id"] for record in records}) == 2
    phases = {record["phase"] for record in records if record["event"] == "bootstrap.phase"}
    assert phases == {
        "verified_token",
        "application_user",
        "membership_lookup",
        "workspace_create",
        "membership_create",
        "workspace_lookup",
        "transaction_commit",
    }
    assert all(record["outcome"] == "success" for record in records if "outcome" in record)
    assert all(isinstance(record["total_duration_ms"], (int, float)) for record in records)
    assert not any(
        value in caplog.text
        for value in (
            "a@example.demo",
            "firebase-a",
            "Bearer",
            "Authorization",
            "password",
            "user-a",
        )
    )


@pytest.mark.parametrize(
    "failure_phase", ["workspace_create", "membership_create", "transaction_commit"]
)
def test_bootstrap_failure_rolls_back_and_emits_safe_error_then_retry_succeeds(
    isolated_client: tuple[TestClient, sessionmaker[Session]],
    caplog: pytest.LogCaptureFixture,
    failure_phase: str,
) -> None:
    client, testing_session = isolated_client
    caplog.set_level(logging.INFO, logger="uvicorn.error.bootstrap")
    rolled_back = []

    def inject_flush(db: Session, *_: object) -> None:
        target = Workspace if failure_phase == "workspace_create" else WorkspaceMembership
        if any(isinstance(value, target) for value in db.new):
            raise RuntimeError(
                "email=a@example.demo token=Bearer-secret password=secret "
                "Authorization=secret database=secret"
            )

    def inject_commit(db: Session) -> None:
        if not db.in_nested_transaction():
            raise RuntimeError("database credentials and SQL personal values")

    def rollback_seen(db: Session) -> None:
        rolled_back.append(True)

    listener = inject_commit if failure_phase == "transaction_commit" else inject_flush
    event_name = "before_commit" if failure_phase == "transaction_commit" else "before_flush"
    event.listen(testing_session, event_name, listener)
    event.listen(testing_session, "after_rollback", rollback_seen)
    try:
        response = client.post("/api/v1/auth/bootstrap", headers={"Authorization": "Bearer user-a"})
    finally:
        event.remove(testing_session, event_name, listener)
        event.remove(testing_session, "after_rollback", rollback_seen)
    assert response.status_code == 500
    assert response.json() == {"detail": "The workspace could not be initialized. Please retry."}
    assert rolled_back
    with testing_session() as db:
        assert db.scalars(select(User)).all() == []
        assert db.scalars(select(Workspace)).all() == []
        assert db.scalars(select(WorkspaceMembership)).all() == []
    records = diagnostic_records(caplog)
    errors = [record for record in records if record["event"] == "bootstrap.error"]
    assert errors[0]["exception_class"] == "RuntimeError"
    assert errors[0]["phase"] == failure_phase
    assert errors[0]["exception_category"] == "server"
    assert "inject_" in str(errors[0]["code_locations"])
    assert any(
        record.get("phase") == "transaction_rollback" and record.get("outcome") == "success"
        for record in records
    )
    assert records[-1]["event"] == "bootstrap.completed"
    assert records[-1]["status_code"] == 500
    assert not any(
        value in caplog.text
        for value in (
            "a@example.demo",
            "Bearer-secret",
            "password=",
            "Authorization=",
            "credentials and SQL",
        )
    )
    bootstrap(client, "user-a")


def test_bootstrap_auth_failure_stays_401_with_token_phase_diagnostic(
    isolated_client: tuple[TestClient, sessionmaker[Session]], caplog: pytest.LogCaptureFixture
) -> None:
    client, _ = isolated_client
    caplog.set_level(logging.INFO, logger="uvicorn.error.bootstrap")
    assert client.post("/api/v1/auth/bootstrap").status_code == 401
    assert (
        client.post(
            "/api/v1/auth/bootstrap", headers={"Authorization": "Bearer secret-invalid-token"}
        ).status_code
        == 401
    )
    errors = [
        record for record in diagnostic_records(caplog) if record["event"] == "bootstrap.error"
    ]
    assert len(errors) == 2
    assert all(
        record["phase"] == "verified_token" and record["exception_class"] == "HTTPException"
        for record in errors
    )
    assert "secret-invalid-token" not in caplog.text


def test_database_exception_diagnostics_exclude_sql_parameters_and_driver_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="uvicorn.error.bootstrap")
    diagnostics = BootstrapDiagnostics()
    try:
        with diagnostics.phase("application_user"):
            raise OperationalError(
                "SELECT private_email FROM users WHERE email='private@example.invalid'",
                {"password": "private-password", "token": "private-token"},
                RuntimeError("database credentials Authorization: private-header"),
                connection_invalidated=True,
            )
    except OperationalError as exc:
        diagnostics.failure(exc)
    error = diagnostic_records(caplog)[-1]
    assert error["exception_class"] == "OperationalError"
    assert error["exception_category"] == "database"
    assert error["connection_invalidated"] is True
    assert error["phase"] == "application_user"
    assert "private" not in caplog.text
    assert "SELECT" not in caplog.text
