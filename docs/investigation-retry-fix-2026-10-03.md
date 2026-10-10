# Investigation retry repair - 3 October 2026

Starting branch `main`, commit `37b192c3f543ebc337c8bbfe98852a7aa64c461b`. Scope: R01, investigation error classification in F09, and stale telemetry/browser assertions. Primary audit: [re-baseline](live-product-audit-rebaseline-2026-10-03.md#r01--p2--new-investigation-retrieval-retry-regression--should_fix).

## Reproduction and boundary trace

Before edits, a mocked SDK client raised an HTTPX ReadTimeout through the real `GeminiExtractor.extract_from_unstructured_text` / `_generate` implementation. The resulting exception had `code=PROVIDER_TIMEOUT`, `retryable=True`, `__cause__=None`, and suppressed public context; its safe message was `Evidence provider request failed.` Investigation classification returned False. Both `test_curated_case_real_boundaries[g17]` and `test_artifact_reproducible_and_no_cloud_configuration` failed before edits.

Path: the extractor's canonical provider classifier decides retryability ? `_generate` raises the sanitized GeminiExtractionError from None ? InvestigationOperations.extract receives it ? MCP guarded operation invokes investigation_operations.is_transient ? ToolFailure(category=provider_failure, retryable=False) crosses the embedded MCP client ? MCPToolFailure reaches the retrieve graph node ? LangGraph RetryPolicy rejects retry ? execute_run persists FAILED ? the task returns. Retryability was lost in investigation_operations.is_transient, which inspected the removed cause/numeric code instead of explicit retryable metadata. The task catch is a separate defect: failures escaping before graph invocation (including graph construction, initial checkpoint read, or application coordination) were all labeled CHECKPOINT_UNAVAILABLE regardless of cause.

## Change and contract

Investigation classification now consumes GeminiExtractionError.retryable directly. It does not reconstruct provider HTTP/quota decisions or restore raw causes. Raw TimeoutError/ConnectionError/HTTPX network compatibility remains for non-provider adapters. The MCP safe provider_failure category and retryability reach the graph unchanged. Existing graph policy remains max_attempts=3, initial_interval=0.1, jitter=False; three includes the initial attempt. Ordinary ingestion provider policy is untouched.

A small saver adapter tags actual checkpoint method failures without retaining raw exceptions. Checkpoint context acquisition/finalization and tagged saver failures receive CHECKPOINT_UNAVAILABLE; arbitrary escaping execution/application-database failures receive INVESTIGATION_FAILED. Sanitized provider errors are separated into PROVIDER_TEMPORARY_FAILURE and PROVIDER_PERMANENT_FAILURE. Other governed-tool errors receive EVIDENCE_OPERATION_FAILED. Existing outcome vocabulary is unchanged.

| Category | User message |
|---|---|
| CHECKPOINT_UNAVAILABLE | We could not save or restore this investigation. Please try again. |
| PROVIDER_TEMPORARY_FAILURE | Evidence lookup is temporarily unavailable. You can try the investigation again. |
| PROVIDER_PERMANENT_FAILURE / EVIDENCE_OPERATION_FAILED | We could not complete the evidence lookup. |
| INVESTIGATION_FAILED | We could not complete this investigation. Please try again. |

Logs contain internal run ID, safe final category and retryability only. No raw exception logging, contact/evidence text, credentials, or production tracing was introduced. Provider exception messages and public traceback chains remain sanitized.

## Verification

Real SDK-wrapper ? domain operation ? embedded MCP ? graph regressions cover timeout, 503 and eligible temporary 429 recovering on attempt two; persistent versions exhaust at three; daily quota, billing, 401/403, invalid request, malformed/schema-invalid output and safety block stop on attempt one. Empty-person output is a nonretryable evidence operation failure. Explicit metadata overrides even a legacy raw timeout cause. Privacy assertions inspect the real sanitized exception and captured logs.

Recovery adds one candidate and one evidence-added audit event; resume/redelivery does not duplicate evidence or repeat the provider request. Failure adds no candidates/evidence. Review decision remains PENDING. Existing contradiction and tenant isolation tests pass. A real PostgreSQL timeout recovery test saves and reloads the same thread, pauses, resumes and terminates with no repeated extraction. Governed coverage includes get_resolution_case, get_case_evidence, retrieve_candidate, retrieve_synthetic_notes, request_human_review, scope denial and duplicate provenance.

- Scoped initial investigation/MCP/evaluation/observability: 143 passed.
- Final broad backend with local PostgreSQL bootstrap, CSV, AI finalization and checkpoint setup enabled: 448 passed / 11 skipped / 0 failures, four existing SQLite adapter warnings.
- The eight PostgreSQL/Redis investigation and async-worker tests skipped by that broad invocation ran separately: 7 passed plus the added PostgreSQL real-wrapper regression 1 passed. Required investigation integrations were not left untested. Remaining optional omissions: sklearn/ranking dependencies and the dedicated d1/e4 PostgreSQL migration databases. SQLite migration tests and real empty-database checkpoint initialization passed.
- g17 and aggregate reproducibility passed without changing evaluation expectations.
- Ruff check/format passed across backend app/tests. Mypy passed the four changed production modules under backend configuration. git diff --check passed.
- Local mocked Playwright: 8 passed, including the complete CSV/filter/review/export/Sources journey; no downstream failure. Local telemetry proxy connection warnings are from the absent mock API, not failed assertions.

The observability span intentionally exposes committed domain Job status; the assertion now expects SUCCEEDED. Production status was not changed. The audit's ui.spec.mjs CSV assertion was already corrected by the starting HEAD; its full journey was rerun. The still-stale staging.spec.mjs CSV assertion now expects `1 record imported.` No frontend production source was changed, so frontend unit/build checks were not required.

## Scope and limitation

No F08 reconciliation, F11 provenance/uncertainty, F16 search sequencing, F18 CSV guidance, F19 accessibility, F21 Sources refresh, checkpoint retention/schema/setup, tracing configuration, ordinary retry policy/model choice, secrets/billing, CSV importer, auth/bootstrap or review mutation change is included. Existing ingestion recovery/finalization from the starting HEAD is preserved.

F09 is improved only for investigation error classification. Detailed provider subcategories remain in safe provider logs; the governed envelope deliberately remains coarse, and unexpected failures use a safe fallback. No general observability redesign or tracing activation is claimed. Deployment and the normal production synthetic smoke are reported separately after release; deterministic wrapper tests establish R01 even if no live transient occurs.
