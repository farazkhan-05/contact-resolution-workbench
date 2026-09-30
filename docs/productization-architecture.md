# Productization architecture

The current application is a React/Vite frontend and a FastAPI/SQLAlchemy backend. It supports deterministic normalization and matching, contradiction detection, routing, reviewer decisions, append-only audit history, synthetic providers and benchmarks, CSV ingestion/export, Gemini structured extraction, anonymous demo telemetry, Firebase email/password and anonymous sign-in, and workspace isolation. Durable business state is stored in PostgreSQL; SQLite remains supported for local development and tests.

The deployed POC is: Browser -> Vercel frontend -> Render FastAPI -> Neon PostgreSQL. `main` remains the stable, currently deployed POC branch. `productization/v1` is the integration branch for this upgrade work.

The direction is an Identity Resolution Workbench that preserves the existing deterministic safety model. Gemini may extract or interpret ambiguous evidence, but it must not make the final identity decision, override contradictions, alter deterministic scores, or silently merge records. Deterministic contradiction detection and routing remain authoritative.

Firebase ID tokens are verified by the backend. The bootstrap endpoint creates an internal user and first workspace, while workbench endpoints require an authorized `X-Workspace-ID`; cases are workspace-owned and case numbers are unique within a workspace. Later work may add dataset/import jobs with Redis and Celery; benchmark-driven retrieval and ranking ML; LangGraph evidence investigation and governed MCP tools; OpenTelemetry, Langfuse, and targeted AI evaluation; and staging/deployment work with justified Terraform and Kubernetes/kind validation. None of those are implemented by this milestone.

The public portfolio deployment is limited to synthetic, anonymized, non-sensitive demonstration data.
