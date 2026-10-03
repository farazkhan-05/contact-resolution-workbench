from types import SimpleNamespace

import pytest
from sqlalchemy.exc import IntegrityError, OperationalError, TimeoutError

from app.core.bootstrap_errors import exception_category, is_transient_database_error


class DriverFailure(Exception):
    def __init__(self, code: str | None, constraint: str | None = None):
        self.sqlstate = code
        self.diag = SimpleNamespace(constraint_name=constraint)


@pytest.mark.parametrize("code", ["08001", "08006", "57P01", "57P02", "57P03", None])
def test_connection_failure_is_retryable(code: str | None) -> None:
    exc = OperationalError(None, None, DriverFailure(code))
    assert is_transient_database_error(exc)
    assert exception_category(exc) == "database_transient"


@pytest.mark.parametrize("code", ["28P01", "57014", "42P01", "40001"])
def test_other_database_errors_are_not_replayed(code: str) -> None:
    assert not is_transient_database_error(OperationalError(None, None, DriverFailure(code)))


@pytest.mark.parametrize("constraint", ["ix_users_firebase_uid", "other_unique_index", None])
def test_only_uid_index_is_a_normal_unique_race(constraint: str | None) -> None:
    exc = IntegrityError(None, None, DriverFailure("23505", constraint))
    assert not is_transient_database_error(exc)
    assert exception_category(exc) == (
        "uniqueness_race" if constraint == "ix_users_firebase_uid" else "data_integrity"
    )


def test_pool_timeout_is_retryable_for_caller() -> None:
    assert exception_category(TimeoutError()) == "database_transient"
