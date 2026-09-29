# Contact Resolution Workbench

A narrow, privacy-safe proof-of-concept (POC) for internal operations teams to review and resolve ambiguous contact/profile records against synthetic candidate sources using transparent, explainable deterministic evidence.

## Privacy & Safety Boundary

- **Synthetic Data Only**: Operates strictly on synthetic demo records and mock approved-provider fixtures.
- **No Live Scraping or OSINT**: Zero automated scraping or querying of live social networks (LinkedIn, Facebook, Instagram, Naukri, etc.).
- **Human Authoritative**: Automated scoring (0–100) and confidence routing are strictly advisory; human reviewers explicitly confirm, reject, or request more evidence.

## Quickstart

### 1. Backend Setup & Run

From the `backend` directory:

```bash
cd backend
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
```

- Health Check: `http://127.0.0.1:8000/api/health`
- OpenAPI Swagger Docs: `http://127.0.0.1:8000/docs`

### 2. Frontend Setup & Run

From the `frontend` directory:

```bash
cd frontend
npm install
npm run dev
```

- Web UI: `http://localhost:5173`

## Deterministic Scoring & Routing

Evidence scores are deterministic matching scores, not identity probabilities.

### Score Breakdown

| Field | Max Points | Match Criteria |
| :--- | :--- | :--- |
| **Name** | 30 | Exact match (30), Suffix/Middle initial match or RapidFuzz `token_sort_ratio` >= 90 (20), >= 70 (10) |
| **Email** | 25 | Exact normalized match (25) |
| **Phone** | 25 | Exact normalized digits (25) |
| **Employer** | 10 | Exact normalized match (10), RapidFuzz `token_set_ratio` >= 85 (6) |
| **Geography** | 10 | Exact City + State (10), Same State (5) |
| **Total** | **100** | Capped at 100 max points |

### Routing Policy

- **Score >= 75** and no SERIOUS contradiction -> `LIKELY_MATCH`
- **Score >= 75** with SERIOUS contradiction -> `NEEDS_REVIEW`
- **Score 45–74** -> `NEEDS_REVIEW`
- **Score < 45** or 0 candidates -> `NO_RELIABLE_MATCH`

### Contradictions

- **SERIOUS (blocks Likely Match)**: Incompatible name suffix (`Jr.` vs `Sr.`), conflicting explicit full middle name (`Alexander` vs `Anthony`).
- **MODERATE (advisory warning)**: Differing employer, differing geography.

## API Endpoints

### 1. Ingest
- `POST /api/v1/ingest/sample`: Idempotently loads the 8 benchmark synthetic scenarios.
- `POST /api/v1/ingest/csv`: Multipart upload of synthetic CSV profile batches (UTF-8 / UTF-8 BOM).

#### Documented CSV Schema
- **Required Columns**: `case_number`, `full_name`
- **Optional Columns**: `source_identifier`, `old_email`, `old_phone`, `employer`, `location`

Example:
```csv
case_number,full_name,old_email,old_phone,employer,location
CASE-CSV-01,Alice Springs,alice@springs.demo,+1 202-555-0101,Springs Co,Seattle WA
CASE-CSV-02,Bob Vance,bob@vance.demo,+1 202-555-0102,Vance Refrig,Austin TX
```

### 2. Cases Workspace
- `GET /api/v1/cases`: List case queue summaries (supports query params: `routing_status`, `review_decision`, `search`).
- `GET /api/v1/cases/{case_id}`: Full case investigation detail including original raw/normalized records, candidate matches with field-by-field evidence, contradictions, and append-only activity history.
- `POST /api/v1/cases/{case_id}/decision`: Submit reviewer verdict (`ACCEPTED` with `selected_candidate_id`, `REJECTED`, or `NEED_MORE_EVIDENCE` with optional plain-text `notes`).

### 3. Export
- `GET /api/v1/export/csv`: Export all reviewed non-pending cases as downloadable spreadsheet-safe CSV.

## Quality & Tests

Run tests and linters:

```bash
# Backend
cd backend
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy app

# Frontend
cd frontend
npm run lint
npx tsc --noEmit
npm run build
npm audit
```

## Deployment

Target architecture: **Browser -> Vercel (React/Vite) -> Render Web Service (FastAPI) -> Neon (PostgreSQL)**.

### 1. Database (Neon PostgreSQL)
1. Create a serverless PostgreSQL database on [Neon](https://neon.tech).
2. Copy the direct connection string (`postgresql://...` or `postgres://...` with `sslmode=require`). The backend automatically normalizes the URL to `postgresql+psycopg://` at runtime.

### 2. Backend (Render Web Service)
1. Create a new **Web Service** on [Render](https://render.com) linked to the repository.
2. Configure service settings:
   - **Root Directory**: `backend`
   - **Runtime**: `Python 3` (Python 3.13 is pinned via `backend/.python-version`)
   - **Build Command**: `uv sync --frozen`
   - **Start Command**: `uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - **Health Check Path**: `/api/health`
3. Environment Variables:
   - `DATABASE_URL`: `postgresql://<user>:<password>@<ep-id>.neon.tech/<dbname>?sslmode=require` (or direct `postgres://` URI provided by Neon)
   - `CORS_ORIGINS`: `https://<your-app>.vercel.app,http://localhost:5173`

> [!NOTE]
> Render Free tier web services spin down after inactivity and may cold-start on the first request. For low-latency demo evaluation, ensure the service is warmed or running on an active tier.

### 3. Frontend (Vercel)
1. Import the repository into [Vercel](https://vercel.com).
2. Configure project settings:
   - **Root Directory**: `frontend`
   - **Framework Preset**: `Vite`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. Environment Variables:
   - `VITE_API_BASE_URL`: `https://<your-render-service>.onrender.com`

## Anonymous Demo Usage Telemetry

A lightweight, first-party telemetry mechanism records basic interaction milestones without collecting personal data or using third-party trackers.

### Privacy Guarantees

- **Zero Third-Party SDKs**: No Google Analytics, Mixpanel, PostHog, or tracking pixels.
- **Zero PII & Data Leakage**: No IP addresses, user agents, visitor identities, uploaded CSV contents, candidate details, or reviewer notes are stored.
- **Session-Scoped Storage**: Ephemeral anonymous session ID stored in `sessionStorage` (regenerated per browser session).
- **Strict Allowlist**: Only predefined event types (`APP_OPENED`, `SAMPLE_CASES_LOADED`, `CASE_VIEWED`, `DECISION_SUBMITTED`, `CSV_UPLOADED`, `CSV_EXPORTED`) with bounded safe identifiers are accepted.

### Optional Referral Link

Shareable demo links can include an optional alphanumeric `ref` query parameter to distinguish traffic sources:

```text
https://your-app.example/?ref=interview-demo
```

### Inspecting Demo Usage (Neon SQL)

The application owner can inspect demo usage directly using SQL in the Neon Console:

#### 1. Recent Telemetry Events
```sql
SELECT event_name, ref_code, case_number, created_at
FROM usage_events
ORDER BY created_at DESC
LIMIT 100;
```

#### 2. Event Summary Breakdown
```sql
SELECT event_name, COUNT(*) AS event_count
FROM usage_events
GROUP BY event_name
ORDER BY event_count DESC;
```

#### 3. Unique Anonymous Sessions
```sql
SELECT COUNT(DISTINCT anonymous_session_id) AS total_sessions
FROM usage_events;
```

#### 4. Usage by Referral Tag
```sql
SELECT COALESCE(ref_code, '(direct / none)') AS referral_source,
       event_name,
       COUNT(*) AS count
FROM usage_events
GROUP BY ref_code, event_name
ORDER BY ref_code, count DESC;
```

> [!NOTE]
> `APP_OPENED` indicates that the web application was loaded in a browser tab. `CASE_VIEWED`, `SAMPLE_CASES_LOADED`, and `DECISION_SUBMITTED` indicate active interactive evaluation of the workbench. Security crawlers, link unfurlers, or bot scanners may occasionally open URLs, so `APP_OPENED` alone should not be interpreted as definitive proof of human interaction.


