from pydantic import BaseModel, Field

from app.core.constants import ContradictionSeverity, RoutingStatus


class CaseQuery(BaseModel):
    name: str | None = None
    first_name: str | None = None
    middle_name: str | None = None
    last_name: str | None = None
    name_suffix: str | None = None
    email: str | None = None
    phone: str | None = None
    employer: str | None = None
    location: str | None = None


class RawCandidate(BaseModel):
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
    provenance_summary: str


class MatchEvidenceResult(BaseModel):
    field_name: str
    source_value: str | None = None
    candidate_value: str | None = None
    points_awarded: int = 0
    max_points: int = 0
    match_method: str
    explanation: str


class ContradictionResult(BaseModel):
    contradiction_type: str
    severity: ContradictionSeverity
    description: str
    blocks_likely_match: bool = False


class CandidateResolution(BaseModel):
    candidate: RawCandidate
    total_score: int = 0
    name_score: int = 0
    email_score: int = 0
    phone_score: int = 0
    employer_score: int = 0
    location_score: int = 0
    field_evidence: list[MatchEvidenceResult] = Field(default_factory=list)
    contradictions: list[ContradictionResult] = Field(default_factory=list)
    has_serious_contradiction: bool = False


class CaseResolution(BaseModel):
    query: CaseQuery
    candidates: list[CandidateResolution] = Field(default_factory=list)
    top_score: int = 0
    routing_status: RoutingStatus
    routing_reason: str
