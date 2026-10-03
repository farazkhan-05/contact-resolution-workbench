Gemini extraction retry contract

Ordinary unstructured ingestion opts into provider-call retries inside its claimed
Celery task. The Job remains RUNNING throughout all attempts. Google SDK retries
remain disabled (`attempts=1`), so there is no nested retry multiplier. Resolution
and Case persistence run only after one schema-valid, usable extraction. Duplicate
deliveries cannot claim a RUNNING or terminal Job; the workspace/case-number unique
constraint remains in place. Investigation behavior is not opted into this policy.

The policy allows three total attempts for HTTP 408, 500, 502, 503, 504 and HTTPX
timeout/network failures. Unknown 429 responses allow two total attempts. Structured
`google.rpc.QuotaFailure` per-minute/per-second limits allow three; per-day/daily
limits or zero allocation, billing/payment/credit `ErrorInfo` and HTTP 402 do not
retry. HTTP 400/401/403/404/501, validation failures, malformed output, empty evidence
and safety blocks do not retry. Raw Google exception strings are never logged or
returned to users; SDK error bodies are inspected only for structured classification.

Backoff uses random uniform delays of 1–2 seconds, then 2–4 seconds. Numeric
`Retry-After` and protobuf `RetryInfo.retryDelay` are respected when they fit the
four-second delay cap. A longer cooldown fails cleanly rather than retrying early
or holding the worker for a long chain. Unknown resource exhaustion never causes
automatic billing or quota changes.

Production retains `gemini-3.1-flash-lite` and `GEMINI_TIMEOUT_SECONDS=30` on the
worker. Three provider deadlines plus backoff give a nominal 96-second budget.
HTTP transport phases/overhead can extend that nominal bound; the prefork Celery
task has a 100-second soft limit, converted into a terminal safe timeout, and a
110-second hard safety limit. Hard process termination cannot promise database
cleanup if the worker/database itself is unavailable; that is an existing worker
recovery limitation, not an unlimited provider retry. Other ingestion tasks and
their retry policies are unchanged.

Durable failure codes distinguish RATE_LIMITED, PROVIDER_TIMEOUT,
PROVIDER_UNAVAILABLE, PROVIDER_AUTH_ERROR, PROVIDER_CONFIGURATION_ERROR,
PROVIDER_QUOTA_EXHAUSTED, PROVIDER_REJECTED, PROVIDER_CONTENT_BLOCKED,
EXTRACTION_MALFORMED_OUTPUT, EXTRACTION_SCHEMA_INVALID and INVALID_EXTRACTION.
Transient exhaustion uses a short try-again message; rate limiting uses a busy
message; no-person evidence uses “No useful contact evidence was found in this
text.” The UI displays “Could not extract evidence” without provider or worker
implementation details.

Provider logs contain attempt, category, numeric HTTP status, retry decision,
bounded delay, outcome and duration. They exclude evidence, names, contact fields,
credentials, headers and complete exceptions. Deterministic tests cover recovery,
exhaustion, terminal errors, quota/billing details, cooldowns, soft deadlines,
privacy, Unicode persistence and duplicate delivery during/after retries. Tests
mock provider calls and sleeps; CI requires no Gemini key.

The policy follows [Google retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting)
and [error guidance](https://ai.google.dev/gemini-api/docs/api-errors), checked
3 October 2026. The installed
[google-genai 2.25.0 error implementation](https://raw.githubusercontent.com/googleapis/python-genai/v2.25.0/google/genai/errors.py)
exposes HTTP code, provider status, original response and structured details through
`ClientError`/`ServerError`; their exception strings include the original body and
must not be used in logs or public messages.
