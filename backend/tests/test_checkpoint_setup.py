import os
import subprocess
import sys
import uuid
from pathlib import Path
from unittest.mock import Mock

import psycopg
import pytest
from langgraph.checkpoint.postgres import PostgresSaver
from psycopg import sql
from sqlalchemy.engine import make_url

from app import migrate

TABLES = {"checkpoints", "checkpoint_blobs", "checkpoint_writes", "checkpoint_migrations"}


def test_migration_orders_application_before_checkpoint_setup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(migrate.command, "upgrade", lambda *_: calls.append("alembic"))
    monkeypatch.setattr(migrate, "setup_checkpoints", lambda: calls.append("checkpoints"))
    migrate.migrate()
    assert calls == ["alembic", "checkpoints"]


@pytest.mark.parametrize("stage", ["alembic", "checkpoints"])
def test_initialization_failure_exits_without_leaking_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], stage: str
) -> None:
    upgrade, setup = Mock(), Mock()
    (upgrade if stage == "alembic" else setup).side_effect = RuntimeError("private-db-credential")
    monkeypatch.setattr(migrate.command, "upgrade", upgrade)
    monkeypatch.setattr(migrate, "setup_checkpoints", setup)
    with pytest.raises(SystemExit) as error:
        migrate.main()
    assert error.value.code == 1
    assert "Schema initialization failed: RuntimeError" in capsys.readouterr().err
    if stage == "alembic":
        setup.assert_not_called()


def test_postgres_empty_database_idempotency_and_unavailable_schema() -> None:
    admin_url = os.environ.get("CHECKPOINT_SETUP_TEST_URL")
    if not admin_url:
        pytest.skip("requires explicitly configured disposable PostgreSQL")
    parsed = make_url(admin_url)
    assert parsed.host in {"localhost", "127.0.0.1"}
    database = "checkpoint_setup_" + uuid.uuid4().hex
    url = parsed.set(database=database).render_as_string(hide_password=False)
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    try:
        with PostgresSaver.from_conn_string(url) as saver:
            with pytest.raises(psycopg.errors.UndefinedTable) as missing:
                saver.get_tuple({"configurable": {"thread_id": "synthetic"}})
            assert missing.value.sqlstate == "42P01"

        def initialize() -> None:
            result = subprocess.run(
                [sys.executable, "-m", "app.migrate"],
                cwd=Path(__file__).resolve().parents[1],
                env={**os.environ, "DATABASE_URL": url},
                capture_output=True,
                text=True,
                timeout=60,
            )
            assert result.returncode == 0

        initialize()
        with psycopg.connect(url, autocommit=True) as conn:
            objects = {
                r[0]
                for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'")
            }
            assert TABLES <= objects
            conn.execute(
                "INSERT INTO workspaces (id,name,created_at,updated_at) "
                "VALUES ('synthetic-marker','Preserved',now(),now())"
            )
            before = conn.execute("SELECT v FROM checkpoint_migrations ORDER BY v").fetchall()
            assert before == [(v,) for v in range(len(PostgresSaver.MIGRATIONS))]
        initialize()  # Different process, same database, package migrations not repeated.
        with psycopg.connect(url) as conn:
            assert conn.execute(
                "SELECT name FROM workspaces WHERE id='synthetic-marker'"
            ).fetchone() == ("Preserved",)
            assert (
                conn.execute("SELECT v FROM checkpoint_migrations ORDER BY v").fetchall() == before
            )
            indexes = {
                r[0]
                for r in conn.execute("SELECT indexname FROM pg_indexes WHERE schemaname='public'")
            }
            assert {
                "checkpoints_thread_id_idx",
                "checkpoint_blobs_thread_id_idx",
                "checkpoint_writes_thread_id_idx",
            } <= indexes
        with PostgresSaver.from_conn_string(url) as saver:
            assert saver.get_tuple({"configurable": {"thread_id": "synthetic"}}) is None
    finally:
        # Only this test's UUID database on explicitly allowlisted localhost is removed.
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))
