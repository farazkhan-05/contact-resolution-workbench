# Evidence investigation (D1)

Investigation is an explicit reviewer action on a NEEDS_REVIEW case whose decision is PENDING or NEED_MORE_EVIDENCE. Authentication, ingestion, scoring, case APIs, exports and final review submission remain outside LangGraph.

The graph has six nodes: determine_gap, retrieve, extract_validate, persist_evidence, deterministic_analysis and human_input. A structured Gemini assessment chooses a gap category and one operation from INSPECT_EXISTING, RETRIEVE_SYNTHETIC_NOTES or HUMAN_INPUT. The backend selects the source reference from existing synthetic fixtures; the model supplies no URLs, paths, provider names or executable arguments. When no unused approved note exists, the graph requests human direction without calling Gemini. A run retrieves at most one synthetic note, and a later run cannot retrieve a source already persisted for that case. No external evidence sources are connected.

Gemini extraction uses the existing configurable model boundary and timeout. Each non-null extracted value must be a bounded, explicit substring of the source. This conservative check can reject otherwise reasonable reformattings. Schema and grounding failures stop the investigation without adding evidence. Only connection failures, timeouts and provider status codes 429/500/502/503/504 receive node retries, with at most three attempts. SDK retries are disabled so they do not multiply the graph's retry budget. Deterministic failures do not retry.

Validated notes create a separate candidate, its deterministic MatchEvidence and Contradiction rows, and an AuditLog containing the provider, operation, artifact reference, candidate ID, retrieval time and Gemini extraction attribution. Existing candidates remain intact. The graph recomputes analysis with the unchanged resolver, weights, thresholds 75/45 and contradiction gates. Any blocking contradiction keeps the investigation in human review. EVIDENCE_READY describes the investigation outcome; it does not accept an identity or change the case's routing or reviewer decision. Other outcomes are HUMAN_REVIEW_REQUIRED, INSUFFICIENT_EVIDENCE and PROVIDER_UNAVAILABLE. The last two accompany failed evidence operations.

## Ownership and execution

InvestigationRun stores a UUID, workspace/case/creator IDs, an opaque server-generated thread ID, status, outcome, current step, timestamps, sanitized errors and temporary queued resume input. Status is PENDING, RUNNING, WAITING_FOR_HUMAN, SUCCEEDED or FAILED. Checkpoint state is not copied into this record. Public responses omit the internal thread ID, resume queue input and checkpoint internals.

The authenticated API supports POST and GET `/api/v1/cases/{case_id}/investigations`, GET `/api/v1/investigations/{id}`, and POST `/api/v1/investigations/{id}/resume`. Every lookup checks the active workspace and case ownership before reading checkpoints or queueing execution. The case lock makes repeated starts return the same active run. Celery receives only the application run ID; credentials and browser tokens stay outside graph and task state.

The worker records RUNNING, then holds a PostgreSQL FOR NO KEY UPDATE SKIP LOCKED row lock on the run throughout execution. Duplicate deliveries skip a busy run or observe its terminal/waiting status. Separate short transactions persist evidence, so a worker loss between a business commit and a checkpoint cannot lose the evidence. Candidate and evidence-audit identities derive deterministically from the run and source reference; replay of the persistence node finds the existing candidate instead of inserting duplicate evidence. Application status and lifecycle audit events commit together. Acks-late delivery and rejection on worker loss permit recovery from RUNNING using the existing checkpoint. This does not provide an outbox: a lost broker publication still requires operational recovery, as with the existing Job queue.

`human_input` calls `interrupt(..., response_schema=HumanResponse)` before any side effect. Its only actions are STOP or RETRIEVE_SYNTHETIC_NOTES, the latter available only while the approved note remains unused. STOP finishes the investigation and returns control to the existing review console. Resume validates the action, atomically transitions WAITING_FOR_HUMAN to PENDING and records the reviewer action. The queued response is bound to the server-read interrupt ID. The worker passes `Command(resume={interrupt_id: response})` on the same thread, preventing a stale delivery from answering a later interrupt. The interrupted node restarts; evidence writes occur in another node.

Graph checkpoints contain internal IDs, source references, gap/operation enums, small intermediate extraction fields and analysis flags. They contain no formatted prompts, full ORM objects, raw source snippets or authentication tokens. Historical checkpoints can retain intermediate extracted synthetic fields even after the latest state clears them.

## Initialize local runtime

Application migrations support SQLite, but runtime investigations require PostgreSQL. Initialize the official saver explicitly alongside migrations, before starting API and worker. Schema creation never happens on an API request:

```sh
docker compose up -d postgres redis
docker compose build api
docker compose run --rm api alembic upgrade head
docker compose run --rm api python -m app.services.investigation_service
docker compose up -d api worker
```

The common backend image serves both processes as a non-root user. The frontend polls pending/running investigations, restores the latest run when revisiting a case, shows allowed interrupt actions, and refreshes evidence after a pause or completion. Logout, workspace changes and case changes cancel polling and discard stale responses. Investigations never auto-start.

## Verification and limits

Normal pytest uses fake Gemini behavior and isolated in-memory checkpoints. The service-based CI job additionally uses disposable PostgreSQL and Redis: it verifies persisted checkpoint rows, closes and reconstructs the saver/graph, resumes the same thread, checks evidence and final status, tests concurrent worker delivery, and runs the graph through the real Celery worker. The existing ingestion integration remains in that job. Migration tests exercise upgrades, preservation of older case rows and downgrades on SQLite and a separate disposable PostgreSQL database. No live Gemini, Firebase, external providers or production databases are required.

Checkpoints accumulate. Retention, pruning and run-deletion policy remain an operational follow-up; D1 does not schedule cleanup. SQLite CRUD remains available, but production checkpointing never falls back to an in-memory saver. No MCP server, OpenTelemetry/Langfuse integration or LangSmith tracing is configured. LangSmith is an unavoidable transitive dependency of the official LangGraph distribution, not an adopted observability service.
