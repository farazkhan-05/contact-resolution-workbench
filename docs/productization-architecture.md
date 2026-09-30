# Productization architecture

The current application is a React/Vite frontend and a FastAPI/SQLAlchemy backend. It supports deterministic normalization and matching, contradiction detection, routing, reviewer decisions, append-only audit history, synthetic providers and benchmarks, CSV ingestion/export, Gemini structured extraction, and anonymous demo telemetry. Durable business state is stored in PostgreSQL; SQLite remains supported for local development and tests.

The deployed POC is: Browser -> Vercel frontend -> Render FastAPI -> Neon PostgreSQL. `main` remains the stable, currently deployed POC branch. `productization/v1` is the integration branch for this upgrade work.

The direction is an Identity Resolution Workbench that preserves the existing deterministic safety model. Gemini may extract or interpret ambiguous evidence, but it must not make the final identity decision, override contradictions, alter deterministic scores, or silently merge records. Deterministic contradiction detection and routing remain authoritative.

Later work may add authentication, workspaces, and tenant isolation; dataset/import jobs with Redis and Celery; benchmark-driven retrieval and ranking ML; LangGraph evidence investigation and governed MCP tools; OpenTelemetry, Langfuse, and targeted AI evaluation; and staging/deployment work with justified Terraform and Kubernetes/kind validation. None of these are implemented by this milestone.

The public portfolio deployment is limited to synthetic, anonymized, non-sensitive demonstration data.
