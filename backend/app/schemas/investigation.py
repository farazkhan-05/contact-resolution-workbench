from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict


class Operation(StrEnum):
    INSPECT_EXISTING = "INSPECT_EXISTING"
    RETRIEVE_SYNTHETIC_NOTES = "RETRIEVE_SYNTHETIC_NOTES"
    HUMAN_INPUT = "HUMAN_INPUT"


type EvidenceGapCategory = Literal[
    "missing_phone",
    "missing_email",
    "conflicting_name",
    "employer_history",
    "geography",
    "insufficient_evidence",
    "human_clarification",
]


class EvidenceGap(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: EvidenceGapCategory
    operation: Operation


class HumanResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["STOP", "RETRIEVE_SYNTHETIC_NOTES"]


class InterruptContext(BaseModel):
    reason: str
    evidence_gap: str
    allowed_actions: list[str]


class InvestigationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    case_id: str
    status: Literal["PENDING", "RUNNING", "WAITING_FOR_HUMAN", "SUCCEEDED", "FAILED"]
    outcome: str | None
    current_step: str | None
    last_error_code: str | None
    last_error_message: str | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    interrupt: InterruptContext | None = None
