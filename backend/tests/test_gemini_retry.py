import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from billiard.exceptions import SoftTimeLimitExceeded
from google.genai.errors import ClientError, ServerError

from app.core.config import Settings
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.gemini_failure import classify_provider_error


def quota_error(quota_id: str, value: str = "10") -> ClientError:
    return ClientError(
        429,
        {
            "error": {
                "status": "RESOURCE_EXHAUSTED",
                "details": [
                    {
                        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                        "violations": [{"quotaId": quota_id, "quotaValue": value}],
                    }
                ],
            }
        },
    )


@pytest.mark.parametrize(
    "exc,code,retryable",
    [
        (ClientError(408, {}), "PROVIDER_TIMEOUT", True),
        (ServerError(503, {}), "PROVIDER_UNAVAILABLE", True),
        (ServerError(504, {}), "PROVIDER_TIMEOUT", True),
        (httpx.ReadTimeout("sensitive text"), "PROVIDER_TIMEOUT", True),
        (httpx.ConnectError("sensitive text"), "PROVIDER_UNAVAILABLE", True),
        (ClientError(400, {}), "PROVIDER_REJECTED", False),
        (ClientError(401, {}), "PROVIDER_AUTH_ERROR", False),
        (ClientError(403, {}), "PROVIDER_AUTH_ERROR", False),
        (ClientError(402, {}), "PROVIDER_QUOTA_EXHAUSTED", False),
        (ServerError(501, {}), "PROVIDER_REJECTED", False),
        (
            quota_error("GenerateRequestsPerDayPerProjectPerModel-FreeTier"),
            "PROVIDER_QUOTA_EXHAUSTED",
            False,
        ),
        (
            quota_error("GenerateRequestsPerMinutePerProjectPerModel", "0"),
            "PROVIDER_QUOTA_EXHAUSTED",
            False,
        ),
        (quota_error("GenerateRequestsPerMinutePerProjectPerModel"), "RATE_LIMITED", True),
    ],
)
def test_provider_classification(exc: Exception, code: str, retryable: bool) -> None:
    result = classify_provider_error(exc)
    assert result.code == code and result.retryable is retryable
    assert "sensitive text" not in str(result)


def test_unknown_429_is_more_conservative_than_known_minute_limit() -> None:
    assert classify_provider_error(ClientError(429, {})).max_attempts == 2
    assert classify_provider_error(quota_error("RequestsPerMinute")).max_attempts == 3


def test_billing_metadata_overrides_retry_hint() -> None:
    error = ClientError(
        429,
        {
            "error": {
                "details": [
                    {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "1s"},
                    {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        "reason": "BILLING_DISABLED",
                    },
                ]
            }
        },
    )
    assert classify_provider_error(error).code == "PROVIDER_QUOTA_EXHAUSTED"
    assert not classify_provider_error(error).retryable


def test_long_provider_cooldown_is_not_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    client = MagicMock()
    client.models.generate_content.side_effect = ClientError(
        429,
        {
            "error": {
                "details": [
                    {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "40s"},
                ]
            }
        },
    )
    sleep = MagicMock()
    monkeypatch.setattr("app.services.extractor.time.sleep", sleep)
    with pytest.raises(GeminiExtractionError, match="provider request failed"):
        GeminiExtractor(client=client).extract_from_unstructured_text(
            "Synthetic", retry_transient=True
        )
    assert client.models.generate_content.call_count == 1
    sleep.assert_not_called()


def test_configured_timeout_and_no_nested_sdk_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("GEMINI_TIMEOUT_SECONDS", "30")
    config = Settings(_env_file=None)
    factory = MagicMock()
    monkeypatch.setattr("app.services.extractor.genai.Client", factory)
    GeminiExtractor(
        api_key=config.GEMINI_API_KEY, timeout=config.GEMINI_TIMEOUT_SECONDS
    )._get_client()
    options = factory.call_args.kwargs["http_options"]
    assert options.timeout == 30000
    assert options.retry_options.attempts == 1


def test_missing_key_never_calls_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.services.extractor.settings.GEMINI_API_KEY", None)
    factory = MagicMock()
    monkeypatch.setattr("app.services.extractor.genai.Client", factory)
    with pytest.raises(GeminiExtractionError) as caught:
        GeminiExtractor().extract_from_unstructured_text("Synthetic", retry_transient=True)
    assert caught.value.code == "PROVIDER_CONFIGURATION_ERROR"
    factory.assert_not_called()


def test_retry_logs_never_include_provider_message_or_evidence(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    evidence = "Leyla Demo Karaca leyla@demo.example 905550008877"
    secret = "synthetic-do-not-log-key"
    client = MagicMock()
    client.models.generate_content.side_effect = ServerError(
        504,
        {
            "error": {"status": "DEADLINE_EXCEEDED", "message": evidence + secret},
        },
    )
    delays = []
    monkeypatch.setattr("app.services.extractor.time.sleep", delays.append)
    monkeypatch.setattr("app.services.extractor.random.uniform", lambda low, high: high)
    with caplog.at_level(logging.INFO), pytest.raises(GeminiExtractionError):
        GeminiExtractor(client=client, api_key=secret).extract_from_unstructured_text(
            evidence, retry_transient=True
        )
    assert delays == [2, 4]
    assert client.models.generate_content.call_count == 3
    assert "category=PROVIDER_TIMEOUT" in caplog.text
    assert "retry_scheduled=True" in caplog.text and "outcome=failed" in caplog.text
    assert not any(value in caplog.text for value in (evidence, secret, "leyla@demo.example"))


def test_safety_block_does_not_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    client = MagicMock()
    client.models.generate_content.return_value = SimpleNamespace(
        text=None, prompt_feedback=SimpleNamespace(block_reason="SAFETY"), candidates=[]
    )
    sleep = MagicMock()
    monkeypatch.setattr("app.services.extractor.time.sleep", sleep)
    with pytest.raises(GeminiExtractionError) as caught:
        GeminiExtractor(client=client).extract_from_unstructured_text(
            "Synthetic", retry_transient=True
        )
    assert caught.value.code == "PROVIDER_CONTENT_BLOCKED"
    assert client.models.generate_content.call_count == 1
    sleep.assert_not_called()


def test_soft_deadline_during_backoff_is_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.tasks import ingest_unstructured_job

    client = MagicMock()
    client.models.generate_content.side_effect = ServerError(504, {})
    monkeypatch.setattr(
        "app.services.extractor.time.sleep", MagicMock(side_effect=SoftTimeLimitExceeded())
    )
    with pytest.raises(GeminiExtractionError) as caught:
        GeminiExtractor(client=client).extract_from_unstructured_text(
            "Synthetic", retry_transient=True
        )
    assert caught.value.code == "PROVIDER_TIMEOUT"
    assert not caught.value.retryable
    assert client.models.generate_content.call_count == 1
    assert ingest_unstructured_job.soft_time_limit == 100
    assert ingest_unstructured_job.time_limit == 110
