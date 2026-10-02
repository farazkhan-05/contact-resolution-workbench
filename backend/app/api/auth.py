from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import FirebaseIdentity, get_firebase_identity
from app.core.constants import WorkspaceRole
from app.core.database import get_db
from app.models.workspace import User, Workspace, WorkspaceMembership
from app.schemas.auth import AuthBootstrapResponse, UserResponse, WorkspaceResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/bootstrap", response_model=AuthBootstrapResponse)
def bootstrap_authentication(
    identity: FirebaseIdentity = Depends(get_firebase_identity), db: Session = Depends(get_db)
) -> AuthBootstrapResponse:
    """Create the application user and first workspace after Firebase verification."""
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

    memberships = db.scalars(
        select(WorkspaceMembership)
        .where(WorkspaceMembership.user_id == user.id)
        .order_by(WorkspaceMembership.created_at.asc())
    ).all()
    if not memberships:
        workspace = Workspace(name="Demo workspace" if identity.is_anonymous else "My workspace")
        db.add(workspace)
        db.flush()
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

    workspaces = [
        WorkspaceResponse(
            id=membership.workspace.id, name=membership.workspace.name, role=membership.role
        )
        for membership in memberships
    ]
    db.commit()
    return AuthBootstrapResponse(
        user=UserResponse(id=user.id, is_anonymous=user.is_anonymous), workspaces=workspaces
    )
