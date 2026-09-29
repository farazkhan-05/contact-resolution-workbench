from unittest.mock import MagicMock

from sqlalchemy import create_engine

from app.core.config import Settings
from app.core.database import set_connection_timezone


def test_database_url_postgres_scheme_normalization() -> None:
    settings = Settings(
        DATABASE_URL="postgres://user:password@ep-sample.neon.tech/neondb?sslmode=require"
    )
    assert settings.DATABASE_URL.startswith("postgresql+psycopg://")
    assert "user:password@ep-sample.neon.tech/neondb?sslmode=require" in settings.DATABASE_URL


def test_database_url_postgresql_scheme_normalization() -> None:
    settings = Settings(DATABASE_URL="postgresql://user:password@localhost:5432/testdb")
    assert settings.DATABASE_URL == "postgresql+psycopg://user:password@localhost:5432/testdb"


def test_database_url_explicit_psycopg_preserved() -> None:
    settings = Settings(DATABASE_URL="postgresql+psycopg://user:password@localhost:5432/testdb")
    assert settings.DATABASE_URL == "postgresql+psycopg://user:password@localhost:5432/testdb"


def test_database_url_sqlite_preserved() -> None:
    settings = Settings(DATABASE_URL="sqlite:///./contact_resolution.db")
    assert settings.DATABASE_URL == "sqlite:///./contact_resolution.db"


def test_psycopg3_engine_creation_and_driver_resolution() -> None:
    engine = create_engine(
        "postgresql+psycopg://user:pass@localhost:5432/testdb",
        connect_args={"options": "-c timezone=utc"},
    )
    assert engine.url.drivername == "postgresql+psycopg"
    assert engine.dialect.name == "postgresql"
    assert engine.dialect.driver == "psycopg"
    assert engine.dialect.dbapi.__name__ == "psycopg"


def test_cors_origins_parsing_from_string() -> None:
    settings = Settings(
        CORS_ORIGINS="https://my-app.vercel.app, http://localhost:5173, http://127.0.0.1:5173"  # type: ignore[arg-type]
    )
    assert settings.CORS_ORIGINS == [
        "https://my-app.vercel.app",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_cors_origins_parsing_from_list() -> None:
    settings = Settings(CORS_ORIGINS=["https://my-app.vercel.app"])
    assert settings.CORS_ORIGINS == ["https://my-app.vercel.app"]


def test_set_connection_timezone_executes_on_postgresql() -> None:
    mock_connection = MagicMock()
    mock_cursor = MagicMock()
    mock_connection.cursor.return_value = mock_cursor

    from app.core.database import engine

    orig_dialect = engine.dialect.name
    try:
        engine.dialect.name = "postgresql"
        set_connection_timezone(mock_connection, None)
        mock_cursor.execute.assert_called_once_with("SET TIME ZONE 'UTC'")
        mock_cursor.close.assert_called_once()
    finally:
        engine.dialect.name = orig_dialect
