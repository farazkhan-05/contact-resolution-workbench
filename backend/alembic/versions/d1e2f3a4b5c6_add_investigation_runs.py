"""Application investigation metadata; official saver owns checkpoint schema."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d1e2f3a4b5c6"
down_revision: str | None = "c2d3e4f5a6b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "investigation_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("workspaces.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "case_id", sa.String(36), sa.ForeignKey("cases.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "created_by_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("thread_id", sa.String(36), nullable=False, unique=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("outcome", sa.String(40)),
        sa.Column("current_step", sa.String(40)),
        sa.Column("resume_input", sa.JSON()),
        sa.Column("last_error_code", sa.String(80)),
        sa.Column("last_error_message", sa.String(500)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
    )
    for column in ("workspace_id", "case_id", "status"):
        op.create_index(f"ix_investigation_runs_{column}", "investigation_runs", [column])


def downgrade() -> None:
    op.drop_table("investigation_runs")
