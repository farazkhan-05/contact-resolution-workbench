# Identity Resolution Workbench

A multi-tenant workbench that compares incoming contact records with reference identities and queues uncertain matches for human review. Suffix and full-middle-name conflicts block automatic likely-match routing even when contact details agree.

## Live portfolio

[Open Identity Resolution Workbench](https://contact-resolution.vercel.app). Choose the anonymous demo or sign in. Use synthetic data only.

The live portfolio deployment uses React/Vercel, Firebase, FastAPI on Northflank,
Neon/PostgreSQL and Redis/Celery. See the [engineering evidence](docs/project-evidence.md)
for tests, synthetic benchmarks and deployment checks. Automatic routing recommends
an outcome; it does not silently merge records or submit a reviewer decision.

## Why this exists

Businesses accumulate outdated contact details and duplicate identities across systems. Exact matching misses legitimate changes; loose fuzzy matching can incorrectly join different people, including family members with similar names.

Optional Gemini extraction turns unstructured notes into schema-validated fields. LangGraph/MCP investigations check extracted values against approved evidence and rerun deterministic analysis. AI cannot set scores, choose a workspace, override contradiction gates or submit the reviewer's Accept/Reject decision. Investigation retrieval currently uses synthetic notes; it has local test evidence but has not run in public staging.

## Data ingestion

### Initial onboarding / ad-hoc

Upload a CSV of incoming identities to create resolution Cases. Inspect candidates, field evidence and contradictions, then record a human decision. CSV export preserves those decisions. The current CSV importer creates Cases; persisted master/reference records are loaded through a REFERENCE Source.

### Ongoing operation

Create a REFERENCE Source for master records and an INCOMING Source for identities requiring resolution. External applications submit ongoing machine-to-machine batches using a Source-specific API key and an Idempotency-Key. Owners can rotate keys or disable ingestion; members can inspect processing history. Both incoming paths use the same deterministic scoring, contradiction checks and review workflow.

See the [Source API contract](docs/sources.md) for the schema and retry behavior.

## Runtime architecture

```mermaid
flowchart LR
    External[External systems] --> Source[Authenticated Source API]
    CSV[CSV incoming import] --> Jobs[Durable PostgreSQL ingestion / Jobs]
    Source --> Jobs
    Jobs --> Queue[Redis / Celery]
    Queue --> Reference[REFERENCE upsert]
    Queue --> Resolve[INCOMING candidate generation and scoring]
    Reference --> Resolve
    Resolve --> Gates[Contradiction-aware routing]
    Gates --> Outcome[Automatic routing outcome]
    Gates --> Review[Human review queue]
```

```text
React / Vercel Production -> Firebase -> FastAPI / Northflank -> Neon PostgreSQL
                                                  |
                                            private Redis -> Celery

Explicit investigation -> LangGraph -> governed MCP -> approved evidence
                                    -> deterministic re-analysis -> human interrupt
```

Automatic routing recommends an outcome; it does not silently merge records or submit a reviewer decision. LangGraph/MCP is implemented and locally tested, but has not been executed in public staging.

## Capabilities

- Verified Firebase authentication and workspace membership checks.
- Durable asynchronous CSV and Source ingestion, credential lifecycle, HTTP/task idempotency and provenance.
- Deterministic candidate scoring with 75/45 thresholds; suffix and full-middle-name contradictions block likely-match routing.
- Human review, evidence inspection, audit history and spreadsheet-safe export.
- Governed LangGraph/MCP investigations and optional privacy-safe OTel/Langfuse tracing.

## Evaluation evidence

| Experiment | Held-out synthetic evidence | Decision |
| --- | --- | --- |
| Deterministic retrieval | Recall@1 92.91%; Recall@5 and Recall@10 100% | Retained deterministic approach |
| Routing at 75/45 | 99 automatic matches; **0 unsafe automatic decisions observed in the held-out synthetic benchmark**; review/abstention 23.85%; true-match rejection 6/127 | Thresholds retained |
| MiniLM retrieval | Underperformed deterministic top-1 | Rejected from runtime |
| Logistic Regression / XGBoost ranking | Improved synthetic top-1; feature investigation exposed a missing-field dataset artifact | Both rejected from runtime |

These measurements describe the versioned benchmark, not production accuracy or the database provider's 100-candidate cap. Gemini embedding performance is unassessed. Offline DeepEval checks validate scripted contracts and tool governance; their 1.0 results are not live model accuracy. [Methods and artifacts](docs/identity-resolution-benchmark.md).

## Deployment

The live portfolio uses Vercel Production on `main`, Firebase authentication, Northflank API/worker, private Redis and Neon PostgreSQL. The already verified environment was reused; internal names such as `crw-staging`, `productization-staging`, `workbench_staging` and `contact-resolution-staging` remain. API, worker and migration workload share the backend image. Kubernetes is validated with kind; it is not the live orchestrator. Optional telemetry exporters remain disabled. This is a synthetic portfolio deployment with no enterprise SLA.

The [controlled cutover](docs/production-cutover.md) passed production browser and API acceptance. The old POC is preserved by annotated tag `v0-poc`; its Render deployment remains temporarily available for rollback and is no longer the live product's backend. Future frontend releases follow commit to `main` → push → automatic Vercel production deployment. Northflank retains its verified pinned backend image; backend changes require a deliberate build/migration/release. Terraform was evaluated and intentionally not adopted because the currently managed infrastructure does not benefit from adding Terraform state.

## Local development

Requires Python 3.13+, uv, Node.js 22+ and Docker for the shared database/broker.

```sh
# Repository root: local PostgreSQL, Redis, API and worker
docker compose build api
docker compose up -d postgres redis
docker compose run --rm api alembic upgrade head
docker compose run --rm api python -m app.services.investigation_service
docker compose up -d worker
docker compose run --rm --service-ports -e FIREBASE_SERVICE_ACCOUNT_JSON api

# Separate terminal
cd frontend
npm ci
npm run dev
```

Supply Firebase Admin JSON in the terminal environment before starting the API; Compose forwards it with `-e` without embedding it in an image. Configure the public browser SDK fields in `frontend/.env.local`; use the example files as references. Keep credentials outside Git and container images. Local SQLite is useful for unit tests; separate API/worker processes should share PostgreSQL. Gemini and exporter credentials are optional for deterministic ingestion and need separate worker environment injection when enabled.

## Testing

```sh
cd backend
uv sync --frozen --group ai-evaluation
uv run --frozen --group ai-evaluation pytest
uv run --frozen --group ai-evaluation ruff check .
uv run --frozen --group ai-evaluation ruff format --check .
uv run --frozen --group ai-evaluation mypy app
uv run --frozen --group ai-evaluation python -m benchmarks.ai_evaluation

cd ../frontend
npm ci
npm run lint
npx tsc --noEmit
npm run build
npm audit
```

Real broker/worker and PostgreSQL checkpoint tests run separately against disposable services, as in [CI](.github/workflows/ci.yml). See the [final audit](docs/final-audit.md) for results, dependency audits and reproduction details. No paid live judge is required.

## Security/privacy

User APIs authorize the verified user's workspace membership. Machine ingestion derives its workspace and purpose from its Source credential. Source tokens contain 256 bits of secret randomness; only a safe lookup prefix and SHA-256 digest are stored. Keys appear only in create/rotate responses and transient UI state.

OTel/Langfuse export allowlisted operation metadata, excluding identities, source rows, prompts, responses and credentials; exporter failures do not change domain outcomes. First-party demo usage events retain bounded identifiers; do not place personal data in case numbers or referral codes. The public environment is for synthetic data.

## Known limitations

- Synthetic benchmarks establish no real-world false-merge guarantee; Gemini embeddings and a live DeepEval judge were not evaluated.
- Workspace reference retrieval takes at most 100 blocked records, ordered by internal ID. Larger blocks can omit the true candidate; benchmark recall does not validate this database cap.
- Hard worker termination can strand PENDING/RUNNING Jobs. Recovery is operator-controlled; see the [crash analysis and runbook](docs/final-audit.md#worker-crash-analysis-and-manual-recovery).
- LangGraph/MCP has local integration evidence and has not been exercised in the public deployment. Approved additional retrieval is currently synthetic.
- The live portfolio uses Northflank Sandbox resources, with no availability/scale SLA; kind validation does not establish production Kubernetes readiness.
- Initial worker failures were observed during staging and pre-cutover smoke. Fresh flows passed after a worker restart during cutover; root cause was not established.

## Documentation links

- [Architecture and component boundaries](docs/productization-architecture.md)
- [Engineering claims, evidence and caveats](docs/project-evidence.md)
- [Final engineering/security audit](docs/final-audit.md)
- [Source API and ongoing ingestion](docs/sources.md)
- [Identity benchmark](docs/identity-resolution-benchmark.md) / [AI evaluation](docs/ai-evaluation.md)
- [Evidence investigations](docs/evidence-investigation.md)
- [Source ingestion acceptance](docs/e4-verification.md) / [public staging](docs/staging-preview.md)
- [Production cutover and rollback record](docs/production-cutover.md)
- [Northflank runbook](infrastructure/northflank/README.md) / [Kubernetes/kind](infrastructure/k8s/README.md)
