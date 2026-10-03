"""Safe provider classifications; never retain provider messages or evidence."""

import math
from typing import Any

import httpx
from billiard.exceptions import SoftTimeLimitExceeded
from google.genai.errors import APIError

TEMPORARY_MESSAGE = "Evidence extraction is temporarily unavailable. Please try again."
BUSY_MESSAGE = "Evidence extraction is busy right now. Please try again shortly."


class GeminiExtractionError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str = "PROVIDER_REJECTED",
        retryable: bool = False,
        http_status: int | None = None,
        max_attempts: int = 3,
        retry_after: float = 0,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.http_status = http_status
        self.max_attempts = max_attempts
        self.retry_after = retry_after

    @property
    def public_message(self) -> str:
        if self.code == "RATE_LIMITED":
            return BUSY_MESSAGE
        if self.code in {"PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"} or self.retryable:
            return TEMPORARY_MESSAGE
        if self.code in {"EXTRACTION_SCHEMA_INVALID", "EXTRACTION_MALFORMED_OUTPUT"}:
            return "Could not extract evidence. Please check the text and try again."
        return "Evidence extraction is unavailable. Please try again later."


def classify_provider_error(exc: Exception) -> GeminiExtractionError:
    status = exc.code if isinstance(exc, APIError) else None
    code, retryable, attempts, retry_after = "PROVIDER_REJECTED", False, 3, 0.0
    if isinstance(exc, SoftTimeLimitExceeded):
        code = "PROVIDER_TIMEOUT"
    elif status in {401, 403}:
        code = "PROVIDER_AUTH_ERROR"
    elif status == 402:
        code = "PROVIDER_QUOTA_EXHAUSTED"
    elif status == 429:
        code, retryable, attempts = "RATE_LIMITED", True, 2
        payload: Any = exc.details if isinstance(exc, APIError) else {}
        if isinstance(payload, dict):
            payload = payload.get("error", payload)
        details = payload.get("details", []) if isinstance(payload, dict) else []
        for detail in details if isinstance(details, list) else []:
            if not isinstance(detail, dict):
                continue
            kind = detail.get("@type", "")
            if kind == "type.googleapis.com/google.rpc.QuotaFailure":
                violations = detail.get("violations", [])
                for violation in violations if isinstance(violations, list) else []:
                    if not isinstance(violation, dict):
                        continue
                    quota_id = str(violation.get("quotaId", "")).lower()
                    if (
                        "perday" in quota_id
                        or "daily" in quota_id
                        or str(violation.get("quotaValue", "")) == "0"
                    ):
                        code, retryable = "PROVIDER_QUOTA_EXHAUSTED", False
                    elif "perminute" in quota_id or "persecond" in quota_id:
                        attempts = 3
            elif kind == "type.googleapis.com/google.rpc.ErrorInfo":
                if detail.get("reason") in {
                    "BILLING_DISABLED",
                    "BILLING_NOT_ACTIVE",
                    "PAYMENT_REQUIRED",
                    "DAILY_LIMIT_EXCEEDED",
                    "INSUFFICIENT_CREDITS",
                }:
                    code, retryable = "PROVIDER_QUOTA_EXHAUSTED", False
            elif kind == "type.googleapis.com/google.rpc.RetryInfo":
                value = str(detail.get("retryDelay", ""))
                try:
                    delay = float(value.removesuffix("s"))
                    if math.isfinite(delay) and delay >= 0:
                        retry_after = max(retry_after, delay)
                except ValueError:
                    pass
        response = exc.response if isinstance(exc, APIError) else None
        if response is not None:
            try:
                delay = float(response.headers.get("retry-after", "0"))
                if math.isfinite(delay) and delay >= 0:
                    retry_after = max(retry_after, delay)
            except (ValueError, AttributeError):
                pass
    elif status in {408, 504} or isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        code, retryable = "PROVIDER_TIMEOUT", True
    elif status in {500, 502, 503} or isinstance(exc, (httpx.NetworkError, ConnectionError)):
        code, retryable = "PROVIDER_UNAVAILABLE", True
    return GeminiExtractionError(
        "Evidence provider request failed.",
        code=code,
        retryable=retryable,
        http_status=status,
        max_attempts=attempts,
        retry_after=retry_after,
    )
