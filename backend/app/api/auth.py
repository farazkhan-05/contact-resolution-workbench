from fastapi import APIRouter, Depends, Request
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import FirebaseIdentity, bearer_scheme, get_firebase_identity
from app.core.bootstrap_diagnostics import BootstrapDiagnostics, BootstrapRoute
from app.core.constants import WorkspaceRole
from app.core.database import get_db
from app.models.workspace import User, Workspace, WorkspaceMembership
from app.schemas.auth import AuthBootstrapResponse, UserResponse, WorkspaceResponse

router = APIRouter(prefix="/auth", tags=["auth"], route_class=BootstrapRoute)


def bootstrap_identity(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> FirebaseIdentity:
    diagnostics: BootstrapDiagnostics = request.state.bootstrap_diagnostics
    with diagnostics.phase("verified_token"):
        return get_firebase_identity(credentials)


@router.post("/bootstrap", response_model=AuthBootstrapResponse)
def bootstrap_authentication(
    request: Request,
    identity: FirebaseIdentity = Depends(bootstrap_identity),
    db: Session = Depends(get_db),
) -> AuthBootstrapResponse:
    """Create the application user and first workspace after Firebase verification."""
    diagnostics: BootstrapDiagnostics = request.state.bootstrap_diagnostics
    try:
        return _bootstrap(identity, db, diagnostics)
    except Exception:
        with diagnostics.phase("transaction_rollback"):
            db.rollback()
        raise


def _bootstrap(
    identity: FirebaseIdentity, db: Session, diagnostics: BootstrapDiagnostics
) -> AuthBootstrapResponse:
    with diagnostics.phase("application_user"):
        user = _application_user(identity, db)

    with diagnostics.phase("membership_lookup"):
        memberships = db.scalars(
            select(WorkspaceMembership)
            .where(WorkspaceMembership.user_id == user.id)
            .order_by(WorkspaceMembership.created_at.asc())
        ).all()
    if not memberships:
        with diagnostics.phase("workspace_create"):
            workspace = Workspace(
                name="Demo workspace" if identity.is_anonymous else "My workspace"
            )
            db.add(workspace)
            db.flush()
        with diagnostics.phase("membership_create"):
            db.add(
                WorkspaceMembership(
                    user_id=user.id,
                    workspace_id=workspace.id,
                    role=WorkspaceRole.OWNER.value,
                )
            )
            db.flush()
            memberships = db.scalars(
                select(WorkspaceMembership)
                .where(WorkspaceMembership.user_id == user.id)
                .order_by(WorkspaceMembership.created_at.asc())
            ).all()

    with diagnostics.phase("workspace_lookup"):
        workspaces = [
            WorkspaceResponse(
                id=membership.workspace.id, name=membership.workspace.name, role=membership.role
            )
            for membership in memberships
        ]
        response = AuthBootstrapResponse(
            user=UserResponse(id=user.id, is_anonymous=user.is_anonymous), workspaces=workspaces
        )
    with diagnostics.phase("transaction_commit"):
        db.commit()
    return response


def _application_user(identity: FirebaseIdentity, db: Session) -> User:
    user = db.scalar(select(User).where(User.firebase_uid == identity.uid).with_for_update())
    if user is None:
        try:
            with db.begin_nested():
                user = User(
                    firebase_uid=identity.uid,
                    email=identity.email,
                    is_anonymous=identity.is_anonymous,
                )
                db.add(user)
                db.flush()
        except IntegrityError:
            user = db.scalar(
                select(User).where(User.firebase_uid == identity.uid).with_for_update()
            )
            if user is None:
                raise
    else:
        user.email = identity.email
        user.is_anonymous = identity.is_anonymous

    return user
