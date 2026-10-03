"""Bootstrap transaction/disconnect tests on an isolated real PostgreSQL schema."""

import json
import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from psycopg import OperationalError as DriverConnectionError
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core import auth
from app.core.database import Base, get_db
from app.main import app
from app.models.workspace import User, Workspace, WorkspaceMembership

pytestmark = pytest.mark.skipif(
    not os.environ.get("BOOTSTRAP_TEST_DATABASE_URL"), reason="requires disposable PostgreSQL"
)


@pytest.fixture
def pg(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[tuple[Engine, sessionmaker[Session], TestClient]]:
    url = make_url(os.environ["BOOTSTRAP_TEST_DATABASE_URL"])
    assert url.host in {"localhost", "127.0.0.1", "postgres"}, "disposable local database only"
    schema = "bootstrap_" + uuid4().hex
    admin = create_engine(url, poolclass=NullPool)
    with admin.begin() as db:
        db.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(
        url, connect_args={"options": f"-c search_path={schema}"}, pool_pre_ping=True
    )
    tables = [
        Base.metadata.tables[name] for name in ("users", "workspaces", "workspace_memberships")
    ]
    Base.metadata.create_all(engine, tables=tables)
    sessions = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    previous = app.dependency_overrides.copy()

    def database() -> Iterator[Session]:
        with sessions() as db:
            yield db

    monkeypatch.setattr(
        auth, "verify_firebase_id_token", lambda token: auth.FirebaseIdentity(token, None, True)
    )
    app.dependency_overrides.clear()
    app.dependency_overrides[get_db] = database
    try:
        with TestClient(app) as client:
            yield engine, sessions, client
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        engine.dispose()
        with admin.begin() as db:
            db.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def call(client: TestClient, uid: str = "new-user") -> Any:
    return client.post("/api/v1/auth/bootstrap", headers={"Authorization": "Bearer " + uid})


def counts(sessions: sessionmaker[Session]) -> tuple[int, ...]:
    with sessions() as db:
        return tuple(
            db.scalar(select(func.count()).select_from(model)) or 0
            for model in (User, Workspace, WorkspaceMembership)
        )


def terminate(engine: Engine, pid: int) -> None:
    admin = create_engine(engine.url, poolclass=NullPool)
    try:
        with admin.connect() as db:
            assert db.scalar(text("select pg_terminate_backend(:pid)"), {"pid": pid})
    finally:
        admin.dispose()


def test_dead_idle_connection(pg: tuple[Engine, sessionmaker[Session], TestClient]) -> None:
    engine, sessions, client = pg
    # Use the production engine's setting, so this regression fails before the fix.
    from app.core.database import engine as production_engine

    engine.pool._pre_ping = production_engine.pool._pre_ping
    with engine.connect() as db:
        pid = db.scalar(text("select pg_backend_pid()"))
    terminate(engine, pid)
    assert call(client).status_code == 200
    assert counts(sessions) == (1, 1, 1)


@pytest.mark.parametrize("phase", ["user", "workspace", "membership", "commit"])
def test_disconnect_during_transaction(
    pg: tuple[Engine, sessionmaker[Session], TestClient], phase: str
) -> None:
    engine, sessions, client = pg
    fired = False

    def kill_after_statement(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        nonlocal fired
        prefix = {
            "user": "INSERT INTO users",
            "workspace": "INSERT INTO workspaces",
            "membership": "INSERT INTO workspace_memberships",
        }.get(phase)
        if not fired and prefix and statement.startswith(prefix):
            fired = True
            driver = conn.connection.driver_connection
            assert driver is not None
            terminate(engine, driver.info.backend_pid)

    def kill_before_commit(db: Session) -> None:
        nonlocal fired
        if phase == "commit" and not fired and not db.in_nested_transaction():
            fired = True
            driver = db.connection().connection.driver_connection
            assert driver is not None
            terminate(engine, driver.info.backend_pid)

    event.listen(engine, "after_cursor_execute", kill_after_statement)
    event.listen(sessions, "before_commit", kill_before_commit)
    try:
        response = call(client)
        assert fired
        assert response.status_code == 200
        assert call(client).json() == response.json()
        assert counts(sessions) == (1, 1, 1)
    finally:
        event.remove(engine, "after_cursor_execute", kill_after_statement)
        event.remove(sessions, "before_commit", kill_before_commit)


def test_concurrent_new_uid_unique_conflict(
    pg: tuple[Engine, sessionmaker[Session], TestClient], caplog: pytest.LogCaptureFixture
) -> None:
    engine, sessions, client = pg
    barrier = Barrier(2)
    observations = 0
    conflicts: list[str | None] = []

    def both_observe_absence(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        nonlocal observations
        if "users.firebase_uid =" in statement and "FOR UPDATE" in statement and observations < 2:
            observations += 1
            barrier.wait(timeout=10)

    def capture_conflict(ctx: Any) -> None:
        conflicts.append(getattr(ctx.original_exception, "sqlstate", None))

    event.listen(engine, "after_cursor_execute", both_observe_absence)
    event.listen(engine, "handle_error", capture_conflict)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: call(client), range(2)))
        assert [r.status_code for r in responses] == [200, 200]
        assert responses[0].json() == responses[1].json()
        assert conflicts == ["23505"]
        assert counts(sessions) == (1, 1, 1)
    finally:
        event.remove(engine, "after_cursor_execute", both_observe_absence)
        event.remove(engine, "handle_error", capture_conflict)


def test_existing_user_without_membership_is_serialized(
    pg: tuple[Engine, sessionmaker[Session], TestClient],
) -> None:
    engine, sessions, client = pg
    with sessions.begin() as db:
        db.add(User(firebase_uid="new-user", is_anonymous=True))
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: call(client), range(2)))
    assert all(r.status_code == 200 for r in responses)
    assert responses[0].json() == responses[1].json()
    assert counts(sessions) == (1, 1, 1)


def test_bounded_repetition_and_tenant_isolation(
    pg: tuple[Engine, sessionmaker[Session], TestClient], record_property: Any
) -> None:
    engine, sessions, client = pg
    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(pool.map(lambda i: call(client, "uid-" + str(i % 3)), range(60)))
    statuses = [r.status_code for r in responses]
    record_property(
        "reliability_counts",
        json.dumps(
            {
                "requests": 60,
                "success": statuses.count(200),
                "retryable": statuses.count(503),
                "500": statuses.count(500),
            }
        ),
    )
    assert statuses == [200] * 60
    for uid in range(3):
        assert (
            len({json.dumps(responses[i].json(), sort_keys=True) for i in range(uid, 60, 3)}) == 1
        )
    assert len({r.json()["workspaces"][0]["id"] for r in responses}) == 3
    assert counts(sessions) == (3, 3, 3)
    # Arbitrary client workspace authority is ignored by bootstrap.
    forged = client.post(
        "/api/v1/auth/bootstrap",
        headers={
            "Authorization": "Bearer uid-0",
            "X-Workspace-ID": responses[1].json()["workspaces"][0]["id"],
        },
        json={"workspace_id": responses[1].json()["workspaces"][0]["id"]},
    )
    assert forged.json() == responses[0].json()


def test_permanent_integrity_error_rolls_back_without_retry(
    pg: tuple[Engine, sessionmaker[Session], TestClient],
) -> None:
    engine, sessions, client = pg
    with engine.begin() as db:
        db.execute(
            text("ALTER TABLE workspace_memberships ADD CONSTRAINT fail_membership CHECK (false)")
        )
    assert call(client).status_code == 500
    assert counts(sessions) == (0, 0, 0)
    with engine.begin() as db:
        db.execute(text("ALTER TABLE workspace_memberships DROP CONSTRAINT fail_membership"))
    assert call(client).status_code == 200
    assert counts(sessions) == (1, 1, 1)


@pytest.mark.parametrize("persistent", [False, True])
def test_connection_error_before_transaction(
    pg: tuple[Engine, sessionmaker[Session], TestClient], persistent: bool
) -> None:
    engine, sessions, client = pg
    engine.dispose()
    attempts = 0

    def fail_connect(*args: Any) -> None:
        nonlocal attempts
        attempts += 1
        if persistent or attempts == 1:
            raise DriverConnectionError("synthetic unavailable connection")

    event.listen(engine, "do_connect", fail_connect)
    try:
        response = call(client)
        assert attempts == 2
        assert response.status_code == (503 if persistent else 200)
        assert "X-Request-ID" in response.headers
        if persistent:
            assert response.headers["Retry-After"] == "1"
            assert response.json() == {
                "detail": "The workspace could not be initialized. Please retry."
            }
    finally:
        event.remove(engine, "do_connect", fail_connect)
    assert counts(sessions) == ((0, 0, 0) if persistent else (1, 1, 1))
    assert call(client).status_code == 200
    assert counts(sessions) == (1, 1, 1)


def test_ambiguous_commit_reconciles_existing_state(
    pg: tuple[Engine, sessionmaker[Session], TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    engine, sessions, client = pg
    original = engine.dialect.do_commit
    commits = 0

    def commit_then_lose_acknowledgement(connection: Any) -> None:
        nonlocal commits
        original(connection)
        commits += 1
        if commits == 1:
            raise DriverConnectionError("synthetic lost commit acknowledgement")

    monkeypatch.setattr(engine.dialect, "do_commit", commit_then_lose_acknowledgement)
    response = call(client)
    assert response.status_code == 200
    assert commits == 2
    assert counts(sessions) == (1, 1, 1)
    assert call(client).json() == response.json()


def test_rollback_connection_failure_discards_session_state(
    pg: tuple[Engine, sessionmaker[Session], TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    engine, sessions, client = pg
    original_rollback = Session.rollback
    original_flush = Session.flush
    failed = False
    rollback_failed = False

    def fail_flush(db: Session, *args: Any, **kwargs: Any) -> None:
        nonlocal failed
        if not failed and any(isinstance(obj, Workspace) for obj in db.new):
            failed = True
            raise OperationalError(
                None,
                None,
                DriverConnectionError("synthetic disconnect"),
                connection_invalidated=True,
            )
        original_flush(db, *args, **kwargs)

    def fail_rollback(db: Session) -> None:
        nonlocal rollback_failed
        original_rollback(db)
        if failed and not rollback_failed:
            rollback_failed = True
            raise OperationalError(
                None,
                None,
                DriverConnectionError("synthetic rollback failure"),
                connection_invalidated=True,
            )

    monkeypatch.setattr(Session, "flush", fail_flush)
    monkeypatch.setattr(Session, "rollback", fail_rollback)
    response = call(client)
    assert failed and rollback_failed
    assert response.status_code == 200
    assert counts(sessions) == (1, 1, 1)
    assert call(client).json() == response.json()


def test_multiple_authorized_workspaces_are_preserved(
    pg: tuple[Engine, sessionmaker[Session], TestClient],
) -> None:
    _, sessions, client = pg
    first = call(client).json()
    with sessions.begin() as db:
        workspace = Workspace(name="Second authorized workspace")
        db.add(workspace)
        db.flush()
        db.add(
            WorkspaceMembership(
                user_id=first["user"]["id"], workspace_id=workspace.id, role="MEMBER"
            )
        )
    second = call(client)
    assert second.status_code == 200
    assert len(second.json()["workspaces"]) == 2
    assert call(client).json() == second.json()
    assert counts(sessions) == (1, 2, 2)
