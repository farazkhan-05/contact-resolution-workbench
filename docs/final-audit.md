# Final engineering and portfolio audit

Audit date: 2026-10-02. Starting branch `productization/v1`, full commit `b12905c85bea4a086c99aacb1df63025d534e65c`. Starting worktree was clean. `git ls-remote` independently confirmed that the remote branch matched local HEAD and `origin/productization/v1`.

This audit finalizes documentation and corrects three whitespace-only formatter failures in the Northflank schema validator. It introduces no runtime feature, dependency, migration, Kubernetes manifest or cloud allocation. No production deployment or `main` merge is part of this release.

## Risk-based findings

| Surface | Finding / decision | Evidence inspected |
| --- | --- | --- |
| Firebase / bootstrap / tenancy | Backend verifies Firebase bearer identity; persisted membership authorizes `X-Workspace-ID`. Bootstrap does not accept caller identity/workspace authority. | `core/auth.py`, `api/auth.py`, workspace isolation tests |
| Cases / Jobs / review | Queries root in the authorized workspace; candidate selection is restricted to that Case. Final review decisions remain human-owned. | Case/Job APIs, `case_service`, API workflow/workspace tests |
| Sources / history | User-facing Source queries filter workspace. History first authorizes its Source; Job lookup follows that ingestion's unique foreign key. Worker Source lookups follow an atomically workspace-claimed Job. No newly introduced caller-controlled unscoped read was found. | Source API/service/models and security tests |
| Machine authority | Firebase/user management and machine ingestion have separate dependencies. Machine workspace and purpose come from its authenticated Source; payload authority fields are forbidden. | Source schemas, machine authority tests, final staging smoke |
| Credentials | `secrets.token_urlsafe(32)` provides 256 secret bits beyond the random lookup prefix. SHA-256 is appropriate for generated high-entropy tokens; `hmac.compare_digest` verifies the digest. No password-hashing replacement is justified. | Key generation, persistence, response schemas, rotation/disable/security tests |
| Credential exposure | Full keys appear only at create/rotate with `no-store`; GET/list expose the safe prefix, not digest/key. Frontend retains credentials in transient dialog state, not storage/URL. Workers receive internal IDs. | Sources component/client, E4 browser checks, logs/audit/span tests and secret scan |
| HTTP retries / race | Unique `(source_id, idempotency_digest)` plus transaction rollback protects receipt races. Canonical payload digest binds the body. Equal retries reuse any state; changed payload returns 409. Another Source has its own namespace. | Source transaction/model/tests; disposable PostgreSQL experiment below |
| REFERENCE provenance | Unique workspace + Source + external ID, with same-Source PostgreSQL row locking. Replacement updates retain the latest ingestion pointer; receipts preserve prior batch history. Disable does not delete existing records. | Source service, collision/upsert/migration tests |
| INCOMING pipeline | API and CSV incoming records use the workspace provider and existing matcher, gates, router and Case persistence. No separate score/decision shortcut. | Source/Case services and provider/pipeline tests |
| Identity safety | Thresholds remain 75/45. Jr./Sr. and explicit full-middle-name conflicts block likely-match routing even at score 100. Neither caller nor model can supply authoritative scores or final decisions. | Matcher/router/contradiction tests, MCP injection tests, C4 gate reproduction |
| LangGraph / MCP | Approved Operation enum maps explicitly to official MCP protocol calls. Durable run owns workspace/case scope; requested candidate/evidence IDs are reauthorized. No arbitrary SQL/HTTP/filesystem/shell tools. Human-review tool cannot Accept/Reject. | Graph/service/MCP code, interrupt/replay/governance tests, real-service checkpoint/MCP tests |
| OTel / Langfuse | Allowlisted enum/count/timing metadata; sanitized spans omit events, identity fields, raw rows, prompts, responses, tokens and connection credentials. Source spans use the same filter. Export/init failures are fail-open. | Observability processors/signals and privacy/failure tests |
| First-party usage | Legacy anonymous events retain bounded case/referral/session identifiers; this is distinct from OTel/Langfuse. Identifier validation cannot prove that a caller never puts personal data in an identifier. Removed the old blanket zero-PII wording. | Usage schema/API/client/tests |
| DeepEval | Normal CI is offline and deterministic; permission/correctness/JSON metrics use scripted responses and a fail-on-judge adapter. Login discovery/analytics/cloud uploads are disabled. No paid live judge run. | Evaluation runner/metrics/init, network-blocking tests, artifact reproduction |
| Deployment | Non-root shared API/worker image, separate migration workload, secure Kubernetes contexts and no service-account token mount. Staging uses exact CORS, Firebase staging and separate Neon, with private Redis. | Dockerfile/manifests/workflows, Northflank template, E3/E4 deployed read-back records, fresh public smoke |
| Supply chain | uv/npm lockfiles retained; PyPI and the explicit official CPU PyTorch wheel index are the package sources. No dependency upgrade or added runtime package. Runtime Python base remains a version tag; no digest-pinning guarantee is implied. | Lock/source configuration and fresh vulnerability audits |

The remaining reliability and retrieval limitations below are material for a production release. They do not invalidate the verified synthetic portfolio workflows.

## Worker crash analysis and manual recovery

### Acknowledgement and failure windows

CSV, unstructured and Source ingestion tasks use Celery's **early acknowledgement** default. They do not set `acks_late` or `reject_on_worker_lost`. Investigation tasks separately set both, with durable graph checkpoints and PostgreSQL locking; that does not change ingestion Job claims.

Celery documents acknowledgement/redelivery behavior in its [task guide](https://docs.celeryq.dev/en/stable/userguide/tasks.html). Redis's default [visibility timeout](https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html) is one hour for unacknowledged messages. This application does not override it. It is not a lease on a PostgreSQL Job, and an acknowledged message cannot rely on that timeout for recovery.

| Worker death window | CSV / Source outcome | Unstructured extraction outcome |
| --- | --- | --- |
| A: before claim | A reserved but unacknowledged message may be redelivered. If already acknowledged, the durable Job can remain PENDING with no queued work. API death between receipt commit and publication can also leave PENDING. | Same |
| B: immediately after committed claim | Job remains RUNNING; no lease/heartbeat or automatic reclaim exists. | Same |
| C: while processing | Open domain transaction rolls back when the dead connection closes; committed claim remains RUNNING. | Before domain commit: same; provider may already have been called |
| D: after persistence | Domain records and SUCCEEDED Job commit together. Replay cannot claim a terminal Job and creates nothing. Early acknowledgement normally occurred before this window. | Case persistence commits before a separate SUCCEEDED update; death between those commits can leave a persisted Case with RUNNING Job |

Ordinary duplicate delivery is safe because a conditional atomic update claims only PENDING, and later deliveries observe zero affected rows. Terminal SUCCEEDED/FAILED replay is a no-op. **A RUNNING Job can remain stranded indefinitely; redelivery alone does not recover it.** Recognized transient ConnectionError/TimeoutError paths roll back, release the claim to PENDING and request up to three retries. They are not generic PostgreSQL/Celery crash recovery; exhausted publication/retry or process failure can still require operator reconciliation.

### Decision

Retain the explicit limitation rather than add automatic time-based reclamation in the final documentation release. `started_at` alone cannot distinguish a dead worker from a slow live one. Safe reclamation needs ownership/fencing across writes, task acknowledgement policy and the unstructured double-commit window; adding a timeout without those protections could let two workers write concurrently. No scheduler, lease schema or unsupported automatic-recovery guarantee is introduced.

### Operator procedure

1. Verify the target environment/database is staging or an explicitly approved environment. Record only Job/workspace IDs and state, never payloads or credentials. An old `started_at` is an investigation clue, not proof of death.
2. Stop **all ingestion consumers** that can execute the Job and confirm their processes/connections have stopped. Quiesce ingestion submissions during recovery. Restarting or resetting while a worker can still commit is unsafe.
3. Inspect the workspace-scoped Job, associated ingestion and domain records using trusted operator access. Leave SUCCEEDED/FAILED Jobs terminal. For a stuck unstructured Job, check its payload's case number within its workspace: a persisted Case may already be complete. Reconcile that Job to SUCCEEDED only after verifying the Case/evidence; do not rerun extraction or delete reviewed records blindly.
4. For CSV/SOURCE_INGEST PENDING/RUNNING Jobs, confirm no unexpected committed domain result. Their normal transaction makes RUNNING incompatible with committed success, so confirmed dead workers can safely replay the **same Job** after reset. Preserve SourceIngestion and its idempotency digest; do not submit a new key as a generic recovery shortcut.
5. With the trusted runtime environment already supplying the database/broker settings, set `RECOVERY_JOB_ID` and `RECOVERY_WORKSPACE_ID`. Run the following from `backend` (or as a controlled one-off workload of the same image). This is an operator action after the checks above, not a browser/model API:

```python
import os

from sqlalchemy import select

from app.core.database import SessionLocal
from app.models.job import Job
from app.tasks import ingest_csv_job, ingest_source_job

job_id = os.environ["RECOVERY_JOB_ID"]
workspace_id = os.environ["RECOVERY_WORKSPACE_ID"]
tasks = {"CSV_INGEST": ingest_csv_job, "SOURCE_INGEST": ingest_source_job}

with SessionLocal() as db:
    with db.begin():
        job = db.scalar(
            select(Job)
            .where(Job.id == job_id, Job.workspace_id == workspace_id)
            .with_for_update()
        )
        assert job is not None and job.job_type in tasks
        assert job.status in {"PENDING", "RUNNING"}
        task = tasks[job.job_type]
        job.status = "PENDING"
        job.started_at = job.completed_at = None
        job.failure_code = job.failure_message = None
        job.processed_rows = job.successful_rows = job.rejected_rows = 0
        job.celery_task_id = None
    result = task.delay(job_id, workspace_id)
    job.celery_task_id = result.id
    db.commit()
print("Same durable Job queued for operator-controlled recovery.")
```

6. Restore one consumer, poll the authorized Job to terminal success, then inspect expected record counts/provenance before restoring normal consumers/submissions. A stale queued duplicate cannot reclaim a RUNNING/terminal Job. If publication fails, keep consumers stopped and repeat reconciliation against the same Job; never expose the underlying exception/connection string in public logs.

This audit did not execute recovery against cloud data or claim tested automatic recovery. Existing rollback/duplicate-delivery tests and the real-service suite support the transaction/replay behavior on which this manual procedure depends.

## Candidate-limit conclusion

`WorkspaceReferenceProvider.search` takes up to eight sorted normalized name tokens and ORs name-substring blocks with exact normalized email/phone. It filters workspace, orders by internal UUID and applies `.limit(100)` **before scoring**.

This bounds returned/scored/persisted candidates, not the cost of substring scans. It is correctness-affecting: a crowded block can exclude even an exact contact match with a later internal ID. A disposable audit experiment confirmed that 101 same-name records return 100 and omit the final exact-email record. Smaller populations can also miss candidates that satisfy no configured block.

The C1 benchmark uses different compound blocks, scores/orders the complete blocked pool and then keeps 20. Its held-out mean candidate set is 6.17, p95 13. The published 92.91%/100%/100% recall does **not** establish recall under the runtime database cap.

The known bounded portfolio retrieval design is retained. This is a documented scale/correctness boundary, not an exhaustive matching promise: workspaces with crowded blocks exceeding 100 require a separately evaluated retrieval change before relying on automatic routing. The final release adds no search service or unvalidated retrieval-policy change.

## Final verification

Final results are recorded after documentation stabilization; the commit itself is the documentation release. Runtime remains the E4 implementation deployed from `92165d6`.

| Gate | Result | Scope |
| --- | --- | --- |
| Frozen backend sync / full pytest | **289 passed, 7 skipped** | Offline AI group installed; SQLite and disposable PostgreSQL migration checks enabled; real-service suites run separately |
| Ruff / format / mypy | Passed | Backend; infrastructure static checks also covered |
| Python vulnerability audits | Zero known vulnerabilities: 117 locked runtime packages, 159 applicable runtime/dev/offline-evaluation packages | pip-audit 2.10.1; no upgrades; optional semantic/ranking groups retain their existing prior audit evidence |
| Frontend | `npm ci`, lint, TypeScript, build, `npm audit` passed; zero vulnerabilities | No package/lockfile changed; ESLint emitted its upstream support/deprecation notice |
| Deterministic AI evaluation | No failures; live status `not_requested`; logical JSON matches committed artifact | No judge, login or cloud upload |
| Benchmark reproducibility | C1 held-out/manifest and C4 held-out/gates exactly match committed logical artifacts | MiniLM/ranking results and rejection manifests inspected; models not retrained/downloaded |
| Real service integration | 6 passed | Disposable PostgreSQL, Redis and separate worker; CSV/Source delivery, duplicate replay, graph checkpoints/concurrent execution/interrupt/resume/MCP |
| Northflank guard tests | 6 passed | Existing fail-closed staging validation suite; validator formatter correction is whitespace only |
| Source HTTP concurrency | 16 requests across 8 threads produced one ingestion, one Job and one task publication | Disposable PostgreSQL; held pending with a local enqueue stub to isolate receipt concurrency |
| Source state replay | PENDING/RUNNING/SUCCEEDED/FAILED each reused the same Job; changed payload returned 409 | Local disposable experiment; separate Source namespaces covered by committed tests |
| Docker | Build passed; API healthy; runtime worker ping passed; UID/GID 999; no `.env` or test mount in runtime API | Same image for API/worker/migration; test-only integration worker used the dev environment separately |
| Kubernetes / Northflank static validation | Kustomize render/security-context checks and official Northflank schema validation passed | Runtime/manifests unchanged, so kind not rerun; prior kind evidence retained |
| Staging health / authenticated smoke | Public frontend and Northflank health HTTP 200; Firebase bootstrap, unauthorized-workspace 403, source authority, completed reference Job, retries/conflict, rotation, disable/history passed | One record in the successful smoke; credentials stayed in memory; no new cloud resources |
| CORS / browser bundle | Exact staging origin allowed; untrusted origin rejected; deployed bundle targets staging and contains no Source credential/Admin material | Firebase public browser SDK config is expected |
| Repository hygiene | No credential-pattern findings or tracked runtime artifacts across 227 starting tracked files and 387 reachable historical blobs; fresh browser bundle clean | Redacted pattern/filename scan, not a guarantee against every secret representation |
| GitHub Actions | Remote CI unverified | Official `gh auth status` reported no authenticated hosts; no credential extraction/auth bypass/workaround installation |

The first offline-only full suite passed **287 tests, 9 skipped**. A combined service-enabled invocation was discarded as a validation setup: module-level unit API overrides leaked into service tests, the production image intentionally lacked the test fixture's pytest dependency, and `localhost` migration connections timed out. The dedicated service process with the dev worker and IPv4 disposable URLs passed all six tests. Unit/migration and service gates remain separate, matching CI.

The final full backend gate passed **289 tests, 7 skipped** with both PostgreSQL
migration URLs enabled, followed by passing Ruff/format/mypy. Six service tests
and six infrastructure guard tests passed separately. Local environment examples
and the ignored SQLite runtime file were preserved; no runtime database, cache,
dependency directory, build output or acceptance credential is staged for Git.

The successful final staging reference Job was `3936188c-d1b2-496b-ac40-c35a08578ca9` (one successful row). An earlier authentication attempt and an earlier completion observation were incomplete; they did not establish a worker failure cause and are not counted as passed. Their synthetic workspaces/receipts can remain for inspection; credentials were discarded, created Sources were disabled, and no cloud data was deleted.

One transient initial worker failure was observed during staging deployment. Subsequent complete end-to-end flows passed; root cause was not established. This historical E3 observation remains separate from the final smoke results.

## Release decision

The engineering gates passed for the synthetic portfolio/staging environment, with the reliability and retrieval limits above. These results do not verify the GitHub default branch or authorize a production cutover.

Terraform was evaluated and intentionally not adopted because the currently managed infrastructure does not benefit from adding Terraform state. Production migration/cutover is a separate controlled release decision. No production Vercel, Render, Neon, Firebase, DNS or `main` change was made. GitHub Actions remains unverified remotely because official authenticated access was unavailable.
