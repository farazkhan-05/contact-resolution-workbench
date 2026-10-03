import json
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from pydantic import ValidationError
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.audit import AuditLog
from app.models.case import CandidateRecord, Case, MatchEvidence
from app.models.investigation import InvestigationRun
from app.models.workspace import User, Workspace
from app.schemas.investigation import EvidenceGap, HumanResponse, Operation
from app.schemas.resolution import CaseQuery, ExtractedCandidateProfile
from app.services import investigation_service
from app.services.case_service import persist_case_resolution
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.investigation_graph import build_graph, is_transient
from app.services.investigation_operations import InvestigationOperations
from app.services.investigation_service import create_run, execute_run, queue_resume
from app.services.resolution_service import ResolutionService
from tests.test_workspace_isolation import bootstrap, headers

pytest_plugins = ("tests.test_workspace_isolation",)


class FakeExtractor(GeminiExtractor):
    def __init__(self, operation: Operation = Operation.RETRIEVE_SYNTHETIC_NOTES) -> None:
        self.operation = operation
        self.plan_calls = 0
        self.extraction_calls = 0

    def determine_evidence_gap(self, context: dict[str, Any]) -> EvidenceGap:
        self.plan_calls += 1
        return EvidenceGap(category="missing_phone", operation=self.operation)

    def extract_from_unstructured_text(self, text: str) -> ExtractedCandidateProfile:
        self.extraction_calls += 1
        return ExtractedCandidateProfile(
            name="Elena Rostova",
            phone="+1 (202) 555-0144",
            employer="Vanguard Analytics Inc",
            job_title="Principal Researcher",
            location="Boston, MA",
        )


def seed_run(sessions: sessionmaker[Session], *, ready: bool = False) -> InvestigationRun:
    with sessions() as db:
        workspace = Workspace(name="Investigation test")
        user = User(firebase_uid=f"fixture-{uuid.uuid4()}", is_anonymous=True)
        db.add_all([workspace, user])
        db.flush()
        query = CaseQuery(
            name="Elena Rostova",
            phone="+1 (202) 555-0144" if ready else None,
            employer="Vanguard Analytics Inc" if ready else None,
            location="Boston, MA" if ready else None,
        )
        case = persist_case_resolution(
            db, workspace.id, "D1-TEST", None, query, ResolutionService().resolve(query)
        )
        case.routing_status = "NEEDS_REVIEW"
        db.commit()
        return create_run(db, workspace.id, user.id, case.id)


@pytest.fixture
def graph_env(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[tuple[sessionmaker[Session], InMemorySaver, InvestigationRun]]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    saver = InMemorySaver()
    monkeypatch.setattr(investigation_service, "SessionLocal", sessions)

    @contextmanager
    def checkpoints() -> Iterator[InMemorySaver]:
        yield saver

    monkeypatch.setattr(investigation_service, "postgres_checkpointer", checkpoints)
    yield sessions, saver, seed_run(sessions)
    engine.dispose()


def counts(sessions: sessionmaker[Session]) -> tuple[int, int, int]:
    with sessions() as db:
        return tuple(
            db.scalar(select(func.count()).select_from(model)) or 0
            for model in (CandidateRecord, MatchEvidence, AuditLog)
        )  # type: ignore[return-value]


def test_real_interrupt_same_thread_resume_and_duplicate_delivery(
    graph_env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sessions, saver, run = graph_env
    model = FakeExtractor()
    retrievals = 0
    original = InvestigationOperations.retrieve

    def retrieve(self: InvestigationOperations, state: Any) -> Any:
        nonlocal retrievals
        retrievals += 1
        return original(self, state)

    def forbidden_decision(*args: Any, **kwargs: Any) -> Any:
        pytest.fail("Graph attempted a final reviewer decision")

    from app.services import case_service

    monkeypatch.setattr(InvestigationOperations, "retrieve", retrieve)
    monkeypatch.setattr(case_service, "record_decision", forbidden_decision)
    execute_run(run.id, saver, sessions, model)
    before = counts(sessions)
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.status == "WAITING_FOR_HUMAN"
        assert current.thread_id == run.thread_id
        queue_resume(db, current, HumanResponse(action="STOP"))
    execute_run(run.id, saver, sessions, model)
    after = counts(sessions)
    assert after[:2] == before[:2]
    assert after[2] == before[2] + 2
    assert model.extraction_calls == model.plan_calls == 1
    assert retrievals == 1
    execute_run(run.id, saver, sessions, model)
    assert counts(sessions) == after
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.status == "SUCCEEDED"
        assert current.outcome == "HUMAN_REVIEW_REQUIRED"
        assert db.get(Case, run.case_id).review_decision == "PENDING"
        with pytest.raises(ValueError):
            queue_resume(db, current, HumanResponse(action="STOP"))
    checkpoint = saver.get_tuple({"configurable": {"thread_id": run.thread_id}})
    assert checkpoint is not None
    serialized = json.dumps(checkpoint.checkpoint, default=str)
    assert "Bearer" not in serialized and "firebase" not in serialized.lower()


def test_approved_evidence_completes_without_review_decision(graph_env: Any) -> None:
    sessions, saver, _ = graph_env
    run = seed_run(sessions, ready=True)
    execute_run(run.id, saver, sessions, FakeExtractor())
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.status == "SUCCEEDED"
        assert current.outcome == "EVIDENCE_READY"
        case = db.get(Case, run.case_id)
        assert case.review_decision == "PENDING"
        assert case.routing_status == "NEEDS_REVIEW"
        event = db.scalar(
            select(AuditLog).where(
                AuditLog.case_id == run.case_id,
                AuditLog.event_type == "INVESTIGATION_EVIDENCE_ADDED",
            )
        )
        assert event.payload["artifact_id"] == "UNSTRUCT-4003"
        assert event.payload["provider"] == "SYNTHETIC_CONFERENCE_ROSTER"
        assert event.payload["extracted_by"] == "Gemini"
        assert event.payload["retrieved_at"]
        assert "raw_evidence_text" not in event.payload


@pytest.mark.parametrize("failure", ["schema", "invented", "permanent", "transient"])
def test_invalid_or_failed_extraction_is_bounded_and_persists_nothing(
    graph_env: Any, failure: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    sessions, saver, run = graph_env
    model = FakeExtractor()
    calls = 0

    def extract(text: str) -> Any:
        nonlocal calls
        calls += 1
        if failure == "schema":
            return {"name": {"malformed": True}}
        if failure == "invented":
            return ExtractedCandidateProfile(name="Invented Name")
        if failure == "transient":
            raise TimeoutError("secret provider details")
        raise GeminiExtractionError("secret provider details")

    monkeypatch.setattr(model, "extract_from_unstructured_text", extract)
    before = counts(sessions)
    execute_run(run.id, saver, sessions, model)
    assert calls == (3 if failure == "transient" else 1)
    assert counts(sessions)[:2] == before[:2]
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.status == "FAILED"
        assert "secret" not in current.last_error_message


def test_transient_retrieval_recovers(graph_env: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    sessions, saver, run = graph_env
    retrieve = InvestigationOperations.retrieve
    calls = 0

    def flaky(self: InvestigationOperations, state: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise ConnectionError("temporary")
        return retrieve(self, state)

    monkeypatch.setattr(InvestigationOperations, "retrieve", flaky)
    execute_run(run.id, saver, sessions, FakeExtractor())
    assert calls == 3
    with sessions() as db:
        assert db.get(InvestigationRun, run.id).status == "WAITING_FOR_HUMAN"


def test_contradictions_remain_authoritative(graph_env: Any) -> None:
    sessions, saver, run = graph_env
    with sessions() as db:
        case = db.get(Case, run.case_id)
        case.middle_name = "Different"
        case.raw_name = "Elena Different Rostova"
        db.commit()
    execute_run(run.id, saver, sessions, FakeExtractor(Operation.INSPECT_EXISTING))
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.status == "WAITING_FOR_HUMAN"
        assert current.outcome is None
        assert db.get(Case, run.case_id).review_decision == "PENDING"


def test_human_can_request_one_governed_step(graph_env: Any) -> None:
    sessions, saver, run = graph_env
    model = FakeExtractor(Operation.HUMAN_INPUT)
    execute_run(run.id, saver, sessions, model)
    with sessions() as db:
        queue_resume(
            db, db.get(InvestigationRun, run.id), HumanResponse(action="RETRIEVE_SYNTHETIC_NOTES")
        )
    execute_run(run.id, saver, sessions, model)
    assert model.extraction_calls == 1
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.status == "WAITING_FOR_HUMAN"
        with pytest.raises(ValueError):
            queue_resume(db, current, HumanResponse(action="RETRIEVE_SYNTHETIC_NOTES"))


def test_replay_persistence_node_is_idempotent(graph_env: Any) -> None:
    sessions, saver, run = graph_env
    model = FakeExtractor()
    graph = build_graph(sessions, saver, model)
    config = {"configurable": {"thread_id": run.thread_id}}
    graph.invoke(
        {"investigation_run_id": run.id, "workspace_id": run.workspace_id, "case_id": run.case_id},
        config,
    )
    snapshot = graph.get_state(config)
    state = dict(snapshot.values)
    state["extracted"] = model.extract_from_unstructured_text("").model_dump()
    before = counts(sessions)
    InvestigationOperations(sessions, model).persist(state)
    assert counts(sessions) == before
    with pytest.raises(ValidationError):
        graph.invoke(Command(resume={"action": "ACCEPTED"}), config)
    assert counts(sessions) == before


@pytest.mark.parametrize(
    "payload",
    [
        {"action": "ACCEPTED"},
        {"action": "STOP", "thread_id": "other"},
        {"action": "STOP", "goto": "persist_evidence"},
        {"action": 1},
    ],
)
def test_typed_response_rejects_arbitrary_commands(payload: Any) -> None:
    with pytest.raises(ValidationError):
        HumanResponse.model_validate(payload)


def test_operation_enum_rejects_tool_injection() -> None:
    with pytest.raises(ValidationError):
        EvidenceGap(category="missing_email", operation="https://evil.example/query")


def test_cross_tenant_start_get_resume_and_threads(
    isolated_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api import investigations

    client, sessions = isolated_client
    workspace_a = bootstrap(client, "user-a")
    workspace_b = bootstrap(client, "user-b")
    a, b = headers("user-a", workspace_a), headers("user-b", workspace_b)
    monkeypatch.setattr(investigations.investigate_evidence, "delay", lambda run_id: None)
    case_id = client.post("/api/v1/ingest/sample", headers=a).json()["case_ids"][3]
    assert client.post(f"/api/v1/cases/{case_id}/investigations", headers=b).status_code == 404
    created = client.post(f"/api/v1/cases/{case_id}/investigations", headers=a)
    assert created.status_code == 202
    run_id = created.json()["id"]
    assert "thread_id" not in created.json()
    assert client.get(f"/api/v1/investigations/{run_id}", headers=b).status_code == 404
    assert (
        client.post(
            f"/api/v1/investigations/{run_id}/resume", headers=b, json={"action": "STOP"}
        ).status_code
        == 404
    )
    assert client.get(f"/api/v1/cases/{case_id}/investigations", headers=b).status_code == 404
    with sessions() as db:
        run = db.get(InvestigationRun, run_id)
        internal_thread = run.thread_id
    assert client.get(f"/api/v1/investigations/{internal_thread}", headers=a).status_code == 404
    assert (
        client.post(
            f"/api/v1/investigations/{run_id}/resume",
            headers=a,
            json={"action": "STOP", "thread_id": internal_thread},
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/v1/investigations/{run_id}/resume", headers=a, json={"action": "STOP"}
        ).status_code
        == 409
    )
    assert client.get(f"/api/v1/cases/{case_id}", headers=a).status_code == 200
    repeated = client.post(f"/api/v1/cases/{case_id}/investigations", headers=a)
    assert repeated.json()["id"] == run_id


def test_worker_scoped_context_rejects_mismatched_workspace(graph_env: Any) -> None:
    sessions, saver, run = graph_env
    graph = build_graph(sessions, saver, FakeExtractor())
    with pytest.raises(ValueError):
        graph.invoke(
            {
                "investigation_run_id": run.id,
                "workspace_id": "foreign-workspace",
                "case_id": run.case_id,
            },
            {"configurable": {"thread_id": "unit-only"}},
        )


def test_deterministic_provider_failure_is_not_retried(
    graph_env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sessions, saver, run = graph_env
    calls = 0

    def unavailable(self: InvestigationOperations, state: Any) -> Any:
        nonlocal calls
        calls += 1
        raise ValueError("unsupported provider operation")

    monkeypatch.setattr(InvestigationOperations, "retrieve", unavailable)
    before = counts(sessions)
    execute_run(run.id, saver, sessions, FakeExtractor())
    assert calls == 1
    assert counts(sessions)[:2] == before[:2]


def test_model_tool_choice_is_validated_before_execution(
    graph_env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sessions, saver, run = graph_env
    model = FakeExtractor()
    monkeypatch.setattr(
        model,
        "determine_evidence_gap",
        lambda context: {
            "category": "missing_phone",
            "operation": "execute_sql",
            "sql": "SELECT * FROM users",
        },
    )
    before = counts(sessions)
    execute_run(run.id, saver, sessions, model)
    assert counts(sessions)[:2] == before[:2]
    assert model.extraction_calls == 0


def test_waiting_interrupt_api_is_scoped_and_task_contains_only_run_id(
    isolated_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api import investigations

    client, sessions = isolated_client
    workspace_a = bootstrap(client, "user-a")
    workspace_b = bootstrap(client, "user-b")
    a, b = headers("user-a", workspace_a), headers("user-b", workspace_b)
    task_arguments = []
    monkeypatch.setattr(
        investigations.investigate_evidence, "delay", lambda *args: task_arguments.append(args)
    )
    saver = InMemorySaver()
    checkpoint_reads = 0

    @contextmanager
    def checkpoints() -> Iterator[InMemorySaver]:
        nonlocal checkpoint_reads
        checkpoint_reads += 1
        yield saver

    monkeypatch.setattr(investigation_service, "postgres_checkpointer", checkpoints)
    case_id = client.post("/api/v1/ingest/sample", headers=a).json()["case_ids"][3]
    run_id = client.post(f"/api/v1/cases/{case_id}/investigations", headers=a).json()["id"]
    execute_run(run_id, saver, sessions, FakeExtractor())
    assert client.get(f"/api/v1/investigations/{run_id}", headers=b).status_code == 404
    assert (
        client.post(
            f"/api/v1/investigations/{run_id}/resume", headers=b, json={"action": "STOP"}
        ).status_code
        == 404
    )
    assert checkpoint_reads == 0
    own = client.get(f"/api/v1/investigations/{run_id}", headers=a)
    assert own.json()["interrupt"]["allowed_actions"] == ["STOP"]
    assert "thread_id" not in own.json()
    resumed = client.post(
        f"/api/v1/investigations/{run_id}/resume", headers=a, json={"action": "STOP"}
    )
    assert resumed.status_code == 202
    assert task_arguments == [(run_id,), (run_id,)]


def test_checkpoint_failure_is_sanitized_in_worker(
    graph_env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app import tasks

    sessions, _, run = graph_env
    monkeypatch.setattr(tasks, "SessionLocal", sessions)

    @contextmanager
    def unavailable() -> Iterator[InMemorySaver]:
        raise RuntimeError("secret database credentials")
        yield InMemorySaver()

    monkeypatch.setattr(investigation_service, "postgres_checkpointer", unavailable)
    tasks.investigate_evidence.run(run.id)
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.status == "FAILED"
        assert current.last_error_code == "CHECKPOINT_UNAVAILABLE"
        assert "secret" not in current.last_error_message


def test_recovery_does_not_reapply_old_response_to_a_new_interrupt(graph_env: Any) -> None:
    sessions, saver, run = graph_env
    model = FakeExtractor(Operation.HUMAN_INPUT)
    execute_run(run.id, saver, sessions, model)
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        queue_resume(db, current, HumanResponse(action="RETRIEVE_SYNTHETIC_NOTES"))
        queued_input = current.resume_input
    # Simulate worker loss after checkpointing a second interrupt, before its metadata commit.
    config = {"configurable": {"thread_id": run.thread_id}}
    graph = build_graph(sessions, saver, model)
    result = graph.invoke(
        Command(resume={queued_input["interrupt_id"]: queued_input["response"]}),
        config,
        durability="sync",
    )
    assert result["__interrupt__"]
    before = counts(sessions)
    execute_run(run.id, saver, sessions, model)
    assert counts(sessions)[:2] == before[:2]
    assert model.plan_calls == model.extraction_calls == 1
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.status == "WAITING_FOR_HUMAN"
        assert current.resume_input is None


def test_gemini_gap_uses_configured_structured_boundary() -> None:
    client = MagicMock()
    client.models.generate_content.return_value.text = json.dumps(
        {"category": "missing_phone", "operation": "RETRIEVE_SYNTHETIC_NOTES"}
    )
    extractor = GeminiExtractor(client=client, model="configured-test-model")
    gap = extractor.determine_evidence_gap({"notes_available": True})
    assert gap.operation == Operation.RETRIEVE_SYNTHETIC_NOTES
    arguments = client.models.generate_content.call_args.kwargs
    assert arguments["model"] == "configured-test-model"
    assert arguments["config"].response_schema is EvidenceGap
    client.models.generate_content.return_value.text = '{"operation": "arbitrary_http"}'
    with pytest.raises(GeminiExtractionError):
        extractor.determine_evidence_gap({"notes_available": True})


def test_sdk_timeout_classification_is_transient() -> None:
    client = MagicMock()
    client.models.generate_content.side_effect = httpx.ReadTimeout("provider details")
    with pytest.raises(GeminiExtractionError) as caught:
        GeminiExtractor(client=client).extract_from_unstructured_text("synthetic evidence")
    assert caught.value.__cause__ is None
    assert is_transient(caught.value)
    assert not is_transient(ValueError("invalid extraction"))


def test_new_run_does_not_retrieve_an_already_persisted_source(graph_env: Any) -> None:
    sessions, saver, run = graph_env
    execute_run(run.id, saver, sessions, FakeExtractor())
    with sessions() as db:
        queue_resume(db, db.get(InvestigationRun, run.id), HumanResponse(action="STOP"))
    execute_run(run.id, saver, sessions, FakeExtractor())
    before = counts(sessions)
    with sessions() as db:
        next_run = create_run(db, run.workspace_id, run.created_by_user_id, run.case_id)
    model = FakeExtractor()
    execute_run(next_run.id, saver, sessions, model)
    assert model.plan_calls == model.extraction_calls == 0
    assert counts(sessions)[:2] == before[:2]
    with sessions() as db:
        current = db.get(InvestigationRun, next_run.id)
        assert current.status == "WAITING_FOR_HUMAN"
        assert investigation_service.run_response(current).interrupt.allowed_actions == ["STOP"]


@pytest.mark.parametrize(
    "failure,recover,attempts,code",
    [
        ("timeout", True, 2, None),
        ("503", True, 2, None),
        ("429", True, 2, None),
        ("timeout", False, 3, "PROVIDER_TEMPORARY_FAILURE"),
        ("503", False, 3, "PROVIDER_TEMPORARY_FAILURE"),
        ("429", False, 3, "PROVIDER_TEMPORARY_FAILURE"),
        ("quota", True, 1, "PROVIDER_PERMANENT_FAILURE"),
        ("billing", True, 1, "PROVIDER_PERMANENT_FAILURE"),
        ("401", True, 1, "PROVIDER_PERMANENT_FAILURE"),
        ("403", True, 1, "PROVIDER_PERMANENT_FAILURE"),
        ("400", True, 1, "PROVIDER_PERMANENT_FAILURE"),
        ("malformed", True, 1, "PROVIDER_PERMANENT_FAILURE"),
        ("schema", True, 1, "PROVIDER_PERMANENT_FAILURE"),
        ("blocked", True, 1, "PROVIDER_PERMANENT_FAILURE"),
        ("empty_person", True, 1, "EVIDENCE_OPERATION_FAILED"),
    ],
)
def test_real_provider_wrapper_governed_graph_retry(
    graph_env: Any,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure: str,
    recover: bool,
    attempts: int,
    code: str | None,
) -> None:
    from types import SimpleNamespace

    from google.genai.errors import ClientError, ServerError

    from tests.test_gemini_retry import quota_error

    sessions, saver, run = graph_env
    client = MagicMock()
    success = SimpleNamespace(
        text=FakeExtractor().extract_from_unstructured_text("").model_dump_json()
    )
    private = "PRIVATE body evidence name@example.test Bearer api-secret"
    failures: dict[str, Any] = {
        "timeout": httpx.ReadTimeout(private),
        "503": ServerError(503, {"error": {"message": private}}),
        "429": quota_error("RequestsPerMinute"),
        "quota": quota_error("RequestsPerDay"),
        "billing": ClientError(402, {"error": {"message": private}}),
        "401": ClientError(401, {"error": {"message": private}}),
        "403": ClientError(403, {"error": {"message": private}}),
        "400": ClientError(400, {"error": {"message": private}}),
        "empty_person": SimpleNamespace(text="{}"),
        "malformed": SimpleNamespace(text=private),
        "schema": SimpleNamespace(text=json.dumps({"name": {"private": private}})),
        "blocked": SimpleNamespace(
            text=None, prompt_feedback=SimpleNamespace(block_reason="SAFETY")
        ),
    }
    first = failures[failure]
    client.models.generate_content.side_effect = [first, success] if recover else [first] * 3
    model = GeminiExtractor(client=client)
    monkeypatch.setattr(model, "determine_evidence_gap", FakeExtractor().determine_evidence_gap)
    before = counts(sessions)
    execute_run(run.id, saver, sessions, model)
    assert client.models.generate_content.call_count == attempts
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.thread_id == run.thread_id
        assert db.get(Case, run.case_id).review_decision == "PENDING"
        assert current.last_error_code == code
        if code:
            assert current.status == "FAILED"
            assert counts(sessions)[:2] == before[:2]
            assert private not in current.last_error_message
        else:
            assert current.status == "WAITING_FOR_HUMAN"
            assert counts(sessions)[0] == before[0] + 1
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(AuditLog)
                    .where(
                        AuditLog.case_id == run.case_id,
                        AuditLog.event_type == "INVESTIGATION_EVIDENCE_ADDED",
                    )
                )
                == 1
            )
            queue_resume(db, current, HumanResponse(action="STOP"))
    if not code:
        execute_run(run.id, saver, sessions, model)
        after = counts(sessions)
        execute_run(run.id, saver, sessions, model)
        assert counts(sessions) == after
        assert client.models.generate_content.call_count == attempts
        with sessions() as db:
            assert db.get(InvestigationRun, run.id).status == "SUCCEEDED"
            assert db.get(Case, run.case_id).review_decision == "PENDING"
    assert private not in caplog.text


@pytest.mark.parametrize("stage", ["read", "write", "execution", "application_db"])
def test_worker_failure_attribution(
    graph_env: Any, monkeypatch: pytest.MonkeyPatch, stage: str
) -> None:
    from app import tasks

    sessions, saver, run = graph_env
    monkeypatch.setattr(tasks, "SessionLocal", sessions)
    if stage in {"read", "write"}:

        def unavailable(*args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("PRIVATE database credentials")

        monkeypatch.setattr(saver, "get_tuple" if stage == "read" else "put", unavailable)
        original = execute_run
        monkeypatch.setattr(
            investigation_service,
            "execute_run",
            lambda run_id, checkpoint: original(run_id, checkpoint, sessions, FakeExtractor()),
        )
    else:

        def fail(*args: Any, **kwargs: Any) -> None:
            if stage == "application_db":
                from sqlalchemy.exc import OperationalError

                raise OperationalError("PRIVATE", {}, RuntimeError("PRIVATE"))
            raise RuntimeError("PRIVATE arbitrary execution error")

        monkeypatch.setattr(investigation_service, "execute_run", fail)
    tasks.investigate_evidence.run(run.id)
    with sessions() as db:
        current = db.get(InvestigationRun, run.id)
        assert current.status == "FAILED"
        assert current.last_error_code == (
            "CHECKPOINT_UNAVAILABLE" if stage in {"read", "write"} else "INVESTIGATION_FAILED"
        )
        assert "PRIVATE" not in current.last_error_message


@pytest.mark.parametrize("retryable", [True, False])
def test_sanitized_metadata_is_authoritative(retryable: bool) -> None:
    # Even a legacy raw cause must not override an explicit permanent decision.
    wrapped = GeminiExtractionError("Safe failure", retryable=retryable)
    wrapped.__cause__ = TimeoutError("PRIVATE")
    assert is_transient(wrapped) is retryable


def test_real_wrapper_hides_provider_body_and_evidence() -> None:
    import traceback

    client = MagicMock()
    private_body = "PRI" + "VATE body Bearer token"
    private_evidence = "PRI" + "VATE contact evidence"
    client.models.generate_content.side_effect = httpx.ReadTimeout(private_body)
    with pytest.raises(GeminiExtractionError) as caught:
        GeminiExtractor(client=client).extract_from_unstructured_text(private_evidence)
    exc = caught.value
    assert exc.code == "PROVIDER_TIMEOUT" and exc.retryable
    assert exc.__cause__ is None and exc.__suppress_context__
    assert "PRIVATE" not in str(exc)
    assert "PRIVATE" not in "".join(traceback.format_exception(exc))
