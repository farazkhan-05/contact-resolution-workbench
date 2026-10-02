"""Firebase token verification and workspace authorization dependencies."""

import json
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.workspace import User, Workspace, WorkspaceMembership

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class FirebaseIdentity:
    uid: str
    email: str | None
    is_anonymous: bool


@dataclass(frozen=True)
class WorkspaceContext:
    user: User
    workspace: Workspace
    membership: WorkspaceMembership


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication is required."
    )


def _firebase_app() -> Any:
    """Initialize Firebase Admin only when a token is actually verified."""
    try:
        import firebase_admin
        from firebase_admin import credentials

        if firebase_admin._apps:
            return firebase_admin.get_app()
        if settings.FIREBASE_SERVICE_ACCOUNT_JSON:
            service_account = json.loads(settings.FIREBASE_SERVICE_ACCOUNT_JSON)
            return firebase_admin.initialize_app(credentials.Certificate(service_account))
        return firebase_admin.initialize_app()
    except Exception as exc:
        raise _unauthorized() from exc


def verify_firebase_id_token(token: str) -> FirebaseIdentity:
    """Verify an ID token without ever trusting browser-provided identity fields."""
    try:
        from firebase_admin import auth

        decoded = auth.verify_id_token(token, app=_firebase_app())
        uid = decoded.get("uid") or decoded.get("sub")
        if not isinstance(uid, str) or not uid:
            raise ValueError("Token has no subject")
        firebase_info = decoded.get("firebase")
        sign_in_provider = (
            firebase_info.get("sign_in_provider") if isinstance(firebase_info, dict) else None
        )
        email = decoded.get("email")
        return FirebaseIdentity(
            uid=uid,
            email=email if isinstance(email, str) else None,
            is_anonymous=sign_in_provider == "anonymous",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _unauthorized() from exc


def get_firebase_identity(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> FirebaseIdentity:
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise _unauthorized()
    return verify_firebase_id_token(credentials.credentials)


def get_current_user(
    identity: FirebaseIdentity = Depends(get_firebase_identity),
    db: Session = Depends(get_db),
) -> User:
    user = db.scalar(select(User).where(User.firebase_uid == identity.uid))
    if user is None:
        raise _unauthorized()
    return user


def get_workspace_context(
    workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WorkspaceContext:
    if not workspace_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Workspace access is required."
        )
    membership = db.scalar(
        select(WorkspaceMembership).where(
            WorkspaceMembership.user_id == user.id,
            WorkspaceMembership.workspace_id == workspace_id,
        )
    )
    if membership is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Workspace access is denied."
        )
    workspace = db.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Workspace access is denied."
        )
    return WorkspaceContext(user=user, workspace=workspace, membership=membership)
