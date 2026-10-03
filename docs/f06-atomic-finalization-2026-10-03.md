# F06 atomic AI finalization verification — 3 October 2026

F06 is **closed and production verified**. This record covers only the ordinary AI ingestion transaction/result-integrity defect in the [re-baseline audit](live-product-audit-rebaseline-2026-10-03.md#f06--p1--ordinary-ai-resultstatus-persistence--must_fix). The original audit remains a historical baseline.

1. **Starting commit:** `fa6e20aa9d993cd6afdd9c37c6159f7eb4d74614`, canonical `main`. The pre-existing untracked `docs/live-product-audit-2026-10-03.md` was preserved and excluded from both commits.

2. **Exact pre-fix timeline:** The worker executed a workspace-scoped conditional `UPDATE jobs ... WHERE status='PENDING'`, setting RUNNING and started_at, then commit #1. It selected the Job again, starting another transaction. Gemini extraction and deterministic resolution ran while that read transaction remained open. `persist_case_resolution` added the Case and flushed its ID; for each candidate it added/flushed the candidate ID, then added evidence and contradictions. Later candidate flushes could also flush earlier pending records. It added the CASE_INGESTED and SCORED_AND_ROUTED audit events and returned without committing. Worker commit #2 flushed outstanding records and durably committed the Case and associated records. The worker loaded the Job, assigned SUCCEEDED, counters and completed_at, then attempted commit #3. The existing fault probe raised before commit #3. The outer catch rolled back, selected the Job, called unguarded `fail_job`, and committed FAILED/WORKER_ERROR. Independent read-back found the Case still present. Pre-fix probe: `case_persisted=true`, `job_status=FAILED`, `job_failure_code=WORKER_ERROR`.

3. **Root cause:** Two worker-owned finalization commits split durable result persistence from terminal success. The lower-level persistence helper did not secretly commit. The broad failure handler could overwrite terminal success, including after uncertain acknowledgement.

4. **Files changed:** `backend/app/tasks.py`; `backend/app/api/ingest.py`; `backend/app/services/case_service.py` (ownership documentation only); `backend/tests/test_jobs.py`; new `backend/tests/test_ai_finalization_postgres.py`; `.github/workflows/ci.yml` (real PostgreSQL gate); this verification record. No frontend source changed.

5. **Schema/migration:** No schema, constraint, Alembic migration, migration Job, historical backfill or historical repair. Production's existing workspace/case-number unique constraint was independently verified.

6. **Transaction ownership:** The AI worker orchestration owns the finalization commit. The shared Case helper retains its add/flush/return contract, now documented explicitly. Sample, CSV, Sources and investigation persistence contracts remain unchanged.

7. **Finalization sequence:** Atomically claim PENDING; read/materialize input inside that short transaction; commit RUNNING; close/release the session connection; execute extraction and resolution without a held database transaction; open a new session; lock/re-read the scoped Job with `FOR UPDATE`; require RUNNING; persist Case/candidates/evidence/contradictions/audits; set SUCCEEDED, successful_rows/processed_rows/total_rows to 1 and completed_at; flush; commit once. PostgreSQL tests assert two worker commits total: claim and finalization.

8. **Case commit behavior:** The helper only adds and flushes. Case and associated data become durable with terminal Job success in the same transaction.

9. **Job success commit behavior:** Exactly one finalization commit, including all existing success metadata. No subsequent success commit.

10. **Failure guard:** The AI worker invalidates the failed session and uses a fresh session/transaction to lock/read the durable scoped Job. SUCCEEDED and existing FAILED are preserved. Only eligible PENDING/RUNNING can become FAILED. The AI enqueue catch also uses a conditional PENDING update, preventing a delayed publication acknowledgement failure from downgrading a completed worker result. Shared CSV/Source failure behavior was not redesigned.

11. **Ambiguous commit reconciliation:** Every escaping final-commit exception is conservatively treated as ambiguous. A fresh session locks the Job and reads its unique result identity. SUCCEEDED requires the Case, counters, completion timestamp, initial audit event types, expected Case ID when available, and expected candidate/evidence/contradiction counts. It is preserved without another Case or provider call. A nonterminal Job with no result Case is safely marked FAILED. A conflicting Case/non-success state, incomplete success, missing Job or unavailable reconciliation raises a sanitized operator-facing exception; it is never guessed or replayed.

12. **Durable Job→Case identity:** No explicit result_case_id/created_case_id/result foreign key exists. The existing durable Job payload contains case_number; `(workspace_id, case_number)` uniquely identifies the Case. Atomic success plus existing Job claim/state authority is sufficient for this flow. The in-memory returned Case ID additionally checks ambiguous-success read-back. No F11 provenance field was added.

13. **Duplicate delivery:** PostgreSQL success then delivery again: SUCCEEDED, exactly one Case, one provider invocation. Delivery after terminal failure also skips extraction and creates zero Cases. Lost-acknowledgement and post-commit-exception redelivery likewise retain one Case.

14. **Provider failures:** Configuration/auth errors, exhausted rate limiting/timeouts, malformed/schema-invalid output and invalid/empty extraction retain terminal failure with zero Cases. Existing Gemini retry policy and provider code are unchanged. Real PostgreSQL tests cover failure categories; existing Gemini retry tests exercise actual extraction/classification/retry code with synthetic provider responses.

15. **Case persistence failures:** PostgreSQL Case insert rejection and failure after Case flush/before success assignment roll back all Case/resolution records; clean failure transaction records FAILED.

16. **Job success-write failures:** Success attribute assignment, server-side SUCCEEDED update rejection and final flush failure all roll back Case/resolution writes, then record FAILED in a fresh transaction.

17. **Definite commit failure:** Real backend termination before PostgreSQL COMMIT, and a server-side deferred constraint-trigger rejection during COMMIT, each leave FAILED with zero Case/candidate/evidence/contradiction/audit records.

18. **PostgreSQL lost acknowledgement:** A psycopg connection subclass performs the actual PostgreSQL commit, proves SUCCEEDED and one Case on an independent connection, closes the committing connection and raises OperationalError to the application. Fresh-session reconciliation sees SUCCEEDED with the complete result, preserves it, and replay adds nothing. This is an application acknowledgement-loss simulation after real database durability, not a mocked Session.commit or a claim of naturally occurring production network failure.

19. **Post-commit exception:** A SQLAlchemy after_commit hook raises immediately after real PostgreSQL durability. The worker reconciles SUCCEEDED with one Case; redelivery preserves it.

20. **Original fault probe after fix:** Exact original ignored `persistence_probe.py`: SUCCEEDED, failure_code null, Case present; the separate third commit no longer occurs. Equivalent fault at the combined finalization commit, rerun on an isolated real PostgreSQL schema: FAILED/WORKER_ERROR, `case_persisted=false`. Neither produces FAILED-with-Case.

21. **PostgreSQL integration:** `AI_TEST_DATABASE_URL=postgresql+psycopg://workbench:workbench@localhost:5432/workbench`, using the existing disposable service and isolated schemas. `tests/test_ai_finalization_postgres.py`: **27 passed**. Coverage includes all required A–L boundaries, independent committed reads, no connection held during the provider, duplicate delivery, preserved terminal failure, missing/inconsistent result detection, reconciliation unavailability and foreign-workspace denial. Disposable schemas are removed after tests. CI runs this suite against its PostgreSQL service.

22. **Backend regressions:** AI finalization, Jobs, Gemini extraction/retry, models, resolution, workspace isolation, API workflow, Sources, investigations and CSV: **195 passed, 2 skipped**. The skips are existing optional CSV PostgreSQL tests in that regression invocation; the required F06 PostgreSQL suite was enabled and had no skips. No paid/live Gemini matrix or frontend suite was run.

23. **Quality gates:** Whole-backend Ruff and formatting pass (117 files formatted); touched application-code mypy passes for tasks.py, api/ingest.py and services/case_service.py; `git diff --check` passes.

24. **Pre-deployment production audit:** Read-only PostgreSQL transaction, aggregate/safe metadata only: **30 FAILED AI Jobs, 28 SUCCEEDED**; FAILED Jobs matching Cases **0**; SUCCEEDED Jobs missing Cases **0**; SUCCEEDED Cases missing initial audits **0**; shared AI payload domain identities **0**.

25. **Historical contradictions:** None found using the strongest existing durable workspace/case-number identity. Without an explicit historical Job→Case foreign key, this is safe identity-based inspection rather than speculative attribution. No historical records were repaired or deleted.

26. **Deployment:** Implementation commit `52aa058326e9e66327be6c370a5ff7ddf9bfcdbc` pushed normally to main. Northflank build `versed-icicle-5463` succeeded. Existing staging-api/staging-worker (the live portfolio services) both completed deployment of that SHA. Settings-preservation hashes matched; both retained one replica. Their deployed task-code SHA-256 matches local code: `eea239fd703a9a5b715cd53f93f236716265b8a8b3d178b66c7f99830aa713ee`. Database connectivity and one worker ping passed. No migration or secret/configuration change. No deliberate production persistence/disconnect fault injection.

27. **Production synthetic success:** Ordinary API-created Job `395da335-2867-44a2-889d-6adf3f67d6d4` observed PENDING→RUNNING→SUCCEEDED. Ordinary UI-created Job `9766c3ef-5c16-4411-969b-dfa45865f1af` also observed PENDING→RUNNING→SUCCEEDED. Each created exactly one Case, one candidate, five evidence records and two audit events. UI creation used the existing Playwright setup after explicit user authorization because the browser-control tool had no available browsers. The resulting Case was visible and remained visible after reload.

28. **Production no-evidence failure:** Job `0d0e82dd-25c4-4100-9f29-c56abd89fe56` reached FAILED/INVALID_EXTRACTION with zero Cases and zero associated resolution records. Started/completed timestamps were confirmed durably. Synthetic operational text only; no provider quota/configuration change.

29. **Independent production durable counts:** A separate read-only PostgreSQL session verified these results, independently of browser/API responses:

    | Synthetic execution | Durable Job | Cases | Candidates | Evidence | Initial audits |
    | --- | --- | ---: | ---: | ---: | ---: |
    | API success | SUCCEEDED | 1 | 1 | 5 | 2 |
    | UI success + reload | SUCCEEDED | 1 | 1 | 5 | 2 |
    | No usable evidence | FAILED / INVALID_EXTRACTION | 0 | 0 | 0 | 0 |

    The three scoped Jobs account for exactly two Cases. Both successful Jobs have all success counters equal to 1 and completion timestamps.

30. **Security/logging:** New diagnostics contain only internal Job ID, phase, attempt, outcome, terminal state and duration. No raw exception/provider response is logged by finalization handling. Production log inspection found no synthetic name/email/phone, raw evidence, credential value or token pattern. Changed-file inspection found no runtime-secret matches. Whitelisted logs show commit attempt 1 and committed/SUCCEEDED for both successes. No new tracing system was enabled; auth tokens remained only in test-process memory.

31. **Commits:** Application fix: `52aa058326e9e66327be6c370a5ff7ddf9bfcdbc`, `fix: finalize AI case and job atomically`. This verification record is committed separately after deployment; its documentation-only commit is the final repository HEAD and does not change the deployed application image.

32. **Git status:** Main is pushed normally. The pre-existing untracked original audit is preserved; all F06 implementation/test/document changes are committed. Exact final HEAD/status are returned with the final response.

33. **Scope:** F08 stale/delivery recovery and F11 role/provenance/uncertainty remain separate. No stale reconciler, scheduler, watchdog, outbox, replay UI, original-note redesign, scoring/schema redesign, LangGraph, Firebase/bootstrap, Redis, CSV, Sources, review UI, Render or unrelated Vercel/UI changes. The only additional failure guard is the AI enqueue acknowledgement race needed to preserve F06 terminal integrity.

34. **Closure:** All eight requested criteria are met: atomic Case+SUCCEEDED finalization; pre-commit rollback; preservation of ambiguously committed success; guarded failure writes; idempotent terminal redelivery; real PostgreSQL proof; corrected original/equivalent probe; production success with independent durable counts and UI reload verification.

35. **Remaining limitations:** A hard-killed worker before finalization can leave RUNNING, as known F08. If fresh durable reconciliation is unavailable or reveals inconsistent/existing conflicting domain state, the worker raises safely for operators and never blindly creates/retries another Case. Historical remediation remains a separate reviewed task. No natural production lost acknowledgement was induced or claimed.
