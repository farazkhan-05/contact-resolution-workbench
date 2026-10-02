"""Celery's standard signals carry only W3C traceparent, never baggage or payloads."""

from typing import Any

from celery.signals import before_task_publish, task_postrun, task_prerun
from opentelemetry import context

from app.core.config import settings
from app.core.observability import (
    annotate,
    initialize_observability,
    operation,
    parent_context,
    trace_headers,
)

TASK_TYPES = {
    "app.tasks.ingest_source_job": "SOURCE_INGEST",
    "app.tasks.ingest_csv_job": "CSV_INGEST",
    "app.tasks.ingest_unstructured_job": "UNSTRUCTURED_INGEST",
    "app.tasks.investigate_evidence": "INVESTIGATION",
}


def publish(headers: dict[str, Any] | None = None, **kwargs: Any) -> None:
    try:
        if headers is not None:
            headers.update(trace_headers())
    except Exception:
        pass


def begin(task: Any = None, **kwargs: Any) -> None:
    token = None
    try:
        if task is None or task.name not in TASK_TYPES:
            return
        initialize_observability(settings)
        token = context.attach(parent_context(task.request.headers or {}))
        manager = operation(
            "job.execute",
            **{
                "job.type": TASK_TYPES[task.name],
                "job.retries": task.request.retries,
            },
        )
        manager.__enter__()
        task.request._observability = (manager, token)
    except Exception:
        if token is not None:
            context.detach(token)


def finish(task: Any = None, state: str | None = None, **kwargs: Any) -> None:
    try:
        saved = getattr(task.request, "_observability", None)
    except Exception:
        return
    if saved is None:
        return
    manager, token = saved
    try:
        # Domain tasks can report FAILED despite returning normally to Celery.
        from opentelemetry import trace

        current = trace.get_current_span()
        attributes = getattr(current, "attributes", {}) or {}
        if "operation.status" not in attributes:
            annotate(**{"operation.status": state})
    except Exception:
        pass
    finally:
        try:
            manager.__exit__(None, None, None)
        except Exception:
            pass
        try:
            context.detach(token)
        except Exception:
            pass
        try:
            del task.request._observability
        except Exception:
            pass


def register_signals() -> None:
    before_task_publish.connect(publish, weak=False)
    task_prerun.connect(begin, weak=False)
    task_postrun.connect(finish, weak=False)
