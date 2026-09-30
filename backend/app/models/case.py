import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.constants import ReviewDecision, RoutingStatus
from app.core.database import Base

if TYPE_CHECKING:
    from app.models.audit import AuditLog
    from app.models.workspace import Workspace


class Case(Base):
    __tablename__ = "cases"
    __table_args__ = (
        UniqueConstraint("workspace_id", "case_number", name="uq_cases_workspace_case_number"),
    )

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    case_number: Mapped[str] = mapped_column(String(50), index=True, nullable=False)
    source_identifier: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Ingested raw attributes
    raw_name: Mapped[str] = mapped_column(String(255), nullable=False)
    normalized_name: Mapped[str] = mapped_column(String(255), nullable=False)
    name_prefix: Mapped[str | None] = mapped_column(String(50), nullable=True)
    first_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    middle_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    name_suffix: Mapped[str | None] = mapped_column(String(50), nullable=True)

    raw_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    normalized_email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    raw_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    normalized_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)

    raw_employer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    normalized_employer: Mapped[str | None] = mapped_column(String(255), nullable=True)

    raw_location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    normalized_location: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Routing & Review state
    routing_status: Mapped[str] = mapped_column(
        String(50),
        default=RoutingStatus.NEEDS_REVIEW.value,
        index=True,
        nullable=False,
    )
    review_decision: Mapped[str] = mapped_column(
        String(50),
        default=ReviewDecision.PENDING.value,
        index=True,
        nullable=False,
    )
    selected_candidate_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    reviewer_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )

    # Relationships
    candidates: Mapped[list["CandidateRecord"]] = relationship(
        "CandidateRecord",
        back_populates="case",
        cascade="all, delete-orphan",
        order_by="desc(CandidateRecord.total_score)",
    )
    audit_logs: Mapped[list["AuditLog"]] = relationship(
        "AuditLog",
        back_populates="case",
        cascade="all, delete-orphan",
        order_by="desc(AuditLog.created_at)",
    )
    workspace: Mapped["Workspace"] = relationship("Workspace", back_populates="cases")


class CandidateRecord(Base):
    __tablename__ = "candidate_records"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    case_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("cases.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    provider_source: Mapped[str] = mapped_column(String(100), nullable=False)
    provider_record_id: Mapped[str] = mapped_column(String(100), nullable=False)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    first_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    middle_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    name_suffix: Mapped[str | None] = mapped_column(String(50), nullable=True)

    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    employer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    job_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Deterministic integer score breakdown
    total_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    name_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    email_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    phone_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    employer_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    location_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    has_serious_contradiction: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    provenance_summary: Mapped[str] = mapped_column(String(500), nullable=False)

    # Relationships
    case: Mapped["Case"] = relationship("Case", back_populates="candidates")
    evidence: Mapped[list["MatchEvidence"]] = relationship(
        "MatchEvidence",
        back_populates="candidate",
        cascade="all, delete-orphan",
    )
    contradictions: Mapped[list["Contradiction"]] = relationship(
        "Contradiction",
        back_populates="candidate",
        cascade="all, delete-orphan",
    )


class MatchEvidence(Base):
    __tablename__ = "match_evidence"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    candidate_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("candidate_records.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    field_name: Mapped[str] = mapped_column(String(50), nullable=False)
    source_value: Mapped[str | None] = mapped_column(String(255), nullable=True)
    candidate_value: Mapped[str | None] = mapped_column(String(255), nullable=True)
    points_awarded: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_points: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    match_method: Mapped[str] = mapped_column(String(100), nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)

    candidate: Mapped["CandidateRecord"] = relationship(
        "CandidateRecord", back_populates="evidence"
    )


class Contradiction(Base):
    __tablename__ = "contradictions"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    candidate_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("candidate_records.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    contradiction_type: Mapped[str] = mapped_column(String(100), nullable=False)
    severity: Mapped[str] = mapped_column(String(50), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    blocks_likely_match: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    candidate: Mapped["CandidateRecord"] = relationship(
        "CandidateRecord", back_populates="contradictions"
    )
