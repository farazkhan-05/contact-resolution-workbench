from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.api import JobResponse


class SourceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    source_type: Literal["REFERENCE", "INCOMING"]


class SourceStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["ACTIVE", "DISABLED"]


class SourceResponse(SourceCreate):
    model_config = ConfigDict(from_attributes=True)
    id: str
    workspace_id: str
    status: str
    key_prefix: str
    created_by: str
    created_at: datetime
    updated_at: datetime
    last_ingested_at: datetime | None


class SourceCredential(SourceResponse):
    api_key: str


class SourceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    external_record_id: str = Field(
        min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
    )
    full_name: str = Field(min_length=1, max_length=255)
    old_email: str | None = Field(default=None, max_length=255)
    old_phone: str | None = Field(default=None, max_length=50)
    employer: str | None = Field(default=None, max_length=255)
    location: str | None = Field(default=None, max_length=255)

    @field_validator("old_email")
    @classmethod
    def email_format(cls, value: str | None) -> str | None:
        if value and (value.count("@") != 1 or any(c.isspace() for c in value)):
            raise ValueError("Invalid email format")
        return value

    @field_validator("old_phone")
    @classmethod
    def phone_format(cls, value: str | None) -> str | None:
        if value and (
            not any(c.isdigit() for c in value) or any(c not in "+()- .0123456789" for c in value)
        ):
            raise ValueError("Invalid phone format")
        return value


class SourceBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    records: list[SourceRecord] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_ids(self) -> "SourceBatch":
        if len({r.external_record_id for r in self.records}) != len(self.records):
            raise ValueError("Duplicate external record IDs in batch")
        return self


class IngestionResponse(BaseModel):
    id: str
    source_id: str
    created_at: datetime
    job: JobResponse
