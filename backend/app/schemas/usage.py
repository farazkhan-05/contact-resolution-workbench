import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.constants import UsageEventType

SAFE_IDENTIFIER_PATTERN = re.compile(r"^[a-zA-Z0-9_\-]+$")


class UsageEventCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_name: UsageEventType
    anonymous_session_id: str = Field(min_length=1, max_length=64)
    ref_code: str | None = Field(default=None, max_length=64)
    case_number: str | None = Field(default=None, max_length=64)

    @field_validator("anonymous_session_id")
    @classmethod
    def validate_anonymous_session_id(cls, v: str) -> str:
        trimmed = v.strip()
        if not trimmed or not SAFE_IDENTIFIER_PATTERN.match(trimmed):
            raise ValueError("Invalid anonymous_session_id format")
        return trimmed

    @field_validator("ref_code")
    @classmethod
    def validate_ref_code(cls, v: str | None) -> str | None:
        if v is None:
            return None
        trimmed = v.strip()
        if not trimmed:
            return None
        if not SAFE_IDENTIFIER_PATTERN.match(trimmed):
            raise ValueError("Invalid ref_code format")
        return trimmed

    @field_validator("case_number")
    @classmethod
    def validate_case_number(cls, v: str | None) -> str | None:
        if v is None:
            return None
        trimmed = v.strip()
        if not trimmed:
            return None
        if not SAFE_IDENTIFIER_PATTERN.match(trimmed):
            raise ValueError("Invalid case_number format")
        return trimmed
