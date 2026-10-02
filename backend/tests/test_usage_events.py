from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.constants import UsageEventType
from app.core.database import Base, get_db
from app.main import app
from app.models.audit import AuditLog
from app.models.case import Case
from app.models.usage import UsageEvent
from app.models.workspace import Workspace
from app.services.case_service import ingest_sample_cases


@pytest.fixture
def test_setup() -> Generator[tuple[TestClient, sessionmaker[Session]]]:
    test_engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=test_engine)
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

    def override_get_db() -> Generator[Session]:
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    try:
        yield client, TestingSession
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(bind=test_engine)


def test_valid_app_opened_event_persists(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, TestingSession = test_setup
    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "APP_OPENED",
            "anonymous_session_id": "sess-12345-abcde",
        },
    )
    assert res.status_code == 204

    with TestingSession() as session:
        events = session.scalars(select(UsageEvent)).all()
        assert len(events) == 1
        assert events[0].event_name == "APP_OPENED"
        assert events[0].anonymous_session_id == "sess-12345-abcde"
        assert events[0].ref_code is None
        assert events[0].case_number is None
        assert events[0].created_at is not None


def test_valid_case_viewed_event_persists_with_case_number(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, TestingSession = test_setup
    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "CASE_VIEWED",
            "anonymous_session_id": "sess-67890",
            "case_number": "CASE-1005",
        },
    )
    assert res.status_code == 204

    with TestingSession() as session:
        events = session.scalars(select(UsageEvent)).all()
        assert len(events) == 1
        assert events[0].event_name == "CASE_VIEWED"
        assert events[0].case_number == "CASE-1005"


def test_valid_ref_code_persists(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, TestingSession = test_setup
    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "APP_OPENED",
            "anonymous_session_id": "sess-ref-test",
            "ref_code": "interview-demo_2026",
        },
    )
    assert res.status_code == 204

    with TestingSession() as session:
        event = session.scalar(
            select(UsageEvent).where(UsageEvent.anonymous_session_id == "sess-ref-test")
        )
        assert event is not None
        assert event.ref_code == "interview-demo_2026"


def test_all_allowlisted_event_types_succeed(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, TestingSession = test_setup
    for event_type in UsageEventType:
        res = client.post(
            "/api/v1/usage-events",
            json={
                "event_name": event_type.value,
                "anonymous_session_id": f"sess-{event_type.value.lower()}",
            },
        )
        assert res.status_code == 204

    with TestingSession() as session:
        count = len(session.scalars(select(UsageEvent)).all())
        assert count == len(UsageEventType)


def test_invalid_event_name_rejected(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = test_setup
    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "INVALID_EVENT_CLICK",
            "anonymous_session_id": "sess-12345",
        },
    )
    assert res.status_code == 422


def test_overlong_anonymous_session_id_rejected(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = test_setup
    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "APP_OPENED",
            "anonymous_session_id": "a" * 65,
        },
    )
    assert res.status_code == 422


def test_invalid_session_id_characters_rejected(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = test_setup
    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "APP_OPENED",
            "anonymous_session_id": "sess<script>alert(1)</script>",
        },
    )
    assert res.status_code == 422


def test_invalid_ref_code_rejected(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = test_setup
    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "APP_OPENED",
            "anonymous_session_id": "sess-valid",
            "ref_code": "ref with spaces and !@#$",
        },
    )
    assert res.status_code == 422


def test_overlong_ref_code_rejected(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = test_setup
    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "APP_OPENED",
            "anonymous_session_id": "sess-valid",
            "ref_code": "r" * 65,
        },
    )
    assert res.status_code == 422


def test_arbitrary_metadata_rejected(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = test_setup
    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "APP_OPENED",
            "anonymous_session_id": "sess-valid",
            "arbitrary_field": "injected_data",
            "ip_address": "127.0.0.1",
        },
    )
    assert res.status_code == 422


def test_usage_event_creation_does_not_mutate_case_or_audit_tables(
    test_setup: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, TestingSession = test_setup
    with TestingSession() as session:
        workspace = Workspace(name="Usage test workspace")
        session.add(workspace)
        session.flush()
        ingest_sample_cases(session, workspace.id)
        case_count_before = len(session.scalars(select(Case)).all())
        audit_count_before = len(session.scalars(select(AuditLog)).all())

    res = client.post(
        "/api/v1/usage-events",
        json={
            "event_name": "DECISION_SUBMITTED",
            "anonymous_session_id": "sess-test",
            "case_number": "CASE-1001",
        },
    )
    assert res.status_code == 204

    with TestingSession() as session:
        case_count_after = len(session.scalars(select(Case)).all())
        audit_count_after = len(session.scalars(select(AuditLog)).all())
        assert case_count_after == case_count_before
        assert audit_count_after == audit_count_before
