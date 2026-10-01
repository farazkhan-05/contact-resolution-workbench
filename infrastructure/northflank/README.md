# Northflank staging (Milestone E2)

**Status, 2026-10-01: locally validated preparation; deployment pending.**
No Northflank resources have been created. Account-visible costs, migration,
HTTPS health, worker readiness and cloud smoke results are **not verified**.
E1 was pushed to `origin/productization/v1` at
`1378f7ed76f0910ae509c7820d62db26790906dd`. E2 must remain unpushed.

The blocker is external authentication: neither a Northflank API token/official
CLI context nor Neon API credentials/official CLI credentials were available.
Neither CLI was installed. No Firebase Admin credential was available in the
process environment or a backend `.env`. Sandbox activation/payment-method
status cannot be inspected without account access. Do not enter payment details
or select pay-as-you-go on the user's behalf.

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
The migration Job uses that build too. The source SHA is pinned to pushed E1
in the Build node and both internal image selectors. Update all three selectors
together when intentionally changing the application version.

The sequential workflow creates private Redis and a restricted runtime secret
group, creates the API at **zero replicas**, builds E1, runs the migration Job
and waits for success, enables one API replica, then creates one worker replica.
CI builds are disabled; migrations do not run at application startup. Creation
mode preserves the existing API/Redis on later template runs. This workflow is
for initial staging acceptance; review subsequent release changes explicitly.
The service conditions establish platform running state; the smoke establishes
broker/task readiness. No worker HTTP endpoint or HTTP health check is added.

The [official pricing page](https://northflank.com/pricing) advertises always-on
Developer Sandbox allocations of two services, two jobs and one addon. This
template needs **two services, one job, one Redis addon**, plus one secret group.
Northflank [requires a payment method and excludes production use of this tier](https://northflank.com/docs/v1/application/billing/pricing-on-northflank).
These published allowances do not establish eligibility or remaining capacity
for this account. No resource plan has actually been selected or used. Availability
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
   synthetic Job/Case IDs. No staging acceptance can be claimed until this passes.

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

Final local gate: `uv sync --frozen --group ai-evaluation` and the matching pytest
gate passed (**267 passed, 7 skipped**); backend Ruff, format and `mypy app` passed.
Infrastructure Ruff/format and four fail-closed smoke guard tests passed. The
smoke's cloud success path remains unexecuted. No application/container/frontend
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

LangGraph/MCP cloud smoke is separate and **pending**. When an intentional
provider/credential path is available, create a synthetic unresolved review case,
start `/api/v1/cases/{id}/investigations`, poll the scoped run, resume a human
interrupt with `STOP`, and confirm `SUCCEEDED`, durable checkpoints and scoped
MCP tool provenance in the staging database. Do not copy kind auth/mocked-provider
injection into staging or claim this CSV smoke validates investigations.

## Deployment record and rollback

| Acceptance item | E2 preparation result |
| --- | --- |
| Native schema / secret-free template / resource inventory | Passed locally |
| Account Sandbox tier / payment activation / actual free plans | Blocked by Northflank authentication |
| Neon staging branch/database verification or creation | Blocked by Neon authentication |
| Firebase Admin provisioning / synthetic ID tokens | External setup pending |
| Authenticated template dry-run / deployed spec comparison | Not run |
| Migration / API health / worker / private Redis | Not deployed or run |
| Async persistence / duplicate delivery / cross-tenant smoke | Script prepared; cloud execution pending |
| LangGraph to MCP investigation | Not run in staging |

Render remains the stable deployment and rollback path. E2 changed no Render
resource, production Vercel API setting or production Neon database. No production
cutover occurred. If a future staging build/migration/smoke fails, record the
failed node/step and sanitized logs, stop staging acceptance, and leave the demo
unchanged. Resume only against the verified staging database; never remediate by
migrating production. Terraform remains deferred to a later infrastructure step
with a mature supported provider, likely Vercel.
