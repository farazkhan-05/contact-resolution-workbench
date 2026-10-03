"""Safe bootstrap database classification; never inspect SQL or message text."""

from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError, TimeoutError


def sqlstate(exc: Exception) -> str | None:
    value = getattr(getattr(exc, "orig", None), "sqlstate", None)
    return value if isinstance(value, str) else None


def is_transient_database_error(exc: Exception) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    if not isinstance(exc, DBAPIError) or isinstance(exc, IntegrityError):
        return False
    code = sqlstate(exc)
    return (
        exc.connection_invalidated
        or (code is not None and (code.startswith("08") or code in {"57P01", "57P02", "57P03"}))
        # A failed initial psycopg connection has no server SQLSTATE.
        or (isinstance(exc, OperationalError) and code is None)
    )


def is_uid_creation_conflict(exc: IntegrityError) -> bool:
    return (
        sqlstate(exc) == "23505"
        and getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        == "ix_users_firebase_uid"
    )


def exception_category(exc: Exception) -> str:
    if is_transient_database_error(exc):
        return "database_transient"
    if isinstance(exc, IntegrityError):
        return "uniqueness_race" if is_uid_creation_conflict(exc) else "data_integrity"
    if isinstance(exc, DBAPIError):
        return "database"
    return "server"
