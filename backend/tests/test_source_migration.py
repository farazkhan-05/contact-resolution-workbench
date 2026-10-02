import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url


@pytest.mark.parametrize("database", ["sqlite", "postgres"])
def test_e4_preserves_manual_case_through_upgrade_downgrade_reupgrade(
    tmp_path: Path, database: str
) -> None:
    url = f"sqlite:///{(tmp_path / 'sources.db').as_posix()}"
    if database == "postgres":
        url = os.environ.get("E4_MIGRATION_TEST_URL", "")
        if not url:
            pytest.skip("requires disposable local PostgreSQL e4_migrations database")
        parsed = make_url(url)
        assert parsed.host in {"localhost", "127.0.0.1"} and parsed.database == "e4_migrations"

    def migrate(target: str, direction: str = "upgrade") -> None:
        result = subprocess.run(
            [sys.executable, "-m", "alembic", direction, target],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "DATABASE_URL": url},
            capture_output=True,
            timeout=30,
            text=True,
        )
        assert result.returncode == 0, result.stderr

    migrate("d1e2f3a4b5c6")
    engine = create_engine(url)
    workspace, case_id = str(uuid.uuid4()), str(uuid.uuid4())
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO workspaces (id, name, created_at, updated_at) "
                "VALUES (:id, 'Legacy workspace', :date, :date)"
            ),
            {"id": workspace, "date": datetime.now(UTC)},
        )
        connection.execute(
            text(
                "INSERT INTO cases (id, workspace_id, case_number, raw_name, "
                "normalized_name, routing_status, review_decision, created_at) "
                "VALUES (:id, :workspace, 'CSV-LEGACY', 'Legacy Case', 'legacy case', "
                "'NEEDS_REVIEW', 'PENDING', :date)"
            ),
            {"id": case_id, "workspace": workspace, "date": datetime.now(UTC)},
        )
    for target, direction in [
        ("head", "upgrade"),
        ("d1e2f3a4b5c6", "downgrade"),
        ("head", "upgrade"),
    ]:
        migrate(target, direction)
        with engine.connect() as connection:
            assert (
                connection.scalar(text("SELECT raw_name FROM cases WHERE id=:id"), {"id": case_id})
                == "Legacy Case"
            )
        assert ("sources" in inspect(engine).get_table_names()) == (direction == "upgrade")
    engine.dispose()
