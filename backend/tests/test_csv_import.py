"""CSV contract tests: real sessions, worker, API and independent committed read-back.

CSV_TEST_DATABASE_URL enables the same suite on disposable PostgreSQL. Each test
uses its own schema; never point this variable at the portfolio database.
"""

import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import tasks
from app.core.auth import FirebaseIdentity, get_firebase_identity
from app.core.constants import WorkspaceRole
from app.core.database import Base, get_db
from app.main import app
from app.models.case import Case
from app.models.job import Job
from app.models.workspace import User, Workspace, WorkspaceMembership
from app.services import case_service


@pytest.fixture
def csv_env(monkeypatch):
    url = os.environ.get("CSV_TEST_DATABASE_URL")
    schema = "csv_test_" + uuid.uuid4().hex
    if url:
        admin = create_engine(url)
        with admin.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    else:
        engine = create_engine(
            "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
        )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(tasks, "SessionLocal", sessions)
    monkeypatch.setattr(tasks.ingest_csv_job, "delay", lambda *_: type("R", (), {"id": None})())
    with sessions() as db:
        user = User(firebase_uid="csv-contract-user")
        workspaces = [Workspace(name="CSV synthetic A"), Workspace(name="CSV synthetic B")]
        db.add_all([user, *workspaces])
        db.flush()
        for workspace in workspaces:
            db.add(
                WorkspaceMembership(
                    user_id=user.id, workspace_id=workspace.id, role=WorkspaceRole.OWNER
                )
            )
        db.commit()
        workspace_ids = [w.id for w in workspaces]

    def database():
        with sessions() as db:
            yield db

    previous = app.dependency_overrides.copy()
    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_firebase_identity] = lambda: FirebaseIdentity(
        "csv-contract-user", None, True
    )
    client = TestClient(
        app, headers={"Authorization": "Bearer synthetic", "X-Workspace-ID": workspace_ids[0]}
    )
    yield client, sessions, workspace_ids
    client.close()
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)
    engine.dispose()
    if url:
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def upload(env, content, workspace=None):
    client, sessions, workspaces = env
    workspace = workspace or workspaces[0]
    data = content.encode("utf-8") if isinstance(content, str) else content
    response = client.post(
        "/api/v1/ingest/csv",
        headers={"X-Workspace-ID": workspace},
        files={"file": ("synthetic.csv", data, "text/csv")},
    )
    assert response.status_code == 202
    job_id = response.json()["id"]
    tasks.ingest_csv_job.run(job_id, workspace)
    result = client.get(f"/api/v1/jobs/{job_id}", headers={"X-Workspace-ID": workspace})
    assert result.status_code == 200
    with sessions() as db:
        durable = db.get(Job, job_id)
        assert durable.status == result.json()["status"]
        assert durable.successful_rows == result.json()["successful_rows"]
    return result.json()


def count(env, workspace=None):
    _, sessions, workspaces = env
    with sessions() as db:
        return db.scalar(
            select(func.count())
            .select_from(Case)
            .where(Case.workspace_id == (workspace or workspaces[0]))
        )


@pytest.mark.parametrize(
    "content",
    [
        "case_number,full_name,email\nCSV-1,Emre Demo Yılmaz,emre@demo.example\n",
        "case_number,full_name\nCSV-1,Emre Demo Yılmaz,discarded\n",
        'case_number,full_name\nCSV-1,"Emre Demo Yılmaz\n',
    ],
)
def test_audited_data_loss_is_rejected_atomically(csv_env, content):
    result = upload(csv_env, content)
    assert result["status"] == "FAILED"
    assert result["failure_code"] == "INVALID_CSV"
    assert result["successful_rows"] == count(csv_env) == 0


@pytest.mark.parametrize(
    "content,reason,total",
    [
        ("", "empty", None),
        ("case_number,full_name\n", "no data", 0),
        ("full_name\nEmre Demo Yılmaz\n", "missing required", 1),
        ("CASE_NUMBER,full_name\nA,Example\n", "missing required", 1),
        ("case_number,full_name, full_name \nA,Example,Other\n", "duplicate column", 1),
        ("case_number,full_name,\nA,Example,\n", "empty column", 1),
        ("case_number,full_name\nA,Example\nB, \n", "full_name is required", 2),
        ("case_number,full_name\nA,Example\n ,Other\n", "case_number is required", 2),
        ("case_number,full_name\nA,Example\n\nB,Other\n", "blank row", 3),
        ("case_number,full_name\nA,Example\n , \n", "blank row", 2),
        ("case_number,full_name,old_email\nA,Example\n", "number of values", 1),
        ("case_number,full_name\nA,Example\nA,Example\n", "duplicate case", 2),
        ("case_number,full_name\nA,Example\nA,Other\n", "duplicate case", 2),
        ("case_number,full_name\n" + "X" * 51 + ",Example\n", "at most 50", 1),
        ("case_number,full_name\nA," + "X" * 101 + "\n", "too long", 1),
        (
            "case_number,full_name\n" + "".join(f"A{i},Example\n" for i in range(101)),
            "maximum limit",
            101,
        ),
    ],
)
def test_invalid_files_never_write_a_subset(csv_env, content, reason, total):
    result = upload(csv_env, content)
    assert result["status"] == "FAILED"
    assert reason in result["failure_message"]
    assert result["total_rows"] == total
    assert result["rejected_rows"] == (total or 0)
    assert result["successful_rows"] == count(csv_env) == 0


def test_all_valid_bom_unicode_and_read_back(csv_env):
    content = (
        "\ufeff location , old_phone ,full_name,case_number,source_identifier,old_email,employer\n"
        "İzmir,+905550008877,Emre Demo Yılmaz,A,SAME,emre@demo.example,Mavişehir Teknoloji\n"
        "İzmir,,Leyla Demo Karaca,B,SAME,,Mavişehir Teknoloji\n"
        "İzmir,,Çağrı Demo Işık,C,SAME,,Mavişehir Teknoloji\n"
    )
    result = upload(csv_env, content)
    assert result["status"] == "SUCCEEDED"
    assert result["total_rows"] == result["successful_rows"] == count(csv_env) == 3
    assert result["processed_rows"] == 3 and result["rejected_rows"] == 0
    client, sessions, workspaces = csv_env
    with sessions() as db:
        rows = db.scalars(
            select(Case).where(Case.workspace_id == workspaces[0]).order_by(Case.case_number)
        ).all()
        assert [r.raw_name for r in rows] == [
            "Emre Demo Yılmaz",
            "Leyla Demo Karaca",
            "Çağrı Demo Işık",
        ]
        assert all(
            r.raw_location == "İzmir"
            and r.raw_employer == "Mavişehir Teknoloji"
            and r.source_identifier == "SAME"
            for r in rows
        )
        assert rows[0].raw_phone == "+905550008877"
        assert rows[0].raw_email == "emre@demo.example"
        for row in rows:
            detail = client.get(f"/api/v1/cases/{row.id}").json()
            assert detail["raw_name"] == row.raw_name
            assert detail["raw_location"] == row.raw_location
    listing = client.get("/api/v1/cases").json()
    assert len(listing) == result["successful_rows"]


def test_duplicate_upload_and_delivery_preserve_existing_rules(csv_env):
    content = "case_number,full_name,source_identifier\nA,Example,SAME\nB,Other,SAME\n"
    first = upload(csv_env, content)
    second = upload(csv_env, content)
    assert first["successful_rows"] == 2
    assert second["status"] == "FAILED" and second["successful_rows"] == 0
    assert second["total_rows"] == second["rejected_rows"] == 2
    assert "already exists in this workspace" in second["failure_message"]
    tasks.ingest_csv_job.run(first["id"], csv_env[2][0])
    assert count(csv_env) == 2
    assert csv_env[0].get(f"/api/v1/jobs/{first['id']}").json() == first


def test_workspace_authority_and_uniqueness(csv_env):
    content = "case_number,full_name\nA,Example\n"
    first = upload(csv_env, content)
    assert count(csv_env, csv_env[2][1]) == 0
    foreign = {"X-Workspace-ID": csv_env[2][1]}
    assert csv_env[0].get(f"/api/v1/jobs/{first['id']}", headers=foreign).status_code == 404
    assert csv_env[0].get("/api/v1/cases", headers=foreign).json() == []
    second = upload(csv_env, content, csv_env[2][1])
    assert second["successful_rows"] == count(csv_env, csv_env[2][1]) == 1
    # A forged task workspace cannot claim or change another workspace's Job.
    tasks.ingest_csv_job.run(first["id"], csv_env[2][1])
    assert count(csv_env) == 1


@pytest.mark.parametrize("prefix", ["=", "+", "-", "@"])
def test_raw_formula_like_values_and_unvalidated_contacts_are_preserved(csv_env, prefix):
    result = upload(
        csv_env,
        "case_number,full_name,old_email,old_phone,employer,location\n"
        f"A,{prefix}Demo Example,not-an-email,{prefix}not-a-phone,"
        f"{prefix}Demo,{prefix}İzmir\n",
    )
    assert result["successful_rows"] == count(csv_env) == 1
    with csv_env[1]() as db:
        row = db.scalar(select(Case).where(Case.case_number == "A"))
        assert row.raw_name == prefix + "Demo Example"
        assert row.raw_phone == prefix + "not-a-phone"
        assert row.raw_email == "not-an-email"
        assert row.raw_employer == prefix + "Demo"
        assert row.raw_location == prefix + "İzmir"


def test_supported_storage_bounds_and_optional_fields(csv_env):
    content = (
        "case_number,full_name,source_identifier,old_email,old_phone,employer,location\n"
        + "A" * 50
        + ","
        + " ".join(["N" * 80] * 3)
        + ","
        + "S" * 100
        + ","
        + "E" * 255
        + ","
        + "5" * 50
        + ","
        + "M" * 255
        + ","
        + "L" * 255
        + "\nB,Optional Demo,,,,,\n"
    )
    result = upload(csv_env, content)
    assert result["successful_rows"] == count(csv_env) == 2


@pytest.mark.parametrize(
    "fault",
    ["mid_batch", "constraint", "missing_row", "final_commit", "lost_ack", "lost_connection_ack"],
)
def test_persistence_failures_are_atomic_and_truthful(csv_env, monkeypatch, fault):
    original = case_service.persist_case_resolution
    calls = 0

    def persist(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2 and fault == "mid_batch":
            raise RuntimeError("synthetic persistence interruption")
        if calls == 2 and fault == "constraint":
            kwargs["case_number"] = "A"  # Real database unique constraint, not a mock error.
        row = original(*args, **kwargs)
        if calls == 2 and fault == "missing_row":
            kwargs["db"].delete(row)
        return row

    monkeypatch.setattr(case_service, "persist_case_resolution", persist)
    sessions = csv_env[1]
    original_commit = sessions.class_.commit
    triggered = False

    def commit(db):
        nonlocal triggered
        is_terminal = any(
            isinstance(obj, Job) and obj.status == "SUCCEEDED" for obj in db.identity_map.values()
        )
        if (
            is_terminal
            and not triggered
            and fault in {"final_commit", "lost_ack", "lost_connection_ack"}
        ):
            triggered = True
            if fault in {"lost_ack", "lost_connection_ack"}:
                original_commit(db)
            if fault == "lost_connection_ack":
                raise ConnectionError("synthetic lost acknowledgement")
            raise RuntimeError("synthetic lost acknowledgement")
        return original_commit(db)

    monkeypatch.setattr(sessions.class_, "commit", commit)
    result = upload(csv_env, "case_number,full_name\nA,Example\nB,Other\n")
    expected = 2 if fault in {"lost_ack", "lost_connection_ack"} else 0
    assert result["status"] == ("SUCCEEDED" if expected else "FAILED")
    assert result["successful_rows"] == count(csv_env) == expected
    if not expected:
        assert "synthetic" not in result["failure_message"]


@pytest.mark.skipif(not os.environ.get("CSV_TEST_DATABASE_URL"), reason="real PostgreSQL only")
def test_postgres_connection_interruption_rolls_back_batch(csv_env, monkeypatch):
    original = case_service.persist_case_resolution
    calls = 0

    def persist(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            db = kwargs["db"]
            pid = db.scalar(text("select pg_backend_pid()"))
            admin = create_engine(os.environ["CSV_TEST_DATABASE_URL"])
            with admin.begin() as conn:
                assert conn.scalar(text("select pg_terminate_backend(:pid)"), {"pid": pid})
            admin.dispose()
        return original(*args, **kwargs)

    monkeypatch.setattr(case_service, "persist_case_resolution", persist)
    result = upload(csv_env, "case_number,full_name\nA,Example\nB,Other\n")
    assert result["status"] == "FAILED"
    assert result["successful_rows"] == count(csv_env) == 0


def test_independent_reader_cannot_see_success_before_commit(csv_env):
    if not os.environ.get("CSV_TEST_DATABASE_URL"):
        pytest.skip("requires independent PostgreSQL connections")
    observed = []

    def before_commit(db):
        if any(
            isinstance(obj, Job) and obj.status == "SUCCEEDED" for obj in db.identity_map.values()
        ):
            with csv_env[1]() as reader:
                job = reader.scalar(select(Job))
                observed.append((job.status, job.successful_rows, count(csv_env)))

    event.listen(csv_env[1].class_, "before_commit", before_commit)
    try:
        result = upload(csv_env, "case_number,full_name\nA,Example\nB,Other\n")
    finally:
        event.remove(csv_env[1].class_, "before_commit", before_commit)
    assert observed == [("RUNNING", 0, 0)]
    assert result["successful_rows"] == count(csv_env) == 2


@pytest.mark.parametrize(
    "data,reason",
    [
        (b"case_number,full_name\nA,Example\x00\n", "null characters"),
        (b"\xff", "UTF-8"),
    ],
)
def test_unstorable_bytes_rejected_before_job_creation(csv_env, data, reason):
    response = csv_env[0].post(
        "/api/v1/ingest/csv", files={"file": ("synthetic.csv", data, "text/csv")}
    )
    assert response.status_code == 422
    assert reason in response.json()["detail"]
    assert count(csv_env) == 0
    with csv_env[1]() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 0


def test_enqueue_ack_failure_cannot_overwrite_completed_import(csv_env, monkeypatch):
    def published(job_id, workspace_id):
        tasks.ingest_csv_job.run(job_id, workspace_id)
        raise ConnectionError("synthetic broker acknowledgement failure")

    monkeypatch.setattr(tasks.ingest_csv_job, "delay", published)
    result = upload(csv_env, "case_number,full_name\nA,Example\n")
    assert result["status"] == "SUCCEEDED"
    assert result["successful_rows"] == count(csv_env) == 1
