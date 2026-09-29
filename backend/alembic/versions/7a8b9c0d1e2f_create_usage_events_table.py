"""create_usage_events_table

Revision ID: 7a8b9c0d1e2f
Revises: 45f88e920446
Create Date: 2026-09-30 01:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7a8b9c0d1e2f"
down_revision: str | None = "45f88e920446"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "usage_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("event_name", sa.String(length=50), nullable=False),
        sa.Column("anonymous_session_id", sa.String(length=64), nullable=False),
        sa.Column("ref_code", sa.String(length=64), nullable=True),
        sa.Column("case_number", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("usage_events", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_usage_events_event_name"),
            ["event_name"],
            unique=False,
        )
        batch_op.create_index(
            batch_op.f("ix_usage_events_anonymous_session_id"),
            ["anonymous_session_id"],
            unique=False,
        )
        batch_op.create_index(
            batch_op.f("ix_usage_events_ref_code"),
            ["ref_code"],
            unique=False,
        )
        batch_op.create_index(
            batch_op.f("ix_usage_events_created_at"),
            ["created_at"],
            unique=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("usage_events", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_usage_events_created_at"))
        batch_op.drop_index(batch_op.f("ix_usage_events_ref_code"))
        batch_op.drop_index(batch_op.f("ix_usage_events_anonymous_session_id"))
        batch_op.drop_index(batch_op.f("ix_usage_events_event_name"))

    op.drop_table("usage_events")
