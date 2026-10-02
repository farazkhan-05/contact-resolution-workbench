# Project evidence

Audited on 2026-10-02, starting at `b12905c` on `productization/v1`. The verified public environment is [staging](https://contact-resolution-workbench-productization-v1.vercel.app). [Final audit and verification](final-audit.md) records the checks and operational constraints.

Statuses describe the evidence available: **IMPLEMENTED** means code exists; **TESTED** means exercised by tests/acceptance; **BENCHMARKED** means measured on the documented dataset; **DEPLOYED** means present in the staging deployment. Deployment alone does not prove execution of an optional capability.

## Claim inventory

| Claim | Status | Evidence | Caveat |
| --- | --- | --- | --- |
| Firebase authentication | IMPLEMENTED, TESTED, DEPLOYED | [Verification/bootstrap](../backend/app/core/auth.py), [staging browser acceptance](staging-preview.md), [final smoke](final-audit.md#final-verification) | Separate staging project; no production cutover |
| Tenant isolation | IMPLEMENTED, TESTED, DEPLOYED | [Workspace tests](../backend/tests/test_workspace_isolation.py), [Source tests](../backend/tests/test_sources.py), [MCP scope tests](../backend/tests/test_investigation_mcp.py) | Membership must authorize the workspace header; not just an object ID |
| Source API | IMPLEMENTED, TESTED, DEPLOYED | [API](../backend/app/api/sources.py), [canonical contract](sources.md), [E4 acceptance](e4-verification.md) | 100 records / 256 KB per batch; no vendor connectors |
| Source credential lifecycle | IMPLEMENTED, TESTED, DEPLOYED | [Generation/digest](../backend/app/services/source_service.py), [rotation/disable tests](../backend/tests/test_sources.py), final authenticated smoke | One-time response/transient UI; accepted work continues after disable |
| HTTP idempotency | IMPLEMENTED, TESTED, DEPLOYED | [Unique Source retry constraint](../backend/app/models/source.py), [receipt transaction](../backend/app/api/sources.py), E4 and final smoke | Same canonical body reuses any Job state, including FAILED; changed body returns 409 |
| Celery duplicate-delivery idempotency | IMPLEMENTED, TESTED, DEPLOYED | [Atomic claims](../backend/app/tasks.py), [real-service tests](../backend/tests/test_async_integration.py), E4 observed completed replay | Duplicate suppression does not provide hard-crash recovery |
| Durable Jobs | IMPLEMENTED, TESTED, DEPLOYED | [Job model](../backend/app/models/job.py), [Job tests](../backend/tests/test_jobs.py), real PostgreSQL/broker suite | PENDING/RUNNING can be stranded; operator recovery documented |
| REFERENCE ingestion | IMPLEMENTED, TESTED, DEPLOYED | [Upsert/provider](../backend/app/services/source_service.py), Source collision/update tests, E4 and final smoke | Unique workspace + Source + external ID; updates replace optional fields; CSV reference importer is not implemented |
| INCOMING ingestion | IMPLEMENTED, TESTED, DEPLOYED | [Shared Case service](../backend/app/services/case_service.py), CSV/Source provider tests, [E4 real batches](e4-verification.md) | New batches intentionally create new events even for the same external ID |
| Ingestion provenance/history | IMPLEMENTED, TESTED, DEPLOYED | [Source/ingestion models](../backend/app/models/source.py), [migration preservation](../backend/tests/test_source_migration.py), E4 UI acceptance | Reference row points to latest update; receipts retain history, not complete previous attribute snapshots |
| Deterministic resolver | IMPLEMENTED, TESTED, DEPLOYED | [Resolver](../backend/app/services/resolution_service.py), matcher/router tests, actual staging Cases | Fixture providers remain synthetic; database cap can omit a true candidate |
| Contradiction gates | IMPLEMENTED, TESTED, BENCHMARKED, DEPLOYED | [Gates](../backend/app/services/contradiction.py), [routing tests](../backend/tests/test_router.py), [C4 gate analysis](../backend/benchmarks/identity_resolution/results/c4/analysis.json) | Jr./Sr. and conflicting full middle names override high scores; no universal identity guarantee |
| Human review | IMPLEMENTED, TESTED, DEPLOYED | [Scoped decisions](../backend/app/api/cases.py), API workflow tests, E3 persisted browser review | Routing outcomes do not silently merge people or submit Accept/Reject |
| Synthetic retrieval/routing benchmark | BENCHMARKED, TESTED | [C1 held-out artifact](../backend/benchmarks/identity_resolution/results/test.json), [C4 held-out artifact](../backend/benchmarks/identity_resolution/results/c4/test.json), final logical reproduction | Synthetic data; separate retrieval implementation from the runtime database provider |
| Rejected semantic/ranking experiments | BENCHMARKED, TESTED | [C2 results](../backend/benchmarks/identity_resolution/results/c2/local-test.json), [C3 selection veto](../backend/benchmarks/identity_resolution/results/c3/selection.json), [methods](identity-resolution-benchmark.md) | MiniLM underperformed; LR/XGBoost gains were artifact-driven; Gemini embeddings unassessed |
| LangGraph investigation | IMPLEMENTED, TESTED | [Graph](../backend/app/services/investigation_graph.py), [real PostgreSQL checkpoints/resume](../backend/tests/test_investigation_integration.py) | Capability packaged in staging image but not executed publicly; additional retrieval is synthetic |
| Governed MCP v2 | IMPLEMENTED, TESTED | [Official Client/server and mapping](../backend/app/services/investigation_mcp.py), [governance tests](../backend/tests/test_investigation_mcp.py), real-service resume test | Embedded protocol boundary; no public MCP endpoint or arbitrary execution tools |
| OTel privacy/fail-open behavior | IMPLEMENTED, TESTED | [Allowlist/export guard](../backend/app/core/observability.py), [privacy/failure tests](../backend/tests/test_observability.py), Source metadata tests | In-memory/fake exporters; disabled publicly |
| Langfuse integration | IMPLEMENTED, TESTED | Shared provider, v4 processor filtering/masking tests, [investigation documentation](evidence-investigation.md) | No live Langfuse deployment/export claimed |
| DeepEval contracts | IMPLEMENTED, TESTED | [Deterministic artifact](../backend/benchmarks/ai_evaluation/results/deterministic.json), [network-blocking tests](../backend/tests/test_ai_evaluation.py), [method](ai-evaluation.md) | Scripted responses; no live judge, Confident AI login or upload |
| Docker runtime | IMPLEMENTED, TESTED, DEPLOYED | [Dockerfile](../backend/Dockerfile), final build/health/worker ping/UID 999, E4 shared image | Python base is a version tag, not an immutable source digest |
| Kubernetes / kind | IMPLEMENTED, TESTED | [Manifests and runner](../infrastructure/k8s/README.md), [kind CI workflow](../.github/workflows/kind.yml), final static render | Prior kind validation evidence retained; not production-hosted; no fresh kind run because runtime/manifests are unchanged |
| Northflank / private Redis | DEPLOYED, TESTED | [Deployment record](../infrastructure/northflank/README.md), E4 read-back/resource inventory, final health/async smoke | Sandbox constraints; private non-TLS Redis; available historical usage USD 0 is not a future cost guarantee |
| Vercel public Preview | DEPLOYED, TESTED | [Preview/isolation record](staging-preview.md), final public HTTP and staging bundle checks | Staging alias only; production aliases untouched |
| Neon staging separation | DEPLOYED, TESTED | [E4 control-plane and guarded migration evidence](e4-verification.md), final durable processing | Existing isolated branch/database; final audit did not rerun cloud migrations |
| Browser staging end-to-end acceptance | TESTED | E3 real Firebase/CSV/review flow and [E4 Sources/key/idempotency/isolation acceptance](e4-verification.md) | Prior browser evidence retained; final smoke was a lightweight authenticated HTTP check |

## Defensible evaluation claims

The held-out deterministic retrieval artifact reports Recall@1 **92.91%**, Recall@5 **100%** and Recall@10 **100%** among 127 positive queries. C4 retained thresholds **75/45**: 99 automatic matches over 130 queries, **0 unsafe automatic decisions observed in the held-out synthetic benchmark**, 23.85% review/abstention and 6/127 true-match rejections.

The dataset contains 880 synthetic identities and 2,600 records. Partition integrity keeps linked identities and duplicate feature profiles together. These results do not measure production accuracy, validate the 100-row database cap or guarantee real-world false-merge safety. The [benchmark report](identity-resolution-benchmark.md) preserves denominators and rejection rationale.

MiniLM was evaluated and rejected from runtime retrieval. Logistic Regression and XGBoost improved synthetic top-1, but the feature investigation exposed a missing-field dataset artifact; neither was adopted. Gemini embedding performance remains unassessed. Offline AI evaluation's scripted 1.0 scores are contract regressions, not live Gemini accuracy.

## Product operating model / vision

Today, CSV supports onboarding and ad-hoc incoming imports. REFERENCE Sources populate persistent master data; authenticated INCOMING Sources support ongoing programmatic resolution. A company can start with a batch review and later have its systems submit the same canonical Source contract without changing the resolution/review pipeline.

Salesforce, HubSpot, ERP systems, warehouses and internal applications could integrate by adapting their records to that contract and retaining their own external IDs. Those vendor connectors are an extension model, not implemented integrations. CSV reference loading would also require an adapter or an explicitly added importer; the current CSV endpoint creates incoming Cases.

## How to explain this project in an interview

**Problem:** Businesses accumulate duplicate and stale identities across systems. Exact matches miss legitimate changes; broad fuzzy matching risks joining different people.

**Product:** A multi-tenant identity-resolution workbench with a user/workspace model, machine integrations, credential lifecycle, asynchronous Jobs, provenance, review workflow, observability, deployment and operational history.

**Operational flow:** Reference data arrives through REFERENCE Sources; incoming identities arrive through CSV or INCOMING Sources. The system generates candidates and routes cases using deterministic evidence scores. Contradictions block unsafe likely-match recommendations. Humans handle ambiguous cases and own final decisions. LangGraph/MCP can gather governed evidence and recompute deterministic analysis. CSV reference import is not implemented.

**AI boundary:** AI interprets ambiguous evidence through validated schemas and approved operations. It cannot choose another workspace, override identity constraints, set final scores or make the reviewer's Accept/Reject decision.

**Engineering judgment:** I evaluated semantic and learned ranking alternatives, investigated apparent gains and retained the deterministic approach when the evidence did not justify adoption. The deployment is staging; hard-crash recovery and large candidate blocks remain documented operational constraints.

## Resume-ready bullets

- Built a multi-tenant identity-resolution workbench combining deterministic matching, contradiction gates and human review, with Firebase authentication and workspace-scoped authorization.
- Designed CSV onboarding and authenticated REFERENCE/INCOMING Source ingestion with PostgreSQL Jobs, Redis/Celery processing, credential rotation, provenance and HTTP/task idempotency.
- Implemented a LangGraph investigation workflow through governed MCP v2 tools, enforcing server-owned scope, grounded evidence and idempotent human interrupt/resume; verified it with disposable PostgreSQL and real-worker tests.
- Benchmarked deterministic, semantic and learned ranking approaches, rejecting artifact-driven gains; deployed public staging on Vercel/Northflank/Neon with optional privacy-safe tracing and Kubernetes/kind validation.

## Release boundaries and limitations

Synthetic data provides no real-world false-merge guarantee. Gemini embeddings and live DeepEval judging were not run. LangGraph/MCP and live OTel/Langfuse export were not exercised in public staging. Kubernetes was validated with kind, not production hosting. Candidate retrieval is capped at 100 blocked database rows; hard worker crashes require manual recovery. Public staging has Northflank Sandbox constraints and no availability/scale SLA.

One transient initial worker failure was observed during staging deployment. Subsequent complete end-to-end flows passed; root cause was not established. The final audit also records incomplete smoke observations before its successful run without assigning an unsupported cause.

Terraform was evaluated and intentionally not adopted because the currently managed infrastructure does not benefit from adding Terraform state. The portfolio environment remains staging. Production cutover would be a separate controlled release decision; production Vercel, Render, Neon, Firebase, DNS and `main` were not changed.
