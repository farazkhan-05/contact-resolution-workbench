from collections.abc import Generator
from typing import Any

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings

connect_args: dict[str, Any] = {}
if settings.DATABASE_URL.startswith("sqlite"):
    connect_args["check_same_thread"] = False
elif "postgresql" in settings.DATABASE_URL or "postgres" in settings.DATABASE_URL:
    connect_args["options"] = "-c timezone=utc"

engine = create_engine(
    settings.DATABASE_URL,
    connect_args=connect_args,
    echo=False,
    # Validate idle backends at checkout. In-transaction disconnects still need
    # the operation to roll back and recover from its beginning.
    pool_pre_ping=True,
)


@event.listens_for(engine, "connect")
def set_connection_timezone(dbapi_connection: Any, connection_record: Any) -> None:
    """Enforce UTC session timezone on PostgreSQL connections."""
    if engine.dialect.name == "postgresql":
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("SET TIME ZONE 'UTC'")
        finally:
            cursor.close()


SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
