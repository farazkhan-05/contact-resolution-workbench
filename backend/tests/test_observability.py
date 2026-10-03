"""Deterministic privacy and failure checks; no external telemetry/model service."""

import json
import threading
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from celery import Celery
from celery.contrib.testing.worker import start_worker
from langfuse import Langfuse
from opentelemetry import context, trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from sqlalchemy import select

from app.core import observability as obs
from app.core import observability_celery as signals
from app.core.config import Settings
from app.core.constants import ReviewDecision
from app.models.case import CandidateRecord, Case
from app.models.investigation import InvestigationRun
from app.models.job import Job
from app.schemas.api import DecisionRequest
from app.schemas.investigation import HumanResponse
from app.services.case_service import record_decision
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.investigation_service import execute_run, queue_resume
from app.tasks import ingest_csv_job, investigate_evidence
from tests.test_investigations import FakeExtractor

pytest_plugins = ("tests.test_investigations",)

SENSITIVE = (
    "Elena Rostova",
    "private@example.invalid",
    "+1 (202) 555-0144",
    "Vanguard Analytics Inc",
    "Boston, MA",
    "private evidence document",
    "Bearer private-token",
    "postgresql://private-credential",
    "private-secret",
)


@pytest.fixture
def capture(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, Any]]:
    provider = obs.SafeTracerProvider(resource=Resource({"service.name": "test"}))
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(obs, "_provider", provider)
    monkeypatch.setattr(obs, "_initialized", True)
    yield provider, exporter
    provider.shutdown()


def serialized(spans: Any) -> str:
    return json.dumps([json.loads(span.to_json()) for span in spans], default=str)


def assert_private(spans: Any) -> None:
    exported = serialized(spans)
    for value in SENSITIVE:
        assert value not in exported


def model_client(*, invalid: bool = False) -> Any:
    client = MagicMock()
    profile = {
        "name": SENSITIVE[0],
        "email": SENSITIVE[1],
        "phone": SENSITIVE[2],
        "employer": SENSITIVE[3],
        "location": SENSITIVE[4],
    }
    client.models.generate_content.return_value = SimpleNamespace(
        text="invalid private response" if invalid else json.dumps(profile),
        usage_metadata=SimpleNamespace(prompt_token_count=12, candidates_token_count=7),
    )
    return client


@pytest.mark.parametrize(
    "config",
    [
        Settings(_env_file=None, OBSERVABILITY_ENABLED=False),
        Settings(_env_file=None, OBSERVABILITY_ENABLED=True),
        Settings(_env_file=None, OBSERVABILITY_ENABLED=True, LANGFUSE_PUBLIC_KEY="pk-test"),
    ],
)
def test_disabled_or_missing_credentials_preserves_resolution(
    config: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.schemas.resolution import CaseQuery
    from app.services.resolution_service import ResolutionService

    monkeypatch.setattr(obs, "_initialized", False)
    monkeypatch.setattr(obs, "_provider", None)
    query = CaseQuery(name=SENSITIVE[0])
    expected = ResolutionService().resolve(query)
    obs.initialize_observability(config)
    assert obs._provider is None
    assert ResolutionService().resolve(query) == expected
    assert GeminiExtractor(client=model_client()).extract_from_unstructured_text(SENSITIVE[5]).name


def test_gemini_safe_metadata_and_no_identity(capture: Any) -> None:
    _, exporter = capture
    GeminiExtractor(client=model_client()).extract_from_unstructured_text(" ".join(SENSITIVE))
    (span,) = exporter.get_finished_spans()
    assert span.name == "gemini.extract"
    assert span.attributes["gen_ai.provider.name"] == "google"
    assert span.attributes["gen_ai.request.model"].startswith("gemini-")
    assert span.attributes["gen_ai.usage.input_tokens"] == 12
    assert span.attributes["gen_ai.usage.output_tokens"] == 7
    assert span.attributes["structured_output.valid"] is True
    assert span.attributes["duration.ms"] >= 0
    assert_private([span])


def test_validation_failure_has_no_response_or_exception(capture: Any) -> None:
    with pytest.raises(GeminiExtractionError):
        GeminiExtractor(client=model_client(invalid=True)).extract_from_unstructured_text(
            SENSITIVE[5]
        )
    spans = capture[1].get_finished_spans()
    assert spans[0].attributes["structured_output.valid"] is False
    assert not spans[0].events
    assert not spans[0].status.description
    assert_private(spans)


class BrokenExporter(SpanExporter):
    def export(self, spans: Any) -> SpanExportResult:
        raise RuntimeError("unreachable exporter")

    def shutdown(self) -> None:
        raise RuntimeError("shutdown failed")


class BrokenQueue(SpanProcessor):
    def on_end(self, span: Any) -> None:
        raise RuntimeError("queue failed")

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        raise RuntimeError("flush failed")


@pytest.mark.parametrize("failure", ["export", "queue", "start", "annotate", "end"])
def test_telemetry_failure_cannot_change_domain_outcome(
    failure: str,
    capture: Any,
    monkeypatch: pytest.MonkeyPatch,
    graph_env: Any,
) -> None:
    provider, exporter = capture
    if failure == "export":
        provider.add_span_processor(SimpleSpanProcessor(BrokenExporter()))
    elif failure == "queue":
        provider.add_span_processor(BrokenQueue())
    elif failure == "start":
        monkeypatch.setattr(provider, "get_tracer", MagicMock(side_effect=RuntimeError("start")))
    elif failure == "annotate":
        from opentelemetry.sdk.trace import Span

        monkeypatch.setattr(Span, "set_attributes", MagicMock(side_effect=RuntimeError("attr")))
    else:
        from opentelemetry.sdk.trace import Span

        monkeypatch.setattr(Span, "end", MagicMock(side_effect=RuntimeError("end")))
    extracted = GeminiExtractor(client=model_client()).extract_from_unstructured_text(SENSITIVE[5])
    assert extracted.name == SENSITIVE[0]
    sessions, saver, run = graph_env
    execute_run(run.id, saver, sessions, FakeExtractor())
    with sessions() as db:
        assert db.get(InvestigationRun, run.id).status == "WAITING_FOR_HUMAN"
        assert db.get(Case, run.case_id).review_decision == "PENDING"
        job = Job(
            workspace_id=run.workspace_id,
            job_type="CSV_INGEST",
            payload="case_number,full_name\nFAIL-OPEN,Trace Example\n",
        )
        db.add(job)
        db.commit()
        job_id = job.id
    monkeypatch.setattr("app.tasks.SessionLocal", sessions)
    ingest_csv_job.apply(args=(job_id, run.workspace_id), throw=True)
    with sessions() as db:
        assert db.get(Job, job_id).status == "SUCCEEDED"
    # Domain exceptions must still reach their caller exactly once.
    with pytest.raises(ValueError, match="domain failure"):
        with obs.operation("review.decision"):
            raise ValueError("domain failure")
    assert_private(exporter.get_finished_spans())


def test_failed_csv_job_reports_domain_status(
    capture: Any, graph_env: Any, monkeypatch: Any
) -> None:
    sessions, _, run = graph_env
    monkeypatch.setattr("app.tasks.SessionLocal", sessions)
    with sessions() as db:
        job = Job(workspace_id=run.workspace_id, job_type="CSV_INGEST", payload="invalid csv")
        db.add(job)
        db.commit()
        job_id = job.id
    ingest_csv_job.apply(args=(job_id, run.workspace_id), throw=True)
    job_span = next(s for s in capture[1].get_finished_spans() if s.name == "job.execute")
    assert job_span.attributes["operation.status"] == "FAILED"
    with sessions() as db:
        assert db.get(Job, job_id).status == "FAILED"


def test_outcome_telemetry_never_reads_expired_orm_state(capture: Any, graph_env: Any) -> None:
    from sqlalchemy import event

    sessions, saver, run = graph_env
    sessions.configure(expire_on_commit=True)

    def committed(session: Any) -> None:
        if any(isinstance(row, InvestigationRun) for row in session.identity_map.values()):
            session.info["domain_committed"] = True

    def forbid_postcommit_read(state: Any) -> None:
        if state.session.info.get("domain_committed"):
            raise AssertionError("Telemetry performed a post-commit database read")

    event.listen(sessions.class_, "after_commit", committed)
    event.listen(sessions.class_, "do_orm_execute", forbid_postcommit_read)
    try:
        execute_run(run.id, saver, sessions, FakeExtractor())
    finally:
        event.remove(sessions.class_, "after_commit", committed)
        event.remove(sessions.class_, "do_orm_execute", forbid_postcommit_read)
    span = next(s for s in capture[1].get_finished_spans() if s.name == "investigation.run")
    assert span.attributes["operation.status"] == "WAITING_FOR_HUMAN"


def test_otlp_unreachable_and_langfuse_invalid_auth_do_not_break_model(
    capture: Any,
    monkeypatch: Any,
) -> None:
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider, _ = capture
    session = MagicMock()
    session.post.side_effect = ConnectionError("unreachable")
    exporter = OTLPSpanExporter(
        endpoint="http://127.0.0.1:1/v1/traces",
        timeout=0.01,
        session=session,
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
    client = Langfuse(
        public_key="pk-d3-failure",
        secret_key="sk-invalid",
        base_url="http://127.0.0.1:1",
        tracer_provider=provider,
        span_exporter=BrokenExporter(),
        should_export_span=obs.should_export_ai,
        mask_otel_spans=obs.mask_langfuse_spans,
    )
    assert GeminiExtractor(client=model_client()).extract_from_unstructured_text(SENSITIVE[5]).name
    provider.force_flush(timeout_millis=1000)
    client.flush()
    assert GeminiExtractor(client=model_client()).extract_from_unstructured_text(SENSITIVE[5]).name


def test_exporter_initialization_failure_is_optional(monkeypatch: pytest.MonkeyPatch) -> None:
    from opentelemetry.exporter.otlp.proto.http import trace_exporter

    monkeypatch.setattr(obs, "_initialized", False)
    monkeypatch.setattr(obs, "_provider", None)
    monkeypatch.setattr(obs.trace, "set_tracer_provider", lambda _: None)
    monkeypatch.setattr(trace_exporter, "OTLPSpanExporter", MagicMock(side_effect=RuntimeError()))
    monkeypatch.setattr(
        "langfuse.Langfuse", MagicMock(side_effect=RuntimeError("invalid credentials"))
    )
    obs.initialize_observability(
        Settings(
            _env_file=None,
            OBSERVABILITY_ENABLED=True,
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://127.0.0.1:1/v1/traces",
            LANGFUSE_PUBLIC_KEY="pk-test",
            LANGFUSE_SECRET_KEY="sk-test",
            LANGFUSE_BASE_URL="http://127.0.0.1:1",
        )
    )
    assert GeminiExtractor(client=model_client()).extract_from_unstructured_text(SENSITIVE[5]).name
    obs._provider.shutdown()


def test_initialization_uses_one_shared_provider(monkeypatch: Any) -> None:
    monkeypatch.setattr(obs, "_initialized", False)
    monkeypatch.setattr(obs, "_provider", None)
    monkeypatch.setattr(obs, "_langfuse", None)
    installed: list[Any] = []
    monkeypatch.setattr(obs.trace, "set_tracer_provider", installed.append)
    client = MagicMock()
    monkeypatch.setattr("langfuse.Langfuse", client)
    config = Settings(
        _env_file=None,
        OBSERVABILITY_ENABLED=True,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://127.0.0.1:1/v1/traces",
        LANGFUSE_PUBLIC_KEY="pk-test",
        LANGFUSE_SECRET_KEY="sk-test",
        LANGFUSE_BASE_URL="http://127.0.0.1:1",
    )
    obs.initialize_observability(config)
    obs.initialize_observability(config)
    assert installed == [obs._provider]
    assert client.call_count == 1
    assert client.call_args.kwargs["tracer_provider"] is installed[0]
    assert client.call_args.kwargs["should_export_span"] is obs.should_export_ai
    installed[0].shutdown()


def test_existing_global_provider_is_never_replaced(monkeypatch: Any, capture: Any) -> None:
    monkeypatch.setattr(obs, "_initialized", False)
    monkeypatch.setattr(obs, "_provider", None)
    monkeypatch.setattr(obs.trace, "get_tracer_provider", lambda: capture[0])
    install = MagicMock()
    monkeypatch.setattr(obs.trace, "set_tracer_provider", install)
    obs.initialize_observability(
        Settings(
            _env_file=None,
            OBSERVABILITY_ENABLED=True,
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://127.0.0.1:1/v1/traces",
        )
    )
    install.assert_not_called()


def test_langfuse_actual_v4_processor_filter_and_mask(capture: Any) -> None:
    provider, exporter = capture
    langfuse_exporter = InMemorySpanExporter()
    # Explicit local fake transport: no Langfuse Cloud connection or auth check.
    client = Langfuse(
        public_key="pk-d3-local",
        secret_key="sk-d3-local",
        base_url="http://127.0.0.1:1",
        tracer_provider=provider,
        span_exporter=langfuse_exporter,
        should_export_span=obs.should_export_ai,
        mask_otel_spans=obs.mask_langfuse_spans,
    )
    with obs.operation("job.execute", **{"job.type": "INVESTIGATION"}):
        with obs.operation("gemini.extract", **{"gen_ai.provider.name": "google"}):
            trace.get_current_span().set_attribute("gen_ai.input.messages", " ".join(SENSITIVE))
            trace.get_current_span().add_event(SENSITIVE[5], {"email": SENSITIVE[1]})
            trace.get_current_span().set_status(trace.Status(trace.StatusCode.ERROR, SENSITIVE[5]))
    with provider.get_tracer("third.party").start_as_current_span(SENSITIVE[0]) as span:
        span.set_attribute("gen_ai.prompt", SENSITIVE[5])
    client.flush()
    spans = langfuse_exporter.get_finished_spans()
    assert [s.name for s in spans] == ["gemini.extract"]
    assert_private(spans)
    assert_private(exporter.get_finished_spans())
    # Exercise the v4 export-stage mask independently of the upstream scrubber.
    from langfuse._client.span_exporter import LangfuseTransformingSpanExporter

    raw = list(exporter.get_finished_spans())[0]
    raw._attributes = {"gen_ai.prompt": SENSITIVE[5], "gen_ai.provider.name": "google"}
    masked_exporter = InMemorySpanExporter()
    transforming = LangfuseTransformingSpanExporter(
        exporter=masked_exporter,
        media_manager=None,
        mask_otel_spans=obs.mask_langfuse_spans,
    )
    transforming.export([raw])
    assert masked_exporter.get_finished_spans()[0].attributes == {"gen_ai.provider.name": "google"}


@pytest.mark.parametrize("decision", [ReviewDecision.ACCEPTED, ReviewDecision.REJECTED])
def test_review_behavior_survives_telemetry_failure(
    decision: Any, capture: Any, graph_env: Any
) -> None:
    sessions, _, run = graph_env
    capture[0].add_span_processor(BrokenQueue())
    with sessions() as db:
        candidate = db.scalar(select(CandidateRecord).where(CandidateRecord.case_id == run.case_id))
        request = DecisionRequest(
            decision=decision,
            notes=SENSITIVE[5],
            selected_candidate_id=candidate.id if decision == ReviewDecision.ACCEPTED else None,
        )
        result = record_decision(db, run.workspace_id, run.case_id, request, SENSITIVE[6])
        assert result.review_decision == decision
        assert result.reviewer_notes == SENSITIVE[5]
        assert db.get(Case, run.case_id).routing_status == "NEEDS_REVIEW"
    assert_private(capture[1].get_finished_spans())


def test_celery_job_status_retries_and_safe_headers(
    capture: Any, graph_env: Any, monkeypatch: Any
) -> None:
    from app import tasks

    sessions, _, run = graph_env
    monkeypatch.setattr(tasks, "SessionLocal", sessions)
    with sessions() as db:
        job = Job(
            workspace_id=run.workspace_id,
            job_type="CSV_INGEST",
            source_label=SENSITIVE[5],
            payload="case_number,full_name\nD3,Trace Example\n",
        )
        db.add(job)
        db.commit()
        job_id = job.id
    with obs.operation("api.job.enqueue"):
        parent = trace.get_current_span().get_span_context()
        headers: dict[str, str] = {}
        signals.publish(headers=headers)
    assert set(headers) == {"traceparent"}
    assert SENSITIVE[6] not in str(headers)
    ingest_csv_job.apply(args=(job_id, run.workspace_id), headers=headers, retries=2, throw=True)
    spans = capture[1].get_finished_spans()
    job_span = next(s for s in spans if s.name == "job.execute")
    assert job_span.parent.span_id == parent.span_id
    assert job_span.context.trace_id == parent.trace_id
    assert job_span.attributes["job.retries"] == 2
    assert job_span.attributes["operation.status"] == "SUCCEEDED"
    assert job_span.attributes["job.type"] == "CSV_INGEST"
    with sessions() as db:
        assert db.get(Job, job_id).status == "SUCCEEDED"
    assert_private(spans)
    assert (
        obs.parent_context({"traceparent": SENSITIVE[6], "baggage": SENSITIVE[0]})
        == context.Context()
    )


def test_async_investigation_celery_graph_mcp_gemini_trace(
    capture: Any,
    graph_env: Any,
    monkeypatch: Any,
) -> None:
    """Actual asynchronous local Celery worker, embedded MCP and fake Gemini transport."""
    import mcp.shared._otel as mcp_otel

    from app.services import investigation_graph, investigation_service

    # Exercise MCP's built-in OTel with the same scope policy as production.
    monkeypatch.setattr(mcp_otel, "_tracer", capture[0].get_tracer("mcp"))

    sessions, _, run = graph_env
    original_execute = investigation_service.execute_run
    monkeypatch.setattr(
        investigation_service,
        "execute_run",
        lambda run_id, saver: original_execute(run_id, saver, sessions),
    )
    client = model_client()
    client.models.generate_content.side_effect = [
        SimpleNamespace(
            text='{"category":"missing_phone","operation":"HUMAN_INPUT"}', usage_metadata=None
        ),
        # Source-grounded facts from the existing approved synthetic artifact.
        SimpleNamespace(
            text=json.dumps(
                {
                    "name": SENSITIVE[0],
                    "phone": SENSITIVE[2],
                    "employer": SENSITIVE[3],
                    "location": SENSITIVE[4],
                }
            ),
            usage_metadata=SimpleNamespace(prompt_token_count=20, candidates_token_count=9),
        ),
    ]
    monkeypatch.setattr(
        investigation_graph, "GeminiExtractor", lambda: GeminiExtractor(client=client)
    )
    finished = threading.Event()

    class Completion(SpanProcessor):
        def on_end(self, span: Any) -> None:
            if span.name == "job.execute":
                finished.set()

    capture[0].add_span_processor(Completion())
    # Celery's environment variable overrides even an explicit broker argument.
    # Keep this verification local when the service integration gate sets Redis.
    monkeypatch.setenv("CELERY_BROKER_URL", "memory://")
    local = Celery("d3-local", broker="memory://")
    local.conf.update(task_ignore_result=True, task_serializer="json", accept_content=["json"])
    task = local.task(name=investigate_evidence.name)(investigate_evidence.run)
    with start_worker(local, pool="solo", perform_ping_check=False, shutdown_timeout=10):
        with obs.operation("api.investigation.start"):
            root = trace.get_current_span().get_span_context()
            task.delay(run.id)
        assert finished.wait(10)
        finished.clear()
        with obs.operation("api.investigation.resume"):
            with sessions() as db:
                current = db.get(InvestigationRun, run.id)
                assert current.status == "WAITING_FOR_HUMAN"
                queue_resume(db, current, HumanResponse(action="RETRIEVE_SYNTHETIC_NOTES"))
            task.delay(run.id)
        assert finished.wait(10)
        finished.clear()
        with obs.operation("api.investigation.resume"):
            with sessions() as db:
                queue_resume(db, db.get(InvestigationRun, run.id), HumanResponse(action="STOP"))
            task.delay(run.id)
        assert finished.wait(10)
    spans = capture[1].get_finished_spans()
    names = {s.name for s in spans}
    assert {
        "job.execute",
        "investigation.run",
        "investigation.plan",
        "investigation.retrieve",
        "investigation.analyze",
        "investigation.human",
        "mcp.tool",
        "gemini.extract",
        "gemini.evidence_gap",
        "investigation.resume",
    } <= names
    first_job = next(s for s in spans if s.name == "job.execute")
    assert first_job.context.trace_id == root.trace_id
    assert first_job.parent.span_id == root.span_id
    by_id = {s.context.span_id: s for s in spans}
    for span in spans:
        if span.name == "gemini.extract":
            assert by_id[span.parent.span_id].name == "mcp.tool"
        if span.name == "mcp.tool":
            assert by_id[span.parent.span_id].name.startswith("investigation.")
    assert any(s.attributes.get("investigation.interrupted") for s in spans)
    assert any(s.attributes.get("investigation.resumed") for s in spans)
    assert any(s.attributes.get("investigation.outcome") == "HUMAN_REVIEW_REQUIRED" for s in spans)
    assert any(s.attributes.get("mcp.tool.name") == "retrieve_synthetic_notes" for s in spans)
    with sessions() as db:
        assert db.get(InvestigationRun, run.id).status == "SUCCEEDED"
        assert db.get(Case, run.case_id).review_decision == "PENDING"
    assert_private(spans)
