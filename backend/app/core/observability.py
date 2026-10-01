"""Optional manual tracing. Identity content never enters the export contract."""

import re
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from functools import wraps
from time import perf_counter
from typing import Any, ParamSpec, TypeVar

from opentelemetry import context, trace
from opentelemetry.context import Context
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.util.types import Attributes

from app.core.config import Settings

SCOPE = "workbench.observability"
AI_SPANS = frozenset(
    {
        "investigation.run",
        "investigation.resume",
        "investigation.plan",
        "investigation.retrieve",
        "investigation.analyze",
        "investigation.human",
        "mcp.tool",
        "gemini.extract",
        "gemini.evidence_gap",
    }
)
SPAN_NAMES = AI_SPANS | {
    "review.decision",
    "job.execute",
    "api.investigation.start",
    "api.investigation.resume",
    "api.job.enqueue",
}
ENUMS: dict[str, set[str]] = {
    "gen_ai.provider.name": {"google"},
    "gen_ai.operation.name": {"extract", "evidence_gap"},
    "langfuse.observation.type": {"generation", "agent", "tool", "span"},
    "workflow.node": {"plan", "retrieve", "analyze", "human"},
    "mcp.tool.name": {
        "get_resolution_case",
        "get_case_evidence",
        "retrieve_candidate",
        "retrieve_synthetic_notes",
        "request_human_review",
        "unavailable",
    },
    "job.type": {"CSV_INGEST", "UNSTRUCTURED_INGEST", "INVESTIGATION"},
    "operation.status": {
        "SUCCEEDED",
        "FAILED",
        "PENDING",
        "RUNNING",
        "WAITING_FOR_HUMAN",
        "SUCCESS",
        "FAILURE",
        "RETRY",
        "REVOKED",
        "IGNORED",
    },
    "investigation.outcome": {
        "EVIDENCE_READY",
        "HUMAN_REVIEW_REQUIRED",
        "PROVIDER_UNAVAILABLE",
        "INSUFFICIENT_EVIDENCE",
    },
    "review.decision": {"ACCEPTED", "REJECTED", "NEED_MORE_EVIDENCE", "PENDING"},
}
NUMBERS = {
    "duration.ms",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "job.retries",
    "model.retries",
}
BOOLEANS = {
    "structured_output.valid",
    "model.fallback",
    "investigation.interrupted",
    "investigation.resumed",
}


def safe_attributes(attributes: Mapping[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in attributes.items():
        if key in ENUMS and isinstance(value, str) and value in ENUMS[key]:
            result[key] = value
        elif key in NUMBERS and type(value) in (int, float) and 0 <= value < 10**12:
            result[key] = value
        elif key in BOOLEANS and type(value) is bool:
            result[key] = value
        elif key == "gen_ai.request.model" and isinstance(value, str):
            # Only Gemini model identifiers; configuration cannot become arbitrary content.
            if re.fullmatch(r"gemini-[a-z0-9.-]{1,70}", value):
                result[key] = value
    return result


def should_export_ai(span: ReadableSpan) -> bool:
    return bool(
        span.instrumentation_scope
        and span.instrumentation_scope.name == SCOPE
        and span.name in AI_SPANS
    )


def mask_langfuse_spans(*, params: Any) -> Any:
    from langfuse.types import MaskOtelSpansResult, OtelSpanPatch

    return MaskOtelSpansResult(
        span_patches={
            identifier: OtelSpanPatch(
                delete_attributes=tuple(span.attributes),
                set_attributes=safe_attributes(span.attributes),
            )
            for identifier, span in params.spans.items()
        }
    )


class SafeProcessor(SpanProcessor):
    """Guard queues/exporters and sanitize before either backend sees a span."""

    def __init__(self, delegate: SpanProcessor, resource: Resource) -> None:
        self.delegate = delegate
        self.resource = resource

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        # No third-party baggage propagation or input/output capture.
        pass

    def on_end(self, span: ReadableSpan) -> None:
        try:
            if not span.instrumentation_scope or span.instrumentation_scope.name != SCOPE:
                return
            if span.name not in SPAN_NAMES:
                return
            clean = ReadableSpan(
                name=span.name,
                context=span.context,
                parent=span.parent,
                resource=self.resource,
                attributes=safe_attributes(span.attributes or {}),
                start_time=span.start_time,
                end_time=span.end_time,
                instrumentation_scope=span.instrumentation_scope,
                status=Status(span.status.status_code),
            )
            self.delegate.on_end(clean)
        except Exception:
            pass

    def shutdown(self) -> None:
        try:
            self.delegate.shutdown()
        except Exception:
            pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        try:
            return self.delegate.force_flush(timeout_millis)
        except Exception:
            return False


class SafeTracerProvider(TracerProvider):
    def get_tracer(
        self,
        instrumenting_module_name: str,
        instrumenting_library_version: str | None = None,
        schema_url: str | None = None,
        attributes: Attributes = None,
    ) -> trace.Tracer:
        # Manual scopes only. MCP's built-in OTel spans must not capture inputs or
        # create unexported intermediate parents in the application trace tree.
        if instrumenting_module_name != SCOPE:
            return trace.NoOpTracer()
        return super().get_tracer(
            instrumenting_module_name,
            instrumenting_library_version,
            schema_url,
            attributes,
        )

    def add_span_processor(self, span_processor: SpanProcessor) -> None:
        super().add_span_processor(SafeProcessor(span_processor, self.resource))


_provider: TracerProvider | None = None
_initialized = False
_langfuse: Any = None


def initialize_observability(config: Settings) -> None:
    """Called once per API/worker process; no backend credentials are necessary."""
    global _provider, _initialized, _langfuse
    if _initialized:
        return
    _initialized = True
    if not config.OBSERVABILITY_ENABLED:
        return
    has_langfuse = bool(
        config.LANGFUSE_PUBLIC_KEY and config.LANGFUSE_SECRET_KEY and config.LANGFUSE_BASE_URL
    )
    if not config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and not has_langfuse:
        return
    try:
        if not isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider):
            # Never compete with an already installed global provider.
            return
        # Resource() deliberately avoids host/process/environment resource detectors.
        resource = Resource(
            {
                "service.name": _safe_label(
                    config.OTEL_SERVICE_NAME, "contact-resolution-workbench"
                ),
                "deployment.environment.name": _safe_label(
                    config.OBSERVABILITY_ENVIRONMENT, "local"
                ),
            }
        )
        provider = SafeTracerProvider(resource=resource)
        _provider = provider
        trace.set_tracer_provider(provider)
    except Exception:
        _provider = None
        return
    if config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

            provider.add_span_processor(
                BatchSpanProcessor(
                    OTLPSpanExporter(
                        endpoint=config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
                        timeout=2,
                    )
                )
            )
        except Exception:
            pass
    if has_langfuse:
        try:
            from langfuse import Langfuse

            # v4 attaches its LangfuseSpanProcessor to this existing provider.
            _langfuse = Langfuse(
                public_key=config.LANGFUSE_PUBLIC_KEY,
                secret_key=config.LANGFUSE_SECRET_KEY,
                base_url=config.LANGFUSE_BASE_URL,
                tracer_provider=provider,
                timeout=2,
                should_export_span=should_export_ai,
                mask_otel_spans=mask_langfuse_spans,
            )
        except Exception:
            pass


def _safe_label(value: str, default: str) -> str:
    return value if re.fullmatch(r"[a-z][a-z0-9-]{0,63}", value) else default


def annotate(**attributes: Any) -> None:
    try:
        trace.get_current_span().set_attributes(safe_attributes(attributes))
    except Exception:
        pass


@contextmanager
def operation(name: str, **attributes: Any) -> Iterator[None]:
    """Telemetry setup/cleanup cannot catch, replace, or re-run domain execution."""
    span = None
    token = None
    started = perf_counter()
    try:
        if _provider is not None and name in SPAN_NAMES:
            span = _provider.get_tracer(SCOPE).start_span(
                name, attributes=safe_attributes(attributes)
            )
            token = context.attach(trace.set_span_in_context(span))
    except Exception:
        pass
    try:
        yield
    except BaseException:
        if span is not None:
            try:
                span.set_status(StatusCode.ERROR)
            except Exception:
                pass
        raise
    finally:
        if span is not None:
            try:
                span.set_attribute("duration.ms", (perf_counter() - started) * 1000)
                span.end()
            except Exception:
                pass
        if token is not None:
            try:
                context.detach(token)
            except Exception:
                pass


P = ParamSpec("P")
R = TypeVar("R")


def traced(name: str, **attributes: Any) -> Callable[[Callable[P, R]], Callable[P, R]]:
    def decorate(function: Callable[P, R]) -> Callable[P, R]:
        @wraps(function)
        def wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
            with operation(name, **attributes):
                return function(*args, **kwargs)

        return wrapped

    return decorate


def trace_headers() -> dict[str, str]:
    try:
        if _provider is None:
            return {}
        carrier: dict[str, str] = {}
        TraceContextTextMapPropagator().inject(carrier)
        return {"traceparent": carrier["traceparent"]} if "traceparent" in carrier else {}
    except Exception:
        return {}


def parent_context(headers: Mapping[str, Any]) -> Context:
    value = headers.get("traceparent")
    if isinstance(value, str) and re.fullmatch(r"00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}", value):
        return TraceContextTextMapPropagator().extract({"traceparent": value})
    return Context()
