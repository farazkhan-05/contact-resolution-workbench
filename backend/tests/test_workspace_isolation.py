from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import auth
from app.core.database import Base, get_db
from app.main import app
from app.models.workspace import User, WorkspaceMembership


@pytest.fixture
def isolated_client(
    monkeypatch: pytest.MonkeyPatch,
) -> Generator[tuple[TestClient, sessionmaker[Session]]]:
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
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
    assert upload_a.status_code == 200
    assert (
        client.post(
            "/api/v1/ingest/csv",
            headers=headers("user-b", workspace_b),
            files={"file": ("b.csv", content, "text/csv")},
        ).status_code
        == 200
    )
    duplicate = client.post(
        "/api/v1/ingest/csv",
        headers=headers("user-a", workspace_a),
        files={"file": ("again.csv", content, "text/csv")},
    )
    assert duplicate.status_code == 422
    assert "already exists" in duplicate.json()["detail"]

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
