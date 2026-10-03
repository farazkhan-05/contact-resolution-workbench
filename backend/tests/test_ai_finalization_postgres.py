"""F06: real PostgreSQL transactions and independent durable result reads.

AI_TEST_DATABASE_URL must target the existing disposable localhost database.
Provider outputs are synthetic; persistence, COMMIT and disconnects are real.
"""

import json
import os
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import psycopg
import pytest
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app import tasks
from app.core.database import Base
from app.models.audit import AuditLog
from app.models.case import CandidateRecord, Case, Contradiction, MatchEvidence
from app.models.job import Job
from app.models.workspace import Workspace
from app.schemas.resolution import ExtractedCandidateProfile
from app.services.extractor import GeminiExtractionError, GeminiExtractor

pytestmark = pytest.mark.skipif(
    not os.environ.get("AI_TEST_DATABASE_URL"), reason="requires disposable PostgreSQL"
)

MODELS = (Case, CandidateRecord, MatchEvidence, Contradiction, AuditLog)


@pytest.fixture
def pg(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    url = make_url(os.environ["AI_TEST_DATABASE_URL"])
    assert url.host in {"localhost", "127.0.0.1", "postgres"}, "disposable database only"
    schema = "ai_finalization_" + uuid4().hex
    admin = create_engine(url, poolclass=NullPool)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    state: dict[str, Any] = {"fault": None, "fired": False, "provider_calls": 0, "connections": 0}

    class FaultConnection(psycopg.Connection[Any]):
        fault: str | None = None

        def commit(self) -> None:
            fault, self.fault = self.fault, None
            if fault == "disconnect_before_commit":
                # A real independent backend kills the in-flight transaction.
                with admin.begin() as conn:
                    assert conn.scalar(
                        text("SELECT pg_terminate_backend(:pid)"), {"pid": self.info.backend_pid}
                    )
            super().commit()  # Real PostgreSQL COMMIT, never a mocked Session.commit.
            if fault == "lost_ack":
                # Prove durability on another connection before simulating the lost ACK.
                with sessions() as db:
                    assert db.get(Job, state["job_id"]).status == "SUCCEEDED"
                    assert db.scalar(select(func.count()).select_from(Case)) == 1
                state["independent_commit_proof"] = True
                self.close()
                raise psycopg.OperationalError("synthetic lost commit acknowledgement")

    dsn = url.set(drivername="postgresql").render_as_string(hide_password=False)
    engine = create_engine(
        url,
        creator=lambda: FaultConnection.connect(dsn, options=f"-c search_path={schema}"),
        poolclass=NullPool,
    )
    Base.metadata.create_all(engine)

    def checkout(*args: Any) -> None:
        state["connections"] += 1

    def checkin(*args: Any) -> None:
        state["connections"] -= 1

    event.listen(engine, "checkout", checkout)
    event.listen(engine, "checkin", checkin)
    sessions = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    monkeypatch.setattr(tasks, "SessionLocal", sessions)
    with sessions() as db:
        workspace = Workspace(name="F06 synthetic transaction test")
        db.add(workspace)
        db.flush()
        job = Job(
            workspace_id=workspace.id,
            job_type="GEMINI_UNSTRUCTURED_INGEST",
            payload=json.dumps(
                {"raw_evidence_text": "synthetic F06", "case_number": "F06-SYNTHETIC"}
            ),
        )
        db.add(job)
        db.commit()
        state.update(job_id=job.id, workspace_id=workspace.id, engine=engine, sessions=sessions)

    def extract(*args: Any, **kwargs: Any) -> ExtractedCandidateProfile:
        state["provider_calls"] += 1
        # Claim must already be durable; no worker connection is held over the provider.
        assert state["connections"] == 0
        with sessions() as db:
            assert db.get(Job, job.id).status == "RUNNING"
            assert db.scalar(select(func.count()).select_from(Case)) == 0
        return ExtractedCandidateProfile(name="Claire Reynolds", employer="Harbor Analytics")

    monkeypatch.setattr(GeminiExtractor, "extract_from_unstructured_text", extract)

    def before_commit(db: Session) -> None:
        state["worker_commit_count"] = state.get("worker_commit_count", 0) + 1
        if state["fired"] or state["fault"] not in {"lost_ack", "disconnect_before_commit"}:
            return
        current = db.get(Job, job.id)
        if current and current.status == "SUCCEEDED":
            state["fired"] = True
            db.connection().connection.driver_connection.fault = state["fault"]

    event.listen(sessions, "before_commit", before_commit)
    try:
        yield state
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def run(pg: dict[str, Any]) -> None:
    tasks.ingest_unstructured_job.run(pg["job_id"], pg["workspace_id"])


def result(pg: dict[str, Any], status: str, cases: int) -> None:
    # NullPool guarantees an independent real connection, not the worker identity map.
    with pg["sessions"]() as db:
        job = db.get(Job, pg["job_id"])
        assert job.status == status
        counts = [db.scalar(select(func.count()).select_from(model)) for model in MODELS]
        assert counts[0] == cases
        if cases:
            assert job.successful_rows == job.processed_rows == job.total_rows == 1
            assert counts[1] > 0 and counts[2] > 0 and counts[4] == 2
        else:
            assert counts == [0] * len(MODELS)
            assert job.successful_rows == 0


def test_normal_success_and_duplicate_delivery(pg: dict[str, Any]) -> None:
    run(pg)
    result(pg, "SUCCEEDED", 1)
    run(pg)
    result(pg, "SUCCEEDED", 1)
    assert pg["provider_calls"] == 1
    assert pg["worker_commit_count"] == 2  # claim + atomic finalization; no third commit


@pytest.mark.parametrize(
    "code",
    [
        "PROVIDER_CONFIGURATION_ERROR",
        "PROVIDER_AUTH_ERROR",
        "RATE_LIMITED",
        "PROVIDER_TIMEOUT",
        "INVALID_EXTRACTION",
        "EXTRACTION_SCHEMA_INVALID",
        "EXTRACTION_MALFORMED_OUTPUT",
    ],
)
def test_provider_failure_and_failed_redelivery(
    pg: dict[str, Any], monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    def extract(*args: Any, **kwargs: Any) -> None:
        pg["provider_calls"] += 1
        raise GeminiExtractionError("synthetic", code=code)

    monkeypatch.setattr(GeminiExtractor, "extract_from_unstructured_text", extract)
    run(pg)
    result(pg, "FAILED", 0)
    run(pg)
    result(pg, "FAILED", 0)
    assert pg["provider_calls"] == 1
    with pg["sessions"]() as db:
        assert db.get(Job, pg["job_id"]).failure_code == code


@pytest.mark.parametrize("table", ["cases", "candidate_records", "match_evidence", "audit_logs"])
def test_database_persistence_failure_rolls_back_every_record(
    pg: dict[str, Any], table: str
) -> None:
    with pg["engine"].begin() as conn:
        conn.execute(
            text("""CREATE FUNCTION reject_write() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'synthetic F06 insert failure'; END;
            $$ LANGUAGE plpgsql""")
        )
        conn.execute(
            text(f"""CREATE TRIGGER reject_write BEFORE INSERT ON {table}
            FOR EACH ROW EXECUTE FUNCTION reject_write()""")
        )
    run(pg)
    result(pg, "FAILED", 0)


def test_after_case_flush_before_success_update(
    pg: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    original = tasks.persist_case_resolution

    def persist(*args: Any, **kwargs: Any) -> Case:
        original(*args, **kwargs)
        raise RuntimeError("synthetic after persistence flush")

    monkeypatch.setattr(tasks, "persist_case_resolution", persist)
    run(pg)
    result(pg, "FAILED", 0)


def test_job_success_update_failure(pg: dict[str, Any]) -> None:
    with pg["engine"].begin() as conn:
        conn.execute(
            text("""CREATE FUNCTION reject_success() RETURNS trigger AS $$
            BEGIN IF NEW.status = 'SUCCEEDED' THEN
            RAISE EXCEPTION 'synthetic F06 success failure'; END IF; RETURN NEW; END;
            $$ LANGUAGE plpgsql""")
        )
        conn.execute(
            text("""CREATE TRIGGER reject_success BEFORE UPDATE ON jobs
            FOR EACH ROW EXECUTE FUNCTION reject_success()""")
        )
    run(pg)
    result(pg, "FAILED", 0)


def test_final_flush_failure(pg: dict[str, Any]) -> None:
    def before_flush(db: Session, *args: Any) -> None:
        if any(isinstance(obj, Job) and obj.status == "SUCCEEDED" for obj in db.dirty):
            raise RuntimeError("synthetic flush failure")

    event.listen(pg["sessions"], "before_flush", before_flush)
    run(pg)
    result(pg, "FAILED", 0)


def test_actual_disconnect_before_commit(pg: dict[str, Any]) -> None:
    pg["fault"] = "disconnect_before_commit"
    run(pg)
    assert pg["fired"]
    result(pg, "FAILED", 0)


def test_postgres_rejects_commit_at_deferred_constraint(pg: dict[str, Any]) -> None:
    with pg["engine"].begin() as conn:
        conn.execute(
            text("""CREATE FUNCTION reject_commit() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'synthetic F06 commit failure'; END;
            $$ LANGUAGE plpgsql""")
        )
        conn.execute(
            text("""CREATE CONSTRAINT TRIGGER reject_commit AFTER INSERT ON audit_logs
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_commit()""")
        )
    run(pg)
    result(pg, "FAILED", 0)


def test_actual_postgres_commit_lost_ack_and_redelivery(pg: dict[str, Any]) -> None:
    pg["fault"] = "lost_ack"
    run(pg)
    assert pg["fired"] and pg["independent_commit_proof"]
    result(pg, "SUCCEEDED", 1)
    run(pg)
    result(pg, "SUCCEEDED", 1)
    assert pg["provider_calls"] == 1


def test_exception_immediately_after_commit(pg: dict[str, Any]) -> None:
    def after_commit(db: Session) -> None:
        if any(
            isinstance(obj, Job) and obj.status == "SUCCEEDED" for obj in db.identity_map.values()
        ):
            raise RuntimeError("synthetic after real commit")

    event.listen(pg["sessions"], "after_commit", after_commit)
    run(pg)
    result(pg, "SUCCEEDED", 1)
    run(pg)
    result(pg, "SUCCEEDED", 1)


def test_failure_handler_preserves_terminal_success(pg: dict[str, Any]) -> None:
    run(pg)
    assert (
        tasks._fail_unstructured_job(pg["job_id"], pg["workspace_id"], "WORKER_ERROR", "synthetic")
        == "SUCCEEDED"
    )
    result(pg, "SUCCEEDED", 1)


def test_success_assignment_failure(pg: dict[str, Any]) -> None:
    def reject_success(target: Job, value: str, *args: Any) -> None:
        if value == "SUCCEEDED":
            raise RuntimeError("synthetic success assignment failure")

    event.listen(Job.status, "set", reject_success)
    try:
        run(pg)
        result(pg, "FAILED", 0)
    finally:
        event.remove(Job.status, "set", reject_success)


def test_empty_extraction(pg: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        GeminiExtractor,
        "extract_from_unstructured_text",
        lambda *a, **kw: ExtractedCandidateProfile(),
    )
    run(pg)
    result(pg, "FAILED", 0)
    with pg["sessions"]() as db:
        assert db.get(Job, pg["job_id"]).failure_code == "INVALID_EXTRACTION"


def test_failure_handler_preserves_existing_terminal_failure(pg: dict[str, Any]) -> None:
    tasks._fail_unstructured_job(
        pg["job_id"], pg["workspace_id"], "INVALID_EXTRACTION", "synthetic"
    )
    tasks._fail_unstructured_job(pg["job_id"], pg["workspace_id"], "WORKER_ERROR", "later failure")
    with pg["sessions"]() as db:
        assert db.get(Job, pg["job_id"]).failure_code == "INVALID_EXTRACTION"


def test_reconciliation_unavailable_does_not_replay_or_fail_success(
    pg: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    pg["fault"] = "lost_ack"
    factory = pg["sessions"]

    def sessions() -> Session:
        if pg.get("independent_commit_proof"):
            raise ConnectionError("synthetic fresh session unavailable")
        return factory()

    monkeypatch.setattr(tasks, "SessionLocal", sessions)
    with pytest.raises(tasks.AIFinalizationIntegrityError):
        run(pg)
    result(pg, "SUCCEEDED", 1)
    assert pg["provider_calls"] == 1


def test_incomplete_success_is_reported_safely(pg: dict[str, Any]) -> None:
    run(pg)
    with pg["sessions"]() as db:
        db.query(AuditLog).delete()
        db.commit()
    with pytest.raises(tasks.AIFinalizationIntegrityError):
        tasks._fail_unstructured_job(
            pg["job_id"],
            pg["workspace_id"],
            "WORKER_ERROR",
            "synthetic",
            reconcile_finalization=True,
        )
    with pg["sessions"]() as db:
        assert db.get(Job, pg["job_id"]).status == "SUCCEEDED"


def test_inconsistent_durable_state_is_not_guessed(pg: dict[str, Any]) -> None:
    run(pg)
    with pg["sessions"]() as db:
        db.get(Job, pg["job_id"]).status = "RUNNING"
        db.commit()
    with pytest.raises(tasks.AIFinalizationIntegrityError):
        tasks._fail_unstructured_job(
            pg["job_id"],
            pg["workspace_id"],
            "WORKER_ERROR",
            "synthetic",
            reconcile_finalization=True,
        )
    with pg["sessions"]() as db:
        assert db.get(Job, pg["job_id"]).status == "RUNNING"
        assert db.scalar(select(func.count()).select_from(Case)) == 1


def test_foreign_workspace_cannot_claim_or_fail(pg: dict[str, Any]) -> None:
    tasks.ingest_unstructured_job.run(pg["job_id"], str(uuid4()))
    assert pg["provider_calls"] == 0
    with pytest.raises(tasks.AIFinalizationIntegrityError):
        tasks._fail_unstructured_job(pg["job_id"], str(uuid4()), "WORKER_ERROR", "synthetic")
    with pg["sessions"]() as db:
        assert db.get(Job, pg["job_id"]).status == "PENDING"
