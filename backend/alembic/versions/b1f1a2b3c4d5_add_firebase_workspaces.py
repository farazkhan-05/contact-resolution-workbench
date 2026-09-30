"""add Firebase users and workspace case isolation

Revision ID: b1f1a2b3c4d5
Revises: 7a8b9c0d1e2f
Create Date: 2026-10-01 00:00:00.000000
"""

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa

from alembic import op

revision: str = "b1f1a2b3c4d5"
down_revision: str | None = "7a8b9c0d1e2f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEGACY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("firebase_uid", sa.String(length=128), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("is_anonymous", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_users_firebase_uid"), ["firebase_uid"], unique=True)

    op.create_table(
        "workspaces",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "workspace_memberships",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "workspace_id", name="uq_workspace_memberships_user_workspace"
        ),
    )
    with op.batch_alter_table("workspace_memberships", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_workspace_memberships_user_id"), ["user_id"], unique=False
        )
        batch_op.create_index(
            batch_op.f("ix_workspace_memberships_workspace_id"), ["workspace_id"], unique=False
        )

    now = datetime.now(UTC)
    op.bulk_insert(
        sa.table(
            "workspaces",
            sa.column("id", sa.String),
            sa.column("name", sa.String),
            sa.column("created_at", sa.DateTime(timezone=True)),
            sa.column("updated_at", sa.DateTime(timezone=True)),
        ),
        [
            {
                "id": LEGACY_WORKSPACE_ID,
                "name": "Legacy workspace",
                "created_at": now,
                "updated_at": now,
            }
        ],
    )

    with op.batch_alter_table("cases", schema=None) as batch_op:
        batch_op.add_column(sa.Column("workspace_id", sa.String(length=36), nullable=True))
        batch_op.create_foreign_key(
            "fk_cases_workspace_id_workspaces",
            "workspaces",
            ["workspace_id"],
            ["id"],
            ondelete="RESTRICT",
        )

    op.execute(
        sa.text(
            "UPDATE cases SET workspace_id = :workspace_id WHERE workspace_id IS NULL"
        ).bindparams(workspace_id=LEGACY_WORKSPACE_ID)
    )

    with op.batch_alter_table("cases", schema=None) as batch_op:
        batch_op.alter_column("workspace_id", existing_type=sa.String(length=36), nullable=False)
        batch_op.drop_index("ix_cases_case_number")
        batch_op.create_index("ix_cases_case_number", ["case_number"], unique=False)
        batch_op.create_index("ix_cases_workspace_id", ["workspace_id"], unique=False)
        batch_op.create_unique_constraint(
            "uq_cases_workspace_case_number", ["workspace_id", "case_number"]
        )


def downgrade() -> None:
    # This is valid while workspace-local case numbers remain globally unique.
    with op.batch_alter_table("cases", schema=None) as batch_op:
        batch_op.drop_constraint("uq_cases_workspace_case_number", type_="unique")
        batch_op.drop_index("ix_cases_workspace_id")
        batch_op.drop_index("ix_cases_case_number")
        batch_op.create_index("ix_cases_case_number", ["case_number"], unique=True)
        batch_op.drop_constraint("fk_cases_workspace_id_workspaces", type_="foreignkey")
        batch_op.drop_column("workspace_id")

    with op.batch_alter_table("workspace_memberships", schema=None) as batch_op:
        batch_op.drop_index("ix_workspace_memberships_workspace_id")
        batch_op.drop_index("ix_workspace_memberships_user_id")
    op.drop_table("workspace_memberships")
    op.drop_table("workspaces")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_index("ix_users_firebase_uid")
    op.drop_table("users")
