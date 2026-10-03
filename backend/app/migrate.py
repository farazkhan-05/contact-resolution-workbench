"""Deployment-only schema initialization: Alembic, then the official Postgres saver."""

import sys
from pathlib import Path

from alembic.config import Config

from alembic import command
from app.services.investigation_service import setup_checkpoints


def migrate() -> None:
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    command.upgrade(config, "head")
    setup_checkpoints()


def main() -> None:
    try:
        migrate()
    except Exception as exc:
        # Database exception strings can contain credentials or evidence. Fail visibly
        # with safe diagnostic metadata rather than printing the exception body.
        print(f"Schema initialization failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1) from None
    print("Application migrations and PostgreSQL checkpoint initialization completed.")


if __name__ == "__main__":
    main()
