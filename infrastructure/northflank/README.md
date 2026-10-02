# Northflank staging (Milestone E2)

**Status, 2026-10-02: staging deployed; E2 acceptance complete per release handoff.** Northflank and Neon authentication succeeded through their official CLIs. The user verified Developer Sandbox ($0.00/mo), starting usage $0.00 and an active payment method. The $50 billing limit is not free credit. The account inventory is two services, one job, one addon and one secret group. The official usage API reports an hourly entry with `$0` total and zero PaaS price; no finalized invoices are listed. This reflects available account data, not a financial SLA or future cost guarantee. E3 adds a [public Vercel Preview and browser release validation](../../docs/staging-preview.md).

Northflank project `crw-staging` is in `europe-west`. Its only addon is the retained private Redis 7.2.16 resource `staging-redis`, one replica, `nf-compute-10`, 4096 MB mandatory managed-addon storage, no public access and no TLS. The recovery template reused this addon; it created no second addon. API (`staging-api`) and worker (`staging-worker`) are running, the build succeeded, and migration Job (`staging-migrate`) completed.

The first template run created Redis then failed because secret restrictions referenced workloads not yet created. The subsequent run attempted a second addon and was rejected by the free-addon quota. The current native template takes optional `EXISTING_REDIS_ADDON_ID`; with it set, `skipNodeExecution` bypasses addon creation and the secret group links that existing addon. Without it, initial deployment creates Redis and links the new resource. The successful recovery run created the secret group and remaining workloads using the retained addon.

Neon organization reports `free`. The isolated branch `productization-staging` and database `workbench_staging` are on the existing Neon project. The migration Job applied Alembic to current head, confirmed by a read-only query. Production branch `br-delicate-flower-b37n5n0u` was not used or modified.

Firebase Admin configuration for `contact-resolution-staging` was supplied through Northflank's secret configuration. API `/api/health` returned HTTP 200. Missing and invalid Firebase tokens returned 401; two legitimate Anonymous Firebase identities bootstrapped into separate workspaces. A synthetic CSV Job reached `SUCCEEDED`, with its workspace-scoped Case persisted in staging Neon. A cross-workspace object request returned 404, and a request with mismatched workspace membership returned 403. Worker and private Redis pings passed. The initial duplicate-replay attempt was interrupted by command-exec exit code 9; subsequent duplicate-delivery idempotency was verified in the completed E2 handoff. LangGraph/MCP was skipped because no deterministic synthetic provider/MCP setup is configured, and adding a provider or auth bypass would be unsafe.

E3 started from clean local and remote `productization/v1` at `27a28cc94cd27cda9ea84f6628695410bee637e0`, including E2 corrective changes. Render remains the stable production deployment. Production Vercel, production Neon, DNS and `main` were not changed; no production cutover occurred. E3 overrides only the staging API service's `CORS_ORIGINS` with `["https://contact-resolution-workbench-productization-v1.vercel.app"]`; the read-back confirmed every other runtime value remained unchanged.

The E2 provisioning history is retained. Current deployment and completed
Source/duplicate-delivery acceptance are recorded in
[E4 verification](../../docs/e4-verification.md); the
[final audit](../../docs/final-audit.md) adds a fresh health/authenticated smoke.
The checked-in provisioning template still pins the original E1 build and is
not a declaration of the current E4 deployed image. Do not reapply it unchanged
to an existing environment; an intentional release must select the verified
application SHA consistently across API, worker and migration.

## Architecture and allocation

```text
Explicit staging/test origin -> Northflank HTTPS FastAPI
                                      |          |
                              staging Neon   private Redis
                                      |          |
                                      +--- Celery worker
Same backend image -> one-off Alembic migration Job -> staging Neon only
```

`staging.template.json` is the native Northflank Template IaC source. There is
no Terraform or PostgreSQL addon. The API is a combined build/deploy service,
the worker a deployment service; both use `backend/Dockerfile`'s same build.
The migration Job uses that build too. The provisioning template's source SHA
is pinned to E1 in the Build node and both internal image selectors. The current
deployed E4 implementation is `92165d6`, as verified in the E4 record. Update all
three selectors together when intentionally releasing a new application version.

The sequential workflow creates or reuses private Redis and a project-wide runtime secret
group, creates the API at **zero replicas**, builds E1, runs the migration Job
and waits for success, enables one API replica, then creates one worker replica.
CI builds are disabled; migrations do not run at application startup. For recovery, set `EXISTING_REDIS_ADDON_ID` to the retained addon ID; this account-specific template argument is not a secret.
The service conditions establish platform running state; the smoke establishes
broker/task readiness. No worker HTTP endpoint or HTTP health check is added.

The [official pricing page](https://northflank.com/pricing) advertises always-on
Developer Sandbox allocations of two services, two jobs and one addon. This
template needs **two services, one job, one Redis addon**, plus one secret group.
Northflank [requires a payment method and excludes production use of this tier](https://northflank.com/docs/v1/application/billing/pricing-on-northflank).
These published allowances do not establish eligibility or remaining capacity
for this account. The deployed Redis uses `nf-compute-10`; other workloads have
not been provisioned. Availability
can change; no financial SLA or permanent free hosting is promised.

Redis **7.2.16** is listed by the [official Redis guide](https://northflank.com/docs/v1/application/databases-and-persistence/deploy-databases-on-northflank/deploy-redis-on-northflank).
One replica, no Sentinel/HA, no public or VPC load-balancer access, no backups
or disk autoscaling are requested. The generated private `REDIS_MASTER_URL`
is aliased to `CELERY_BROKER_URL` through the secret group's addon dependency.
TLS is disabled for this project-private staging broker, preserving the existing
Celery `redis://` behavior. `noeviction` prevents silently evicting queued work.
Verify the version and exact connection key are available in the target account
before applying; do not substitute a public URL or a paid plan.

## Configuration

Supply secret values through Northflank's secure **argument overrides**, never
by editing tracked template arguments or storing CLI payloads in Git.

| Category | Setting | Staging value/source |
| --- | --- | --- |
| Account config | `PROJECT_ID` | Dedicated existing Sandbox project `crw-staging` |
| Account config | `SERVICE_PLAN`, `BUILD_PLAN`, `JOB_PLAN`, `REDIS_PLAN`, `REDIS_STORAGE_MB` | Empty until account-visible free eligibility is verified |
| Non-secret | `STAGING_ORIGIN` | One explicit HTTPS Vercel preview/test origin, no wildcard |
| Non-secret | `CORS_ORIGINS` | JSON list containing only that origin |
| Non-secret | `OBSERVABILITY_ENVIRONMENT` | `northflank-staging` |
| Non-secret | `OBSERVABILITY_ENABLED` | `false` |
| Non-secret | `OTEL_SERVICE_NAME` | `contact-resolution-workbench-staging` |
| Non-secret | `HEALTH_PATH`, `API_PORT` | `/api/health`, `8000` |
| Secret | `DATABASE_URL` | Separate staging Neon branch/database URL, SSL required |
| Secret | `CELERY_BROKER_URL` | Generated private addon value; no manually committed URL |
| Secret | `FIREBASE_SERVICE_ACCOUNT_JSON` | Legitimate existing Firebase Admin configuration |
| Optional secret | `GEMINI_API_KEY` | Only for intentional live AI testing; deterministic CSV needs none |

No Langfuse or OTLP endpoints/credentials are set. The application already works
with observability disabled. Firebase ID-token verification is unchanged; there
are no kind test-auth overrides in this deployment. Production Vercel keeps its
current Render API URL. A local HTTP client can test staging without a frontend
deployment; browser tests require the explicit allowed origin above.

## Resume deployment after authentication

1. Authenticate using the official Northflank API, dashboard or
   [CLI](https://northflank.com/docs/v1/api/use-the-cli).
   If needed, the official current stable CLI checked for this milestone is
   `@northflank/cli` 0.13.0 (`npx @northflank/cli@0.13.0`); recheck the stable
   release when resuming. Never retrieve credentials from unrelated stores.
2. Inspect the authenticated account's billing tier, payment activation, remaining
   resource allocations and eligible service/job/build/addon plans (`list plans`
   or the dashboard). Record the **actual plan IDs and zero-charge entitlement**
   for API, worker, migration, Redis storage and build before any resource apply.
   Generic `nf-compute-*` pricing is not proof of free eligibility. If any requested
   resource/allocation is paid or unavailable, stop for review. Use the Sandbox
   project `crw-staging`; do not repurpose a production project.
3. With official authenticated Neon tooling/API, inspect existing branches and
   databases. Reuse a verified separate staging branch/database if present;
   otherwise create a dedicated branch/database. Prefer an empty/schema-only
   branch so production identity data is not copied into this synthetic environment.
   Record project/branch/database and staging endpoint host in deployment notes;
   verify they differ from production. No Neon access means **stop before migrations**.
   Use the staging URL with `sslmode=require`; never fall back to a production URL.
4. Supply the plan inputs, explicit origin, staging database URL and legitimate
   Firebase credential as secure template argument overrides. Connect the GitHub
   repository through official Northflank integration if necessary. Leave Gemini
   empty for the deterministic CSV smoke.
5. Validate locally, import the native JSON through the dashboard's code editor,
   inspect the generated resource specifications and argument resolution, and
   review every billing/network field before running. Northflank performs an
   [authenticated dry-run before executing nodes](https://northflank.com/docs/v1/application/infrastructure-as-code/make-a-template-dynamic).
   This server check has **not run** during E2 preparation. Do not enable autorun
   or run-on-creation to bypass review. Do not serialize resolved secret values
   into tracked JSON or deployment reports.
6. Run the template. Require the build and migration Job to succeed before
   acceptance. Confirm API, migration and worker select the same built E1 SHA/image
   digest; API replicas must remain zero until migration success. Confirm exactly
   two services, one Job, one Redis addon and one secret group, with no public
   worker/Redis ports. Compare the deployed specs to this template, including
   commands, plan IDs, secret links and health probes. Store generated template,
   build, job-run and service DNS identifiers separately from secrets in notes.
7. Check `/api/health` over generated Northflank HTTPS. Inspect worker logs for
   successful private broker connection and readiness; optionally use the
   [official exec command](https://northflank.com/docs/v1/api/execute-command) to
   run `celery -A app.celery_app:celery_app inspect ping --timeout=5` in the worker.
   Never print runtime environment or connection credentials.
8. Run the synthetic smoke below. Retain only redacted pass/fail results and
   synthetic Job/Case IDs. Completed E4 acceptance verified API, worker, migration,
   Source persistence, cross-tenant checks and an observed completed duplicate
   replay. Preserve the earlier interrupted attempt as historical evidence.

## Local template validation

From `backend`, using the backend environment and an isolated tool dependency:

```powershell
uv run --with jsonschema==4.26.0 python ../infrastructure/northflank/validate_template.py
```

This downloads [Northflank's native JSON Schema](https://api.northflank.com/v1/schemas/template),
validates the complete native template, checks sequential references and empty
secret inputs, and prints the resource inventory and schema SHA256. `--schema`
accepts a previously downloaded official schema for offline repeatability.
The `$schema` editor annotation is removed from the validation payload because
the published payload schema disallows that annotation. Local validation passed
with SHA256 `45a787ea96e384c048e6186dfa6f5ff569c0e7dfcec0240ebfec6b29ece16da0`.
It does not prove free eligibility, actual argument values or cloud execution.

The prior E1 local gate passed (**267 passed, 7 skipped**). This recovery passed the six focused fail-closed smoke guard tests and official native template schema validation. No application/container/frontend
files changed, so no Docker rebuild or frontend gate was needed.

## Real synthetic smoke

Use two legitimate Firebase ID tokens for dedicated synthetic test accounts in
separate staging workspaces. Set these environment variables securely, without
including values in shell history or repository files:

```text
STAGING_API_URL             EXPECTED_STAGING_API_HOST
STAGING_DATABASE_URL        EXPECTED_STAGING_NEON_HOST
STAGING_NEON_BRANCH_ID      PRODUCTION_NEON_BRANCH_ID
STAGING_BROKER_URL          STAGING_FIREBASE_TOKEN_A
STAGING_FIREBASE_TOKEN_B
```

First verify the Neon endpoint-to-branch mapping in the authenticated account.
The smoke's explicit host/branch checks are additional guards, not an independent
Neon control-plane attestation. Read-only SQL verifies Alembic heads and Case
persistence; API requests create only a synthetic CSV Job/Case and test workspaces.

Redis remains private. For a local test runner, use the official addon's local
access forwarding command with `--skipHostnames`, bind only loopback, and use the
forwarded local port/password in `STAGING_BROKER_URL`. Never enable addon public
access to run a smoke. Close forwarding after testing.

```powershell
cd backend
uv run --frozen python ../infrastructure/northflank/staging_smoke.py --confirm-staging
```

The script verifies HTTPS health, missing/invalid-token 401, real Firebase
bootstrap, private Redis ping, Celery ping, migration heads, CSV submission,
`SUCCEEDED`, matching Job/Case workspace in Neon, foreign-workspace 403 and
foreign-object 404, then a **completed duplicate delivery** and exactly one Case.
It temporarily enables Celery events to observe duplicate task completion and
restores events to disabled; run on the dedicated staging worker with events
initially disabled and no other event consumers. Tokens, URLs and driver exception
details are not printed. Synthetic records are retained for review, not deleted.

LangGraph/MCP cloud smoke was not run. When an intentional
provider/credential path is available, create a synthetic unresolved review case,
start `/api/v1/cases/{id}/investigations`, poll the scoped run, resume a human
interrupt with `STOP`, and confirm `SUCCEEDED`, durable checkpoints and scoped
MCP tool provenance in the staging database. Do not copy kind auth/mocked-provider
injection into staging or claim this CSV smoke validates investigations.

## Deployment record and rollback

| Acceptance item | E2 preparation result |
| --- | --- |
| Native schema / secret-free template / resource inventory | Passed locally |
| Account Sandbox tier / payment activation / actual free plans | Dashboard verified by user; inventory is two services, one job, one addon; hourly usage total `$0`, no finalized invoices |
| Neon staging branch/database verification or creation | Free organization; isolated branch and empty staging database created |
| Firebase Admin provisioning / synthetic ID tokens | Admin credential configured in Northflank secret group; real staging auth passed |
| Authenticated template dry-run / deployed spec comparison | Recovery run succeeded; retained private Redis reused; two services, one job, one addon, one secret group |
| Migration / API health / worker / private Redis | Staging migration head, API health, worker ping and private Redis ping passed |
| Async persistence / duplicate delivery / cross-tenant smoke | Initial duplicate attempt was interrupted (exit 9); completed E2 handoff and E4 observed replay subsequently verified idempotency, persistence and cross-workspace denial |
| LangGraph to MCP investigation | Not run in staging |

Render remains the stable deployment and rollback path. E2 changed no Render
resource, production Vercel API setting or production Neon database. No production
cutover occurred. If a future staging build/migration/smoke fails, record the
failed node/step and sanitized logs, stop staging acceptance, and leave the demo
unchanged. Resume only against the verified staging database; never remediate by
migrating production. Terraform was evaluated and intentionally not adopted
because the currently managed infrastructure does not benefit from adding
Terraform state. This is the final ownership decision, not unfinished setup.
