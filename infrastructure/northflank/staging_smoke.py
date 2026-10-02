"""Real staging smoke; use two legitimate synthetic Firebase identities.

Run in the backend uv environment. Redis must be accessed through official
Northflank loopback forwarding, or from within the staging project network.
No Firebase overrides, local API substitutes, migrations, or production writes.
"""

import argparse
import ipaddress
import os
import socket
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from redis import Redis
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = ROOT / "backend"
if not (BACKEND_ROOT / "alembic").is_dir() and (ROOT / "alembic").is_dir():
    BACKEND_ROOT = ROOT
sys.path.insert(0, str(BACKEND_ROOT))


def required(key: str) -> str:
    value = os.environ.get(key, "")
    if not value:
        raise RuntimeError(f"Missing {key}")
    return value


def check(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def is_private_redis_host(host: str | None) -> bool:
    if host is None:
        return False
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".svc.cluster.local"):
        return True
    try:
        addresses = {
            ipaddress.ip_address(result[4][0])
            for result in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        }
    except OSError:
        return False
    return bool(addresses) and all(
        address.is_private or address.is_loopback or address.is_link_local for address in addresses
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm-staging", action="store_true")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    check(
        args.confirm_staging,
        "Verify separate staging resources, then pass --confirm-staging",
    )
    api_url = required("STAGING_API_URL")
    api = urlparse(api_url)
    check(
        api.scheme == "https"
        and api.hostname == required("EXPECTED_STAGING_API_HOST")
        and api.hostname.endswith(".code.run")
        and not api.username
        and not api.query,
        "Expected a Northflank staging HTTPS host",
    )
    database_url = required("STAGING_DATABASE_URL")
    db_url = make_url(database_url)
    check(
        db_url.get_backend_name() in {"postgres", "postgresql"}
        and db_url.host == required("EXPECTED_STAGING_NEON_HOST")
        and bool(db_url.host and db_url.host.endswith(".neon.tech")),
        "Expected the verified staging Neon host",
    )
    check(
        required("STAGING_NEON_BRANCH_ID") != required("PRODUCTION_NEON_BRANCH_ID"),
        "Staging must be a separate Neon branch",
    )
    broker_url = required("STAGING_BROKER_URL")
    broker = urlparse(broker_url)
    check(
        broker.scheme in {"redis", "rediss"}
        and broker.hostname is not None
        and is_private_redis_host(broker.hostname),
        "Use private Redis DNS or official loopback forwarding",
    )
    token_a, token_b = (
        required("STAGING_FIREBASE_TOKEN_A"),
        required("STAGING_FIREBASE_TOKEN_B"),
    )
    check(token_a != token_b, "Provide two distinct synthetic Firebase identities")
    # Explicit staging URLs take precedence over any backend .env defaults.
    os.environ.update(
        DATABASE_URL=database_url,
        CELERY_BROKER_URL=broker_url,
        OBSERVABILITY_ENABLED="false",
    )
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    from app.celery_app import celery_app
    from app.models.case import Case
    from app.models.job import Job
    from app.tasks import ingest_csv_job

    engine = create_engine(db_url.set(drivername="postgresql+psycopg"))
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    heads = set(ScriptDirectory.from_config(config).get_heads())
    with engine.connect() as db:
        check(
            set(db.scalars(text("SELECT version_num FROM alembic_version"))) == heads,
            "Migration head mismatch",
        )
    print("PASS staging Neon migration head")
    redis = Redis.from_url(broker_url)
    check(bool(redis.ping()), "Redis ping failed")
    check(
        bool(celery_app.control.inspect(timeout=5).ping()),
        "Worker did not answer broker ping",
    )
    print("PASS Redis connectivity and Celery readiness")

    with httpx.Client(base_url=api_url, timeout=15, follow_redirects=False) as client:
        health = client.get("/api/health")
        check(
            health.status_code == 200 and health.json() == {"status": "ok"},
            "API health failed",
        )
        check(
            client.get("/api/v1/cases").status_code == 401,
            "Missing-token boundary failed",
        )
        check(
            client.get(
                "/api/v1/cases",
                headers={"Authorization": "Bearer invalid-synthetic-token"},
            ).status_code
            == 401,
            "Invalid-token boundary failed",
        )

        def bootstrap(token: str) -> tuple[dict[str, str], str]:
            headers = {"Authorization": f"Bearer {token}"}
            response = client.post("/api/v1/auth/bootstrap", headers=headers)
            check(response.status_code == 200, "Firebase bootstrap failed")
            workspace = str(response.json()["workspaces"][0]["id"])
            headers["X-Workspace-ID"] = workspace
            return headers, workspace

        headers_a, workspace_a = bootstrap(token_a)
        headers_b, workspace_b = bootstrap(token_b)
        check(workspace_a != workspace_b, "Use identities in separate smoke workspaces")
        case_number = "E2-" + uuid.uuid4().hex[:12]
        submitted = client.post(
            "/api/v1/ingest/csv",
            headers=headers_a,
            files={
                "file": (
                    "synthetic-e2.csv",
                    f"case_number,full_name\n{case_number},Synthetic Staging Example\n",
                )
            },
        )
        check(submitted.status_code == 202, "CSV submission failed")
        job_id = str(submitted.json()["id"])
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            response = client.get(f"/api/v1/jobs/{job_id}", headers=headers_a)
            check(response.status_code == 200, "Job read failed")
            status = response.json()["status"]
            check(status != "FAILED", "Async CSV Job failed")
            if status == "SUCCEEDED":
                break
            time.sleep(1)
        else:
            raise RuntimeError("Async CSV Job timed out")
        with engine.connect() as db:
            row = db.execute(
                select(Case.id).where(
                    Case.workspace_id == workspace_a, Case.case_number == case_number
                )
            ).one()
            case_id = row[0]
            check(
                db.scalar(select(Job.workspace_id).where(Job.id == job_id)) == workspace_a,
                "Job workspace mismatch",
            )
        print("PASS HTTPS health, authentication, async SUCCEEDED and Neon Case persistence")

        for path in (f"/api/v1/jobs/{job_id}", f"/api/v1/cases/{case_id}"):
            check(
                client.get(path, headers=headers_b).status_code == 404,
                "Cross-workspace object access failed",
            )
            foreign = {**headers_a, "X-Workspace-ID": workspace_b}
            check(
                client.get(path, headers=foreign).status_code == 403,
                "Cross-workspace membership boundary failed",
            )
        print("PASS cross-workspace Job and Case denial")

    # Observe the duplicate's terminal worker event; an empty queue alone is insufficient.
    events: dict[str, str] = {}

    def terminal(event: dict[str, Any]) -> None:
        events[str(event["uuid"])] = str(event["type"])

    with celery_app.connection() as connection:
        receiver = celery_app.events.Receiver(
            connection, handlers={"task-succeeded": terminal, "task-failed": terminal}
        )
        with receiver.consumer_context():
            try:
                check(
                    bool(celery_app.control.enable_events(reply=True, timeout=5)),
                    "Worker did not acknowledge event monitoring",
                )
                duplicate = ingest_csv_job.delay(job_id, workspace_a)
                deadline = time.monotonic() + args.timeout
                while duplicate.id not in events and time.monotonic() < deadline:
                    try:
                        connection.drain_events(timeout=1)
                    except TimeoutError:
                        pass
                check(
                    events.get(duplicate.id) == "task-succeeded",
                    "Duplicate delivery completion was not observed",
                )
            finally:
                celery_app.control.disable_events()
    with engine.connect() as db:
        count = db.scalar(
            select(func.count())
            .select_from(Case)
            .where(Case.workspace_id == workspace_a, Case.case_number == case_number)
        )
        check(count == 1, "Duplicate delivery duplicated Case")
    engine.dispose()
    redis.close()
    print("PASS completed duplicate delivery leaves exactly one workspace Case")
    print(
        "LangGraph/MCP: not exercised by this CSV smoke; use the separate investigation procedure."
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 -- redact credential-bearing driver exceptions
        # Driver/network exceptions can contain credentials, URLs, or bearer tokens.
        print(
            "FAIL staging smoke; check required inputs and redacted staging logs.",
            file=sys.stderr,
        )
        sys.exit(1)
