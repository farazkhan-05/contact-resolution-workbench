from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.core.constants import ContradictionSeverity, ReviewDecision, RoutingStatus
from app.schemas.resolution import ExtractedCandidateProfile


class SampleIngestResponse(BaseModel):
    ingested_count: int
    created_count: int
    existing_count: int
    case_ids: list[str]


class CsvIngestResponse(BaseModel):
    ingested_count: int
    created_count: int
    case_ids: list[str]


class JobResponse(BaseModel):
    id: str
    workspace_id: str
    job_type: str
    status: str
    total_rows: int | None = None
    processed_rows: int
    successful_rows: int
    rejected_rows: int
    source_label: str | None = None
    failure_code: str | None = None
    failure_message: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None


class UnstructuredEvidenceIngestRequest(BaseModel):
    raw_evidence_text: str = Field(
        ...,
        min_length=5,
        max_length=10_000,
        description="Messy unstructured provider evidence text",
    )
    source_identifier: str | None = Field(default=None, description="Optional source reference ID")
    case_number: str | None = Field(default=None, description="Optional case number override")


class UnstructuredIngestResponse(BaseModel):
    case_id: str
    case_number: str
    extracted_profile: ExtractedCandidateProfile
    routing_status: RoutingStatus
    top_score: int
    candidate_count: int


class CaseSummaryResponse(BaseModel):
    id: str
    case_number: str
    source_identifier: str | None = None
    person_name: str
    employer: str | None = None
    location: str | None = None
    routing_status: RoutingStatus
    review_decision: ReviewDecision
    top_score: int
    top_candidate_name: str | None = None
    has_serious_contradiction: bool = False
    candidate_count: int = 0
    last_activity_at: datetime
    created_at: datetime


class MatchEvidenceResponse(BaseModel):
    id: str
    field_name: str
    source_value: str | None = None
    candidate_value: str | None = None
    points_awarded: int
    max_points: int
    match_method: str
    explanation: str


class ContradictionResponse(BaseModel):
    id: str
    contradiction_type: str
    severity: ContradictionSeverity
    description: str
    blocks_likely_match: bool


class CandidateDetailResponse(BaseModel):
    id: str
    provider_source: str
    provider_record_id: str
    name: str
    first_name: str | None = None
    middle_name: str | None = None
    last_name: str | None = None
    name_suffix: str | None = None
    email: str | None = None
    phone: str | None = None
    employer: str | None = None
    job_title: str | None = None
    location: str | None = None
    total_score: int
    name_score: int
    email_score: int
    phone_score: int
    employer_score: int
    location_score: int
    has_serious_contradiction: bool
    provenance_summary: str
    evidence: list[MatchEvidenceResponse] = Field(default_factory=list)
    contradictions: list[ContradictionResponse] = Field(default_factory=list)


class AuditLogResponse(BaseModel):
    id: str
    event_type: str
    actor: str
    payload: dict[str, Any]
    created_at: datetime


class CaseDetailResponse(BaseModel):
    id: str
    case_number: str
    source_identifier: str | None = None

    # Original Raw vs Normalized
    raw_name: str
    normalized_name: str
    name_prefix: str | None = None
    first_name: str | None = None
    middle_name: str | None = None
    last_name: str | None = None
    name_suffix: str | None = None

    raw_email: str | None = None
    normalized_email: str | None = None

    raw_phone: str | None = None
    normalized_phone: str | None = None

    raw_employer: str | None = None
    normalized_employer: str | None = None

    raw_location: str | None = None
    normalized_location: str | None = None

    # Case State
    routing_status: RoutingStatus
    routing_explanation: str
    review_decision: ReviewDecision
    selected_candidate_id: str | None = None
    reviewer_notes: str | None = None
    reviewed_at: datetime | None = None
    created_at: datetime

    candidates: list[CandidateDetailResponse] = Field(default_factory=list)
    audit_logs: list[AuditLogResponse] = Field(default_factory=list)


class DecisionRequest(BaseModel):
    decision: ReviewDecision
    selected_candidate_id: str | None = None
    notes: str | None = Field(default=None, max_length=2000)
