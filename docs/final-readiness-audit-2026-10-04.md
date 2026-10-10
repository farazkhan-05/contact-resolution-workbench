# Final readiness audit — 4 October 2026

Historical audit: findings and release gaps below describe 4 October 2026.
The [October release acceptance](production-release-acceptance-2026-10-11.md) records subsequent user-reported deployment and bounded
provenance/investigation acceptance, with remaining operational limits.

As of 4 October, no demonstrated application-code blocker remained. Backend provenance rollout and clean investigation acceptance were still outstanding, and the complete public release had not been verified.

This is an evidence-based STOP/SHIP audit, not a certification of unrestricted SaaS reliability. No application, test, dependency, lockfile, infrastructure configuration, production data or existing audit/design document was changed. No Northflank authentication, old-session use, remote runtime diagnostics, provider calls or deployment was performed.

## Repository and evidence boundaries

- Canonical branch: `main`.
- Audited application HEAD: `ed92cc5e91919c5cace3ce367855aa30dcf36c26`; matches the requested HEAD.
- Starting tracked status: clean.
- Starting untracked documents, preserved and excluded from this report commit: `docs/live-product-audit-2026-10-03.md`, `docs/f08-delivery-stall-diagnosis-2026-10-03.md`, `docs/f11-ai-provenance-design-2026-10-04.md`.
- Local `origin/main` also points to the audited HEAD. Existing release records describe normal pushes. A fresh `git ls-remote` attempt could not verify remote main in this environment; its error text was suppressed to avoid accidental credential/URL disclosure. Pushed status below means retained push evidence plus the local remote-tracking ref, not a new independent remote observation.
- Original report commit: `2ff216c`, `docs: add final readiness audit`, following the audited application HEAD.

Documents reviewed or used for their scoped historical evidence:

| Evidence | Actual repository paths |
| --- | --- |
| Original inventory and re-baseline | `docs/live-product-audit-2026-10-03.md`; `docs/live-product-audit-rebaseline-2026-10-03.md` |
| Reliability and recovery | `docs/gemini-reliability.md`; `docs/workspace-bootstrap-fix-2026-10-03.md`; `docs/f06-atomic-finalization-2026-10-03.md`; `docs/ingestion-recovery.md`; `docs/investigation-retry-fix-2026-10-03.md`; `docs/f08-delivery-stall-diagnosis-2026-10-03.md` |
| F11 | `docs/f11-ai-provenance-design-2026-10-04.md`; `docs/f11-ai-provenance-implementation-2026-10-04.md` |
| Deployment and earlier acceptance | `docs/final-audit.md`; `docs/e4-verification.md`; `docs/production-cutover.md`; `docs/staging-preview.md` |
| Contracts, architecture and claims | `README.md`; `docs/project-evidence.md`; `docs/productization-architecture.md`; `docs/evidence-investigation.md`; `docs/sources.md`; `docs/ai-evaluation.md`; relevant claim/limitation sections of `docs/identity-resolution-benchmark.md`; `infrastructure/northflank/README.md`; `infrastructure/k8s/README.md` |

These reports have different dates and scopes. Historical production success is retained evidence, not a fresh production check. Ignored operational artifacts are not needed to make the release decision, and old Northflank session/diagnostic artifacts were not opened. Current code, committed tests, lockfiles, workflows and local execution were checked separately.

## Individual findings: one final state each

Exact states: **A. CLOSED — production verified**; **B. CLOSED — implementation/local verification complete, production rollout pending**; **C. OPEN — must fix before public showcase**; **D. ACCEPTED LIMITATION — documented, does not block portfolio showcase**; **E. OPTIONAL POLISH — not worth delaying completion**.

For B rows, the evidence column distinguishes an unapplied release from already-deployed code whose specific production failure/recovery path is unverified. F22 is a test-only closure: production rollout is inapplicable. These qualifications prevent a local passing test from becoming a production claim. A rows retain production verification of the original narrow defect, not every later feature in the same file.

| ID | Final state | Evidence and remaining boundary |
| --- | --- | --- |
| F01 | A | Displayed Case ID, committed selection, detail ID and active workspace must agree before review submission in `frontend/src/App.tsx`; stale detail responses fail closed. `App.review.test.tsx` passes. Re-baseline retains four production review decisions with read-back. Later recovery/search sequencing changed App, but the original review guards remain; fresh tests show no regression. |
| F02 | A | Worker Gemini configuration restoration and real extraction-to-Case success are retained in the re-baseline/F06 records. Missing configuration still fails safely; no current configuration inspection was performed. Later provenance finalization does not change client initialization or model credentials. |
| F03 | A | `app.migrate` invokes official PostgreSQL saver setup, preserving pinned migration compatibility. Retained production start/pause/reload/resume and separate-process checkpoint evidence close absent-table failure. Current local checkpoint setup and real-service reconstruction pass. The later F08 incident and unverified clean current-SHA execution do not reopen missing tables. |
| F04 | A | `pool_pre_ping`, bounded whole-transaction bootstrap replay, rollback and safe 503 are implemented. Fourteen real PostgreSQL bootstrap tests pass. Retained production onboarding, repetition/concurrency and integrity read-back verify the repaired disconnect path. No later bootstrap change; historical DB termination trigger remains unknown. |
| F05 | A | Strict structural/header/width validation and atomic CSV Case+Job success remain. Current PostgreSQL CSV suite passes; retained UI/API/durable counts verify valid, malformed, duplicate and Unicode cases. Later CSV guidance did not alter parser/worker semantics. |
| F06 | B | Originally production verified at `52aa058`. F11 subsequently changed this exact finalization/reconciliation path; current 30-test real PostgreSQL suite confirms atomic provenance+Case+SUCCEEDED, rollback, lost acknowledgement and terminal redelivery. Updated path at HEAD awaits backend rollout, so historical closure is not claimed as new-path production proof. |
| F07 | D | Historical pre-start WORKER_ERROR is credible but its cause/current recurrence is unestablished. Do not assign bootstrap or F08 OOM causes to it. Safe failures and current working workflows justify retaining the observation without inventing a fix. |
| F08 | D | Diagnosed diagnostic-contention OOM incident, independent commit-before-publish window, historical stale CSV and lack of reconciler are separated below. Recent activity makes stale ordinary work visible; it does not recover delivery. Bounded synthetic use is acceptable; clean production investigation verification remains a release gate. |
| F09 | D | Ordinary safe failure categories/logs and R01 investigation classification materially improve diagnosis. Coarse governed error envelopes and sanitized unexpected-failure fallback remain intentional limitations; no current wrong-success/data-loss defect was found. Detailed universal diagnosis is not required for portfolio completion. |
| F10 | B | Actual HTTPX/SDK transient classification, bounded attempts/backoff and soft/hard task deadlines are tested in `test_gemini_retry.py` and Jobs tests. Code is already within documented deployment `37735bc`; ordinary production extraction succeeded, but natural production transient retry was not observed. No extra deployment solely for this row is needed; the specific retry path remains local evidence. |
| F11 | B | Exact originating Job association, scoped original note, nonscored role and unverified UI are locally complete at HEAD. Updated API and worker are not rolled out. Machine-structured uncertainty is an accepted residual limitation, not a reopened implementation blocker. |
| F12 | B | Failed AI Jobs can reset to editable input with explicit new extraction; Close/reopen has generation-safe ownership. `Recovery.test.tsx`/modal tests pass. Retained report verifies implementation locally; no fresh production failure/reset journey is asserted. Recovery frontend may already be deployed. |
| F13 | B | Status failures are visible and recheck is GET-only; Close/unmount stops polling and discards late results. Unit and mocked browser recovery pass. Production error-path verification remains unasserted. |
| F14 | B | Scoped durable Recent activity restores ordinary Job status after reload; active work plus latest 20 terminal imports are displayed. Jobs privacy/tenancy tests and local reload smoke pass. No payload/task IDs exposed. Runtime list is unpaginated, acceptable at demo volume. |
| F15 | B | Action-specific refresh/recheck/export recovery replaces generic Retry; uncertain review writes require read-back and do not silently resubmit. Unit/browser checks pass. No new production uncertain-write test performed. |
| F16 | B | Case-list generation guard rejects stale success/error/loading updates across searches, filters and sessions. `App.test.tsx` covers reversed responses. Committed after last documented backend release; frontend deployment is possible, not confirmed. |
| F17 | E | Filters can enable an export that returns only headers when nothing is reviewed. No records leak or identity write occurs. |
| F18 | B | `AppShell.tsx` provides schema, limits, rejection guidance and downloadable template before selection; unit/browser flow passes. Frontend release is possible, not independently verified. Parser contract unchanged. |
| F19 | D | AI dialog has input focus, Escape outside submission and focus return; CSV help has initial focus/Escape/return. No complete Tab trap/background inertness; Source one-time credential dialog has Close autofocus but lacks full Escape/return/trap lifecycle. Practical limitation disclosed below; not a demonstrated primary-path failure or credential leak. |
| F20 | D | Latest reviewer rationale persists; earlier rationale text is overwritten while decision audit events remain. No immutable historical-note requirement exists for this portfolio. Do not advertise full rationale history. |
| F21 | B | Sources list renders independently; per-history `Promise.allSettled` isolates failures; in-flight/request/mount guards suppress overlap and stale updates. `Sources.test.tsx` covers partial failure and sequencing. Frontend production execution is not asserted. |
| F22 | B | Fixture-owned auth overrides survive reordered workspace/workflow tests and full suite. Test-only issue is closed locally; no production defect or rollout exists for this row. |
| F23 | B | Current initial heading is `Could not start extraction`; terminal failures and explicit recovery actions use product wording. The old initial `Status check failed` heading is gone. Local modal/recovery tests pass; do not claim production copy inspected. |
| F24 | E | Filtered `cases.length` still says `total`; cosmetic wording, not data mutation. |
| F25 | E | Single underscore replacement can leave another underscore in multiword labels. Stored enums/decisions unaffected. |
| F26 | E | Source provenance still displays literal `API ?` beside the durable ingestion ID. ID/relationship intact. |
| R01 | B | Retryability survives sanitized extractor → MCP → graph boundary; graph permits three attempts only for allowed transient categories. Unit/offline evaluation and real PostgreSQL wrapper tests pass. `37735bc` was deployed, but the subsequent production investigation never reached provider execution because of OOM. No new deployment solely for R01 is required; clean production verification remains pending. |
| V01 | D | Re-baseline's separate live foreign-workspace investigation POST coverage gap remains. Existing start/get/list/resume/MCP tests deny foreign scope; no exposure was established. A missing live negative POST is an evidence boundary, not a code blocker. |

**Totals:** all **26 original findings** reconciled: A **5**, B **12**, C **0**, D **5**, E **4**. Including R01 and evidence-only V01: **28 records**, A **5**, B **13**, C **0**, D **6**, E **4**. F08's subissues are not double-counted. Production release/verification gates are listed separately from code blockers.

## Major reliability work: implementation, tests and later changes

| Area | Implementation evidence | Local test evidence | Production evidence / later change |
| --- | --- | --- | --- |
| Review race | `App.tsx` reviewView/detail generation, rendered ID submission | `App.review.test.tsx`, `App.test.tsx` | Prior live decisions/read-back retained. Recovery and queue sequencing changed App later; guard still present and tested. |
| Gemini ordinary retries | `services/extractor.py`, `services/gemini_failure.py`, task limits in `tasks.py` | `test_gemini_retry.py`, `test_gemini_extraction.py`, `test_jobs.py` | Successful real extraction retained; no observed natural retry. F11 changes persistence, not prompt/schema/retry policy. |
| Checkpoint setup/persistence | `app/migrate.py`, official saver in `investigation_service.py` | `test_checkpoint_setup.py`, real `test_investigation_integration.py` | Prior production pause/reload/resume and fresh process retained. R01 changes error propagation, not setup. |
| Atomic strict CSV | `csv_importer.py`, `ingest_csv` and CSV task | All 38 CSV tests executed with PostgreSQL fixture enabled | Retained production rejection/count proofs. Post-deployment F18 only adds guidance. |
| Bootstrap DB recovery | `core/database.py`, `api/auth.py`, bootstrap failure/diagnostic modules | 14 real PostgreSQL tests plus auth/workspace tests | Prior production recovery/repetition/concurrency verified; no later relevant code change. |
| Atomic AI finalization | Locked scoped Job, short provider-free transactions, one terminal Case+Job commit, guarded fresh-session reconciliation in `tasks.py` | 30 real PostgreSQL tests, including durable commit then simulated lost acknowledgement | F06 production record exists. F11 added exact association checks and writes afterward; latest path pending rollout. |
| Recent activity/reload | `components/jobs`, `api/jobs.ts`, App and AI-modal generations; unchanged scoped backend Jobs list | Recovery/Jobs/unit tests and browser reload/status recheck | Included before `37735bc` deployment; UI availability and failure-path verification are not inferred from backend deployment. |
| R01 | Sanitized failure metadata, MCP envelope and graph retry predicate | Investigations/MCP, offline AI evaluation, real wrapper integration | Deployed at `37735bc`; clean execution after that deployment unverified. No later retry-path change. |
| F16 | `casesRequestId` and session/request currentness | Reversed search/filter responses, stale errors | `91132c6`, frontend-only runtime change; auto-deployment possible, unconfirmed. |
| F18 | CSV help/template in AppShell | App tests and CSV chooser/browser workflow | `a05b39a`, frontend-only; no importer change. |
| F21 | Independent list rendering, partial history results, no overlapping refresh | Sources partial-history/mount/overlap tests | `91132c6`, frontend-only; no Source authority change. |
| F11 | Explicit audit Job relationship, scoped context endpoint, unverified disclosure | `test_ai_provenance.py`, PostgreSQL finalization/endpoint tests, provenance UI tests and keyboard disclosure browser test | `ed92cc5`, coordinated API+worker release pending; frontend gracefully handles historical/unavailable context. |

## F08: five different concerns

1. **Production incident:** the retained diagnosis directly establishes two worker memory-cgroup OOM group kills after message receipt and before durable claim, while diagnostic Python processes shared the worker's allocation. Publication/routing/registration succeeded for those messages. It does not prove that a clean standalone investigation exceeds memory. Historical incident severity remains P2 on that evidence.
2. **Commit-before-publish gap:** durable Job/run creation precedes `.delay`. A producer process death in between can leave PENDING without publication. Observed publication failures are guarded, but there is no transactional outbox. This is a real architectural liveness boundary, distinct from the already-delivered OOM incident.
3. **Historical stale records:** diagnosis snapshot retained one roughly 44-hour PENDING CSV Job and one roughly 44-minute PENDING investigation. These are historical ages, not today's runtime state. The CSV cause is unknown. Do not blindly replay, delete or relabel either from this audit.
4. **Reconciler:** none exists. Recent activity provides visibility and GET rechecks, not reclamation. Ordinary early-ack tasks can strand PENDING/RUNNING; manual recovery requires confirming dead/quiesced consumers and inspecting scoped durable results. Investigation late ack/worker-lost rejection plus checkpoints supports replay, but whole-group death may wait for Redis visibility restoration.
5. **Clean production verification:** still pending at the last known release. Monitoring/publication clients should run outside the worker's memory allocation. A supervised current-release start/pause/resume check is the smallest evidence-producing step once a fresh safe authentication path exists.

**Controlled portfolio showcase:** F08 does not block a bounded synthetic demo of verified core paths. It limits any live investigation claim; use local demonstrated investigation evidence until clean deployed execution passes. **Unrestricted reliability claim:** F08 does block it. **Code required before portfolio complete:** no present evidence requires more code. No paid upgrade, reconciler, outbox or new infrastructure is a prerequisite established by this incident. Reassess only if clean execution fails, memory deaths recur without diagnostics, or backlog grows.

## Deployment gap

The last documented matched API/worker deployment is **`37735bcf9bda28a0be2351489ded29eadbc23e33`**, completed on 3 October at **21:45:04.625 IST** (worker) and **21:45:47.130 IST** (API), as recorded in the F08 diagnosis. This is historical evidence; current service state was not inspected.

| Later commit | Committed / pushed evidence | Frontend | Backend |
| --- | --- | --- | --- |
| `a05b39a` — CSV format guidance | In main ancestry; covered by recorded pushes/local origin ref | Could have auto-deployed; not verified | No runtime backend delta |
| `91132c6` — queue/Source sequencing | Same | Could have auto-deployed; not verified | No runtime backend delta |
| `ed92cc5` — AI provenance | Same; implementation report records normal commit/push | Could have auto-deployed; not verified | **Not released under the intentionally paused Northflank access path.** Source-context API/schema, provenance write/read invariants and updated finalization reconciliation require API+worker rollout together. |

Frontend push alone never proves Vercel deployment; no new frontend deployment lookup was made. F11 needs no database migration or historical backfill. Prior recovery UI, F06, bootstrap, CSV and checkpoint fixes are within `37735bc` ancestry; do not mistakenly list all of them as undeployed backend changes. Clean current-release investigation verification is a verification gap, not another merged code change.

## F11 final assessment

At HEAD, `persist_case_resolution` accepts the locked originating Job, checks workspace/type/state, and atomically writes versioned `ai_extraction.originating_job_id` and nullable `extracted_job_title` in the Case-owned ingestion audit. The note remains once in Job payload. `_ai_source` requires exactly one matching ingestion event, valid version/UUID/role, and an independently same-workspace ordinary-AI SUCCEEDED Job with valid note payload. Missing, duplicate, malformed, foreign or historical absent links return unavailable; no timestamp, note-text or case-number provenance guess occurs.

`GET /api/v1/cases/{id}/source-context` uses verified membership and scoped Case/Job reads, returns only typed context, and uses private/no-store caching. Normal Case/Job responses omit raw notes. OWNER/REVIEWER, removed membership, foreign Case, foreign Job and malformed provenance tests pass, including PostgreSQL endpoint tests. Source text is escaped React text; Case/workspace/session changes discard it and late responses.

Role remains outside CaseQuery, retrieval, evidence weights and deterministic routing. Matcher/resolver/contradiction thresholds, Gemini schema and prompt did not change in F11. UI labels subject/evidence as AI-extracted and unverified, offers keyboard-operable native source disclosure, and does not introduce confidence percentages. High-score ingestion still persists PENDING with no selected candidate/review timestamp. Final Accept/Reject authority remains the authenticated human endpoint with Case/candidate ownership validation.

**Classification:** minimum portfolio reviewability is locally closed; production rollout pending. Flat values still lack machine-structured uncertainty/alternatives, and qualified values can contribute existing deterministic points. Original qualifiers are visible to the reviewer; this is an **accepted limitation**, with richer uncertainty representation a possible future enhancement. It is not a blocker while AI is visibly unverified and final identity decisions remain human. Neither local regressions nor retained provider examples establish calibrated accuracy or a hallucination rate.

## Security, dependencies and tenant isolation

### Credentials and privacy

A redacted local pattern scan examined **279 tracked files**, **581 reachable historical blobs**, the **three pre-existing audit/design documents**, and **three generated frontend build files**. It searched private-key bodies, JWT-shaped material, selected provider-secret formats, credential-bearing database/broker URLs and Google-key formats; only filenames/categories were emitted. URL candidates were synthetic example/test passwords, including local Compose/CI credentials. No material committed secret, raw production token/cookie/header or private frontend credential was identified within this scope. No already installed dedicated secret scanner was found; the limited pattern scan is not an exhaustive secret-detection guarantee.

`Authorization`, `Bearer`, `<SOURCE_API_KEY>` and synthetic identity/header fixtures are legitimate protocol/test examples, not secret incidents. Public Firebase browser configuration is not an Admin credential. Local example credentials must remain local; documentation does not instruct users to adopt them for production. Ignored runtime `.env`, old session artifacts, production secrets and Northflank credential stores were not read.

Logging review found allowlisted IDs, phases, categories, counts and durations rather than raw notes/provider exceptions. OTel/Langfuse masks exclude arbitrary payloads and exception content; privacy tests pass. Raw notes are intentionally retained in scoped Jobs and revealed only through the new authorized source-context endpoint. This is storage/access functionality, not logging. Legacy usage-event identifier validation cannot guarantee caller identifiers never contain personal information, and intermediate checkpoint fields can persist historically; no blanket zero-PII guarantee is supportable.

The F08 report records an earlier SDK diagnostic response emitting authenticated metadata once, followed by artifact sanitation. This audit did not inspect or reproduce that credential. Repository scans do not prove external session revocation or eliminate that earlier exposure. Northflank authenticated operations remain intentionally blocked until a fresh safe session/authentication path is available. **Logout is not evidence that the old JWT was revoked.** No token value, fragment, fingerprint or raw header is included here.

### Dependency health

Lockfiles and dependencies were not changed. `npm audit --json` reports **five HIGH package entries, zero CRITICAL**, all stemming from **GHSA-vfj7-8cjw-p6xm** in `braces@3.0.3`: stack-exhaustion denial of service from deeply nested patterns. The affected build-tool chain includes chokidar, micromatch, fast-glob and Tailwind CSS 3.4.19. This is one root advisory propagated across packages, not five independent runtime exploits. `npm audit --omit=dev --json` reports **zero known production dependency advisories**. Reviewed Tailwind usage consumes repository build configuration/files, not end-user patterns through an application endpoint. No material showcase-runtime exposure was established; record the build-tool advisory without a blind Tailwind major upgrade.

`pip-audit` is not installed in the available backend environment and no scanner was installed. The committed runtime dependency audit records 117 audited packages with no known advisories; the prior final audit also records the broader 159-package check. `backend/uv.lock` last changed at `b406a04` on 1 October and is unchanged by the subsequent reliability/provenance work. Those results remain dated evidence, **not a fresh Python advisory lookup**. No current material Python HIGH/CRITICAL finding was established, but freshness is a tool limitation. Dependency evidence does not block bounded showcase; do not advertise an absolute zero-vulnerability/security guarantee.

### Tenant isolation

| Resource | Authority / evidence |
| --- | --- |
| Cases and export | Verified Firebase identity → persisted membership → active workspace; list/detail/export scope in Case service; workspace/API tests pass. |
| Review | Case/workspace lock plus candidate ownership; human actor recorded; F01 rendered-identity guards and uncertain-write read-back remain. |
| Jobs | ID and list queries filter workspace; schema excludes payload/task IDs; recovery list ordering/privacy tests pass. |
| Sources/history | Owner-only management; Source ID/workspace authorization before history; machine key supplies Source/workspace/purpose; caller authority fields forbidden; rotation/disable/collision/foreign-workspace tests pass. |
| Source context | Independently scoped Case and exact Job; unavailable on forged/foreign/malformed/historical association; PostgreSQL OWNER/REVIEWER/removed-member tests pass. |
| Investigations | Start locks scoped Case; run get/list/resume joins run and Case workspace; opaque thread IDs are server-owned and not exposed; cross-tenant tests pass. |
| MCP | Durable run establishes scope; tool reauthorizes Case/candidate/artifact access; graph scope mismatch denied; no arbitrary SQL/URL/shell or final decision tool. |

**Conclusion:** no tenant-scoping regression or cross-tenant exposure was found in reviewed code and executed local tests. Prior production core isolation evidence is retained; F11 production and the V01 live foreign-investigation POST gap are not claimed verified. This is an evidence-based conclusion, not a universal security proof.

## Async and Job durability

| Flow | Verified guarantees | Boundary |
| --- | --- | --- |
| CSV | Strict whole-file validation; atomic Case+terminal success; durable counts; rollback; scoped atomic claim; completed duplicate delivery no-op | Early acknowledgement and no lease/reconciler can strand PENDING/RUNNING after producer/worker death. |
| AI | Bounded provider retries; provider outside held transaction; locked single finalization; original Job provenance atomic; fresh-session ambiguous-commit verification; no blind replay; terminal duplicate no-op | Latest F11 path local, not deployed. Hard loss before finalization can leave RUNNING. Unavailable/inconsistent reconciliation fails safely for operators. |
| Sources | HTTP same-key/body receipt identity, changed-body 409, Source namespace; atomic domain+Job completion; scoped upsert; duplicate claims suppressed | New batch keys are not generic crash-recovery permission; historical attributes/rationales are not full snapshots. |
| Investigations | PostgreSQL checkpoints survive new process/saver; serialized concurrent delivery; deterministic evidence identities; interrupt-bound resume; late ack and worker-lost rejection | Publication gap remains; memory/worker/broker restoration is not guaranteed instantaneous; current clean production execution unverified. |

Eight fresh separate service tests used real localhost Redis/Celery and an isolated PostgreSQL database with mocked provider outputs. They exercise actual broker delivery, duplicate suppression, checkpoint reconstruction, concurrent execution, real wrapper retry and interrupt/resume. The Windows audit worker used **solo/concurrency 1**, so these tests do not reproduce Linux prefork/cgroup worker termination. Retained earlier prefork/service evidence remains distinct. No worker-kill experiment or paid/live Gemini call occurred.

The test worker was stopped after verification. All three audit-created databases were removed only after checking they had no active sessions; existing services and guarded migration databases were preserved. Local audit Redis queue/unacked counts were both zero; no queue purge was performed.

Use **durable state**, **idempotent terminal replay**, and **duplicate-delivery tolerant** where these tests support them. Do not say Celery executes exactly once, or that all accepted Jobs automatically recover after crashes. Investigation evidence persistence is replay-aware; ordinary RUNNING ingestion is not automatically reclaimed.

## Product and accessibility readiness

Authentication/bootstrap, Cases queue/detail/review, Sources, bounded strict CSV, ordinary AI submission/status recovery, Recent activity/reload, investigation state/interrupt UI and AI source disclosure have understandable entry points and safe loading/error states in current code/tests. Nine local browser tests passed across desktop and mobile widths and included the workflow journey, review/export/Sources, read-only status recovery and source disclosure/reload. Authentication branding uses mocks; retained real Firebase/browser acceptance is historical. No new live auth/provider/clipboard/production error-path claim is made.

No current principal demo path consistently fails in the local evidence. Review write identity and workspace authority remain guarded. An unavailable source API during F11 rollout yields an explicit unavailable state rather than guessed provenance. A long-running ordinary Job is visibly taking longer than expected; a status error does not silently resubmit work. No further visual redesign is justified.

F19 precisely remains: no complete modal Tab/Shift+Tab containment or background inertness in AI/CSV/credential dialogs; Source credential dialog lacks consistent Escape dismissal and trigger-focus return. AI blocks Escape during submission intentionally and otherwise restores focus; native source disclosure supports Enter/Space. Close buttons are keyboard reachable and visible focus styles exist. This is an **accepted practical accessibility limitation** for bounded showcase, not full WCAG conformance. Do not claim fully accessible modal behavior. No broad accessibility platform or certification is justified before finishing; it is not evidence of a secret leak or unusable primary keyboard route.

F17, F20, F23, F24, F25 and F26 were accepted limitations or optional polish for the portfolio release. F23's original copy is already improved; the others are harmless empty export, retained-latest rationale or small labels. None meets the requested blocker definition.

## Fresh local verification

No dependencies were installed, locks rewritten or paid/live provider tests rerun. Direct executables from the existing backend venv and `npm.cmd` were used when uv cache/PowerShell script restrictions prevented the usual wrappers. Local execution escalations were limited to installed tooling/browser access and disposable localhost services.

| Gate | Result and scope |
| --- | --- |
| Standard full backend | **431 passed, 58 skipped**, zero failing assertions; four existing SQLite datetime-adapter warnings. `pytest -q -p no:cacheprovider` with a new workspace audit basetemp. Optional services/migration/benchmark requirements account for skips. |
| Focused PostgreSQL/reliability | **233 passed**, zero skipped in this invocation. Includes all 30 AI finalization/provenance endpoint tests, 14 bootstrap tests, 38 CSV tests with PostgreSQL fixture enabled, real checkpoint setup, plus Jobs/tenancy/Sources/investigation/MCP/provenance regressions. This number overlaps the full suite; it is not an additional unique-test count. |
| Separate real service integration | **8 passed**, no skips: `test_async_integration.py` and `test_investigation_integration.py`; isolated localhost PostgreSQL, Redis DB 14 and test-only Celery worker; mocked Gemini. |
| PostgreSQL migrations | Fresh unified migration/checkpoint initialization on isolated audit DB passed. Full-suite SQLite upgrade/downgrade preservation passed. Additional PostgreSQL preservation attempt: **2 passed (SQLite), 2 setup-guard failures (PostgreSQL)** because new audit DB names did not equal required `d1_migrations`/`e4_migrations`. Safe preparation then found an existing guarded database and refused to alter it. Those two opt-in preservation checks remain **not reverified**; no schema/production failure inferred and no guard weakened. Prior committed PostgreSQL migration evidence retained. |
| Frontend unit/integration | **115 passed**, eight Vitest files. |
| Local Playwright | **9 passed**, Chromium UI suite, no retries. Includes keyboard source-note disclosure/reload and all five viewport sizes. Two usage-event proxy connection warnings came from the absent mock API; assertions passed. No staging/live smoke or live Gemini used. |
| Ruff | Whole backend check passed. |
| Formatting | Whole backend format check passed: **119 files already formatted**. |
| Mypy | Configured strict `mypy app` passed: **56 source files**. |
| Frontend lint | Full `npm run lint`: **six no-explicit-any errors**, all in ignored `frontend/.system_generated/reliability-audit/defect-probes.test.tsx`. Product `src` and `smoke` lint with zero warnings passed. The generated probes are not tracked product source or part of production build, and were not changed. Full lint is explicitly not called green. |
| TypeScript/build | `tsc -b` and `npm run build` passed; Vite built 1,628 modules. |
| Dependency audit | Fresh npm: five HIGH build-chain package entries / zero CRITICAL; production-only zero known advisories. Python fresh lookup unavailable; dated committed audit inspected. |
| Git checks | `git diff --check` passed; no tracked runtime/config/lock changes. |

An initial full backend run had seven temp-directory permission setup errors (426 passed/56 skipped); rerunning with an allowed new audit basetemp resolved them. Initial frontend esbuild parent-directory access and npm.ps1 policy errors were resolved using authorized local execution and npm.cmd. These were environment failures, not product fixes. The optional PostgreSQL migration guard failures above remain separately disclosed rather than hidden in the full-suite pass.

## Claims for the final documentation pass

No README edit was made. Needed corrections are chiefly chronology and bounded guarantees:

- README/project-evidence statements that LangGraph/MCP **never ran publicly** are stale: retained checkpoint restoration proves earlier production execution. Replace with dated prior verification plus **clean execution on the latest release pending**; do not replace the stale understatement with unrestricted current-SHA verification.
- Historical `docs/final-audit.md` and `docs/productization-architecture.md` still describe AI's separate Case/success commits; mark that analysis historical and point to F06/F11's atomic finalization and current crash boundary.
- Old infrastructure/deployment prose referencing E4 `92165d6`, the Render live POC, or migration commands must distinguish historical provisioning from the later Northflank deployment `37735bc` and pending F11 release. Do not claim HEAD is deployed from a Git push or reuse a historical health check as current release acceptance.
- Keep original synthetic benchmark denominators/methodology. **“0 unsafe automatic decisions observed in this synthetic held-out benchmark” is not “0% false merges.”** Runtime blocked-candidate cap can exclude true matches; benchmark recall does not validate that cap.
- Do not claim measured production AI accuracy/hallucination rate, calibrated confidence, autonomous identity acceptance, exactly-once execution, automatic hard-crash recovery, live embedding/ML ranking, live DeepEval judge results, Kubernetes production hosting, active live tracing or unrestricted production/SaaS readiness.
- Dependency statements of zero known vulnerabilities in dated reports are historical. A current blanket zero-vulnerability claim is unsupported given fresh build-tool advisory and unavailable fresh Python lookup. Full frontend lint also has the generated-probe exception.

Supportable README/resume claims: implemented/tested multi-tenant FastAPI/PostgreSQL workspace authority; Firebase authentication with retained production acceptance; durable asynchronous CSV/Source ingestion and scoped HTTP/task idempotency with disclosed crash limits; deterministic contradiction-aware resolution and authenticated human review; atomic AI Case/Job finalization; locally tested durable AI provenance/reviewer source transparency pending rollout; functional checkpointed LangGraph/governed embedded MCP with local real-service and dated production checkpoint evidence; optional privacy-filtered OTel/Langfuse implementation; offline DeepEval contract/governance evaluation; measured synthetic retrieval/routing experiments with rejected semantic/learned approaches; shared non-root Docker runtime; Kubernetes/kind validation; GitHub Actions workflows; historical Vercel/Northflank/Neon portfolio deployment. Remote Actions results and latest production deployment were not verified here.

## Architecture justification

| Component | Actual product role / limitation |
| --- | --- |
| PostgreSQL | Required durable tenant/domain/Job/Source/audit state and graph checkpoints; functional, not decorative. |
| Celery/Redis | Moves ingestion and explicit investigations off request path; real delivery tested; liveness limits disclosed. |
| Gemini | Optional schema-validated note extraction and bounded investigation planning/extraction; no final decision authority. |
| Deterministic resolution | Core candidate comparison, routing and contradiction gates; measured synthetic baseline retained. |
| LangGraph | Explicit multi-step evidence workflow, durable interrupt/resume and retries; justified by implemented investigation behavior, optional to core review. |
| MCP | Real embedded official protocol boundary with constrained operations and reauthorization; functional governance, not a public general-purpose MCP service. |
| OpenTelemetry | Allowlisted timing/status instrumentation and fail-open exporter boundary; implemented/tested, disabled publicly. |
| Langfuse | Optional filtered AI-span processor/export integration; implemented/tested, no live export evidence. Do not present it as an active production dashboard. |
| DeepEval | Offline scripted parser/tool-governance contracts; useful evaluation tooling, not model-quality certification. |
| Docker | Shared non-root API/worker/migration image; actual runtime/deployment role. |
| Kubernetes/kind | Executable local/CI deployment validation and security contexts; not live hosting. Useful validation artifact, not a production dependency. |
| GitHub Actions | Real backend/frontend/evaluation/service/kind gate definitions; remote current-run status unverified. |
| Vercel | Actual frontend hosting; current auto-release possible, not inspected. |
| Northflank | Actual API/worker/migration/private broker hosting from retained release evidence; current authenticated operations intentionally paused. |
| Neon | Actual durable PostgreSQL host from retained evidence; local tests use disposable PostgreSQL, not Neon. |

No named component is empty scaffolding. Optional telemetry/evaluation/kind components would become decorative **claims** if represented as active production services or measured live AI quality; their implemented roles are narrower and defensible. No architecture replacement or expansion is justified for portfolio completion.

## Readiness and smallest remaining plan

| Category | Status | Reason |
| --- | --- | --- |
| A. Local engineering | **READY WITH LIMITATIONS** | Relevant regression, PostgreSQL, real-service, frontend, type/build and product lint checks pass; no demonstrated code blocker. Generated audit lint errors, optional PostgreSQL preservation rerun limits and dependency freshness/build advisory are disclosed. |
| B. Controlled synthetic portfolio demo | **READY WITH LIMITATIONS** | Bounded core workflows have current local and retained production evidence. Demonstrate new provenance/investigations locally until release-specific production gates pass; use synthetic data and manual human decisions. No availability/scale claim. |
| C. Public showcase of final HEAD | **NOT READY** | Coordinated F11 API/worker rollout and current frontend release confirmation are outstanding; clean deployed investigation verification remains pending. This is a release-evidence gap, not a finding that the existing public core paths are down. A restricted existing-version showcase can continue with disclosed limits. |
| D. Unrestricted production/SaaS | **NOT READY** | Publication/early-ack stranded-work boundaries, no automatic reclamation, constrained unverified investigation headroom, bounded retrieval/history, retention/accessibility limits and no enterprise operational assurance remain. These do not justify building SaaS infrastructure to finish a synthetic portfolio. |

### 1. MUST DO BEFORE SHOWCASE

For presenting the **complete final HEAD** publicly: obtain a fresh safe Northflank authentication path; release the current backend API+worker together; confirm the frontend's actual released SHA; then perform one small supervised synthetic acceptance covering AI provenance/reload/human review and a clean investigation start/pause/resume with no competing diagnostic interpreter in the worker. If investigation clean verification cannot pass or cannot be performed, explicitly constrain the public demo to previously verified core paths and local investigation evidence rather than advertise it live. Do not deploy or authenticate in this audit.

### 2. SHOULD DO DURING FINAL DOCUMENTATION/DEPLOYMENT

Update README/evidence/resume chronology and claim boundaries above, record exact release SHAs/acceptance, document the build-tool advisory and Python-audit freshness limit, and preserve the existing manual-recovery/retention/scale boundaries. Review historical stale synthetic work only through separately authorized safe operator access; do not blindly replay it or make historical cleanup a feature prerequisite. No deployment can bypass the intentionally paused authentication constraint.

### 3. Optional work outside the release scope

Do not delay for F17/F20/F23/F24/F25/F26, a visual redesign, full WCAG certification, structured uncertainty/role scoring, broad history/pagination/retention features, paid memory upgrades, reconciler/outbox/new infrastructure, embedding/ML adoption, telemetry activation or live DeepEval. These are not established code prerequisites under the requested blocker definition. Reopen only on concrete evidence of wrong identity writes, tenant exposure, silent corruption/loss, secret exposure, persistent primary-path failure, unrecoverable important operations, materially misleading behavior or materially false claims.

At the time of this audit, the remaining work was coordinated deployment and release acceptance. See the October release record for subsequent results.

The 4 October local evidence supported a bounded synthetic portfolio, with release verification still outstanding at that date. Unrestricted SaaS reliability was not established. This audit performed no Northflank authentication or credential/header disclosure.
