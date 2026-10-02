"""Sources, reference population and nullable historical Case provenance."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e4a1b2c3d4e5"
down_revision: str | None = "d1e2f3a4b5c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def identity() -> sa.Column[str]:
    return sa.Column("id", sa.String(36), primary_key=True)


def timestamp(name: str, nullable: bool = False) -> sa.Column[object]:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def link(name: str, table: str) -> sa.Column[str]:
    return sa.Column(name, sa.String(36), sa.ForeignKey(table + ".id"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "sources",
        identity(),
        link("workspace_id", "workspaces"),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("source_type", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("key_prefix", sa.String(50), nullable=False, unique=True),
        sa.Column("key_digest", sa.String(64), nullable=False),
        link("created_by", "users"),
        timestamp("created_at"),
        timestamp("updated_at"),
        timestamp("last_ingested_at", True),
    )
    op.create_table(
        "source_ingestions",
        identity(),
        link("source_id", "sources"),
        link("job_id", "jobs"),
        sa.Column("idempotency_digest", sa.String(64), nullable=False),
        sa.Column("payload_digest", sa.String(64), nullable=False),
        timestamp("created_at"),
        sa.UniqueConstraint("job_id"),
        sa.UniqueConstraint("source_id", "idempotency_digest", name="uq_source_retry"),
    )
    op.create_table(
        "reference_records",
        identity(),
        link("workspace_id", "workspaces"),
        link("source_id", "sources"),
        link("ingestion_id", "source_ingestions"),
        sa.Column("external_record_id", sa.String(100), nullable=False),
        sa.Column("full_name", sa.String(255), nullable=False),
        sa.Column("normalized_name", sa.String(255), nullable=False),
        sa.Column("normalized_email", sa.String(255)),
        sa.Column("normalized_phone", sa.String(50)),
        sa.Column("old_email", sa.String(255)),
        sa.Column("old_phone", sa.String(50)),
        sa.Column("employer", sa.String(255)),
        sa.Column("location", sa.String(255)),
        timestamp("created_at"),
        timestamp("updated_at"),
        sa.UniqueConstraint(
            "workspace_id", "source_id", "external_record_id", name="uq_source_reference"
        ),
    )
    op.create_table(
        "source_audits",
        identity(),
        link("source_id", "sources"),
        link("actor", "users"),
        sa.Column("event_type", sa.String(50), nullable=False),
        timestamp("created_at"),
    )
    for table, columns in [
        ("sources", ["workspace_id"]),
        ("source_ingestions", ["source_id"]),
        (
            "reference_records",
            [
                "workspace_id",
                "source_id",
                "normalized_name",
                "normalized_email",
                "normalized_phone",
            ],
        ),
        ("source_audits", ["source_id"]),
    ]:
        for column in columns:
            op.create_index(f"ix_{table}_{column}", table, [column])
    with op.batch_alter_table("cases") as batch:
        batch.add_column(sa.Column("source_id", sa.String(36)))
        batch.add_column(sa.Column("ingestion_id", sa.String(36)))
        batch.add_column(sa.Column("external_record_id", sa.String(100)))
        batch.create_foreign_key("fk_cases_source", "sources", ["source_id"], ["id"])
        batch.create_foreign_key(
            "fk_cases_ingestion", "source_ingestions", ["ingestion_id"], ["id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("cases") as batch:
        batch.drop_constraint("fk_cases_ingestion", type_="foreignkey")
        batch.drop_constraint("fk_cases_source", type_="foreignkey")
        for column in ["external_record_id", "ingestion_id", "source_id"]:
            batch.drop_column(column)
    for table in ["source_audits", "reference_records", "source_ingestions", "sources"]:
        op.drop_table(table)
