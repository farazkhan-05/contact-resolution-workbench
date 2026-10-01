"""Explicit kind-only auth fixture, mounted at runtime; absent from backend image."""

import hmac
import os

from fastapi import HTTPException

from app.core import auth
from app.main import app as app


def synthetic_identity(token: str) -> auth.FirebaseIdentity:
    if not hmac.compare_digest(token, os.environ["KIND_TEST_TOKEN"]):
        raise HTTPException(status_code=401, detail="Invalid synthetic test token")
    return auth.FirebaseIdentity("kind-synthetic-user", None, True)


auth.verify_firebase_id_token = synthetic_identity
