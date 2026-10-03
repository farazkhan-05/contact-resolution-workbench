from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError, TimeoutError
from sqlalchemy.orm import Session

from app.core.auth import FirebaseIdentity, bearer_scheme, get_firebase_identity
from app.core.bootstrap_diagnostics import BootstrapDiagnostics, BootstrapRoute
from app.core.bootstrap_errors import is_transient_database_error, is_uid_creation_conflict
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
    # Replay only this idempotent unit of work, once, after abandoning all state
    # from the failed transaction. No statement-level or generic request retries.
    for attempt in range(2):
        diagnostics.failed_phase = None
        try:
            return _bootstrap(identity, db, diagnostics)
        except Exception as exc:
            transient = is_transient_database_error(exc)
            retry = transient and not isinstance(exc, TimeoutError) and attempt == 0
            diagnostics.failure(exc)
            diagnostics.emit("bootstrap.recovery", attempt=attempt + 1, retry=retry)
            try:
                with diagnostics.phase("transaction_rollback"):
                    db.rollback()
            except SQLAlchemyError as rollback_error:
                diagnostics.failure(rollback_error)
                db.invalidate()
            finally:
                # Reset ORM state and release the failed connection before replay.
                db.close()
            if retry:
                continue
            if transient:
                raise HTTPException(
                    status_code=503,
                    detail="The workspace could not be initialized. Please retry.",
                    headers={"Retry-After": "1"},
                ) from None
            raise
    raise AssertionError("Bootstrap attempts exhausted")


def _bootstrap(
    identity: FirebaseIdentity, db: Session, diagnostics: BootstrapDiagnostics
) -> AuthBootstrapResponse:
    with diagnostics.phase("application_user"):
        user = _application_user(identity, db, diagnostics)

    with diagnostics.phase("membership_lookup"):
        memberships = db.scalars(
            select(WorkspaceMembership)
            .where(WorkspaceMembership.user_id == user.id)
            .order_by(WorkspaceMembership.created_at.asc(), WorkspaceMembership.id.asc())
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
                .order_by(WorkspaceMembership.created_at.asc(), WorkspaceMembership.id.asc())
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


def _application_user(
    identity: FirebaseIdentity, db: Session, diagnostics: BootstrapDiagnostics
) -> User:
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
        except IntegrityError as exc:
            # Only the known Firebase UID index is a normal create race.
            if not is_uid_creation_conflict(exc):
                raise
            diagnostics.emit("bootstrap.uid_conflict", category="uniqueness_race")
            user = db.scalar(
                select(User).where(User.firebase_uid == identity.uid).with_for_update()
            )
            if user is None:
                raise

    user.email = identity.email
    user.is_anonymous = identity.is_anonymous

    return user
