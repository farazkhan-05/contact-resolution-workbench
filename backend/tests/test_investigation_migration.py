import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.models.case import Case
from app.models.workspace import Workspace
from app.schemas.resolution import CaseQuery


@pytest.mark.parametrize("database", ["sqlite", "postgres"])
def test_application_migration_preserves_existing_case_and_downgrades(
    tmp_path: Path, database: str
) -> None:
    if database == "postgres":
        url = os.environ.get("D1_MIGRATION_TEST_URL")
        if not url:
            pytest.skip("requires a separate disposable PostgreSQL migration database")
        parsed = make_url(url)
        assert parsed.host in {"localhost", "127.0.0.1"}
        assert parsed.database == "d1_migrations"
    else:
        url = f"sqlite:///{(tmp_path / 'migration.db').as_posix()}"
    environment = {**os.environ, "DATABASE_URL": url}

    def migrate(target: str, command: str = "upgrade") -> None:
        result = subprocess.run(
            [sys.executable, "-m", "alembic", command, target],
            cwd=Path(__file__).resolve().parents[1],
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0, result.stderr

    migrate("c2d3e4f5a6b7")
    engine = create_engine(url.replace("postgresql://", "postgresql+psycopg://", 1))
    with Session(engine) as db:
        workspace = Workspace(name="Migration preservation")
        db.add(workspace)
        db.flush()
        query = CaseQuery(name="Existing Synthetic Case")
        case_id = str(uuid.uuid4())
        db.execute(
            text(
                "INSERT INTO cases (id, workspace_id, case_number, raw_name, "
                "normalized_name, routing_status, review_decision, created_at) "
                "VALUES (:id, :workspace, 'LEGACY-D1', :name, :name, "
                "'INSUFFICIENT_EVIDENCE', 'PENDING', :created)"
            ),
            {
                "id": case_id,
                "workspace": workspace.id,
                "name": query.name,
                "created": datetime.now(UTC),
            },
        )
        db.commit()
    migrate("head")
    assert "investigation_runs" in inspect(engine).get_table_names()
    with Session(engine) as db:
        assert db.scalar(select(Case.raw_name).where(Case.id == case_id)) == query.name
    migrate("c2d3e4f5a6b7", "downgrade")
    assert "investigation_runs" not in inspect(engine).get_table_names()
    with Session(engine) as db:
        assert db.scalar(select(Case.raw_name).where(Case.id == case_id)) == query.name
    migrate("head")
    engine.dispose()
