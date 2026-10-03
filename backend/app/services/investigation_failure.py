"""Safe investigation failures, attributed at the checkpoint boundary."""

from collections.abc import Iterator
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver

from app.services.extractor import GeminiExtractionError
from app.services.investigation_mcp import MCPToolFailure


class CheckpointUnavailable(RuntimeError):
    """A saver operation failed, without retaining its private exception."""


class GovernedCheckpointer(BaseCheckpointSaver[Any]):
    def __init__(self, saver: BaseCheckpointSaver[Any]) -> None:
        super().__init__(serde=saver.serde)
        self.saver = saver

    def _call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        try:
            return getattr(self.saver, name)(*args, **kwargs)
        except Exception:
            raise CheckpointUnavailable("Investigation checkpoint unavailable.") from None

    def get_tuple(self, *args: Any, **kwargs: Any) -> Any:
        return self._call("get_tuple", *args, **kwargs)

    def list(self, *args: Any, **kwargs: Any) -> Iterator[Any]:
        try:
            yield from self.saver.list(*args, **kwargs)
        except Exception:
            raise CheckpointUnavailable("Investigation checkpoint unavailable.") from None

    def put(self, *args: Any, **kwargs: Any) -> Any:
        return self._call("put", *args, **kwargs)

    def put_writes(self, *args: Any, **kwargs: Any) -> None:
        self._call("put_writes", *args, **kwargs)

    def get_next_version(self, *args: Any, **kwargs: Any) -> Any:
        return self._call("get_next_version", *args, **kwargs)


def investigation_failure(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, CheckpointUnavailable):
        return (
            "CHECKPOINT_UNAVAILABLE",
            "We could not save or restore this investigation. Please try again.",
        )
    if isinstance(exc, GeminiExtractionError) or (
        isinstance(exc, MCPToolFailure) and exc.error.category == "provider_failure"
    ):
        retryable = exc.retryable if isinstance(exc, GeminiExtractionError) else exc.error.retryable
        if retryable:
            return (
                "PROVIDER_TEMPORARY_FAILURE",
                "Evidence lookup is temporarily unavailable. You can try the investigation again.",
            )
        return "PROVIDER_PERMANENT_FAILURE", "We could not complete the evidence lookup."
    if isinstance(exc, MCPToolFailure):
        return "EVIDENCE_OPERATION_FAILED", "We could not complete the evidence lookup."
    return "INVESTIGATION_FAILED", "We could not complete this investigation. Please try again."
