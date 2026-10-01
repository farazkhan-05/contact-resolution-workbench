"""Embedded MCP protocol boundary for the existing investigation services.

Construction is transport independent. Only the worker uses Client(server); no HTTP
application, credentials, model-selected tool names, or general-purpose execution.
"""

import asyncio
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal, TypeVar

from mcp import Client
from mcp.server import MCPServer
from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
from mcp.types import CallToolResult, ListToolsResult, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models.audit import AuditLog
from app.models.case import CandidateRecord, Case, MatchEvidence
from app.models.investigation import InvestigationRun
from app.schemas.investigation import EvidenceGapCategory, Operation
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.investigation_operations import (
    InvestigationOperations,
    InvestigationState,
    approved_artifact,
    is_transient,
)

Identifier = Annotated[
    str,
    Field(min_length=36, max_length=36, pattern=r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$"),
]
ShortText = Annotated[str, Field(min_length=1, max_length=255)]
Category = Literal[
    "unauthorized_or_not_found",
    "invalid_argument",
    "provider_failure",
    "deterministic_validation_failure",
    "internal_failure",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CaseRequest(StrictModel):
    case_id: Identifier


class EvidenceRequest(CaseRequest):
    evidence_id: Identifier | None = None


class CandidateRequest(CaseRequest):
    candidate_id: Identifier


class ReviewRequest(CaseRequest):
    reason: EvidenceGapCategory
    # There is deliberately no identity decision or arbitrary instruction field.


class Arguments[T: BaseModel](StrictModel):
    request: T


class ToolFailure(StrictModel):
    category: Category
    retryable: bool = False


class ToolResult[T: BaseModel](StrictModel):
    data: T | None = None
    error: ToolFailure | None = None


class CaseContext(StrictModel):
    missing_phone: bool
    missing_email: bool
    missing_employer: bool
    missing_location: bool
    candidate_count: int = Field(ge=0)
    blocking_contradictions: bool
    notes_available: bool
    artifact_id: Annotated[str, Field(max_length=100)] | None


class EvidenceItem(StrictModel):
    evidence_id: Identifier
    candidate_id: Identifier
    field_name: ShortText
    source_value: ShortText | None
    candidate_value: ShortText | None


class EvidenceContext(StrictModel):
    deterministic_routing: Literal["LIKELY_MATCH", "NEEDS_REVIEW", "NO_RELIABLE_MATCH"]
    blocking: bool
    outcome: Literal["EVIDENCE_READY"] | None
    evidence: list[EvidenceItem] = Field(max_length=100)


class CandidateContext(StrictModel):
    candidate_id: Identifier
    name: ShortText
    email: ShortText | None
    phone: ShortText | None
    employer: ShortText | None
    location: ShortText | None
    provider_source: ShortText
    has_serious_contradiction: bool


class NotesResult(StrictModel):
    notes_used: Literal[True] = True
    candidate_id: Identifier
    evidence_source: ShortText


class ReviewResult(StrictModel):
    human_review_required: Literal[True] = True


OPERATION_TO_TOOL = {
    Operation.INSPECT_EXISTING: "get_case_evidence",
    Operation.RETRIEVE_SYNTHETIC_NOTES: "retrieve_synthetic_notes",
    Operation.HUMAN_INPUT: "request_human_review",
}
TOOL_ARGUMENTS: dict[str, type[Arguments[Any]]] = {
    "get_resolution_case": Arguments[CaseRequest],
    "get_case_evidence": Arguments[EvidenceRequest],
    "retrieve_candidate": Arguments[CandidateRequest],
    "retrieve_synthetic_notes": Arguments[CaseRequest],
    "request_human_review": Arguments[ReviewRequest],
}


@dataclass(frozen=True)
class InvestigationScope:
    workspace_id: str
    run_id: str
    case_id: str

    @classmethod
    def from_run(cls, sessions: sessionmaker[Session], run_id: str) -> "InvestigationScope":
        # The API has authorized creation/resume; the worker receives only the durable run ID.
        with sessions() as db:
            run = db.scalar(
                select(InvestigationRun)
                .join(Case, Case.id == InvestigationRun.case_id)
                .where(
                    InvestigationRun.id == run_id,
                    Case.workspace_id == InvestigationRun.workspace_id,
                )
            )
            if run is None:
                raise ValueError("Investigation context is unavailable.")
            return cls(run.workspace_id, run.id, run.case_id)

    def state(self) -> InvestigationState:
        return {
            "workspace_id": self.workspace_id,
            "investigation_run_id": self.run_id,
            "case_id": self.case_id,
        }


class MCPToolFailure(ValueError):
    def __init__(self, error: ToolFailure) -> None:
        super().__init__(f"Governed evidence tool failed: {error.category}.")
        self.error = error


T = TypeVar("T", bound=BaseModel)


def create_tool_server(
    sessions: sessionmaker[Session],
    scope: InvestigationScope,
    extractor: GeminiExtractor,
) -> MCPServer[Any]:
    operations = InvestigationOperations(sessions, extractor)

    def authorize(request: CaseRequest) -> InvestigationState:
        state = scope.state()
        if request.case_id != scope.case_id:
            raise LookupError
        with sessions() as db:
            try:
                operations.load_case(db, state)
            except ValueError:
                raise LookupError from None
        return state

    def guarded(request: CaseRequest, action: Callable[[InvestigationState], T]) -> ToolResult[T]:
        try:
            return ToolResult(data=action(authorize(request)))
        except LookupError:
            return ToolResult(error=ToolFailure(category="unauthorized_or_not_found"))
        except Exception as exc:
            if isinstance(exc, GeminiExtractionError) and isinstance(
                exc.__cause__, ValidationError
            ):
                category: Category = "deterministic_validation_failure"
            elif is_transient(exc) or isinstance(exc, GeminiExtractionError):
                category = "provider_failure"
            elif isinstance(exc, (ValueError, ValidationError)):
                category = "deterministic_validation_failure"
            else:
                category = "internal_failure"
            return ToolResult(error=ToolFailure(category=category, retryable=is_transient(exc)))

    def record_provenance(
        name: str, category: str, request: CaseRequest | None, data: dict[str, Any]
    ) -> None:
        resource_key = (
            f"{request.case_id}:{getattr(request, 'candidate_id', '')}:"
            f"{getattr(request, 'evidence_id', '')}"
            if request
            else "invalid-arguments"
        )
        event_id = str(uuid.uuid5(uuid.UUID(scope.run_id), f"mcp:{name}:{resource_key}:{category}"))
        with sessions() as db:
            # Never create an audit row under a foreign/guessed case, or retain raw arguments.
            try:
                operations.load_case(db, scope.state())
            except ValueError:
                return
            if db.get(AuditLog, event_id) is None:
                db.add(
                    AuditLog(
                        id=event_id,
                        case_id=scope.case_id,
                        event_type="INVESTIGATION_MCP_TOOL",
                        actor="system",
                        payload={
                            "investigation_id": scope.run_id,
                            "mcp_tool": name,
                            "category": category,
                            "candidate_id": data.get("candidate_id"),
                            "evidence_source": data.get("evidence_source"),
                        },
                    )
                )
                db.commit()

    async def governance(ctx: ServerRequestContext[Any, Any], call_next: CallNext) -> HandlerResult:
        if ctx.method == "tools/list":
            listing = await call_next(ctx)
            if isinstance(listing, dict):
                listing = ListToolsResult.model_validate(listing)
            if isinstance(listing, ListToolsResult):
                for tool in listing.tools:
                    # Reflect the middleware's strict outer-argument contract in discovery.
                    tool.input_schema["additionalProperties"] = False
            return listing
        if ctx.method != "tools/call":
            return await call_next(ctx)
        params = ctx.params or {}
        raw_name = params.get("name")
        name = raw_name if isinstance(raw_name, str) else "unavailable"
        argument_model = TOOL_ARGUMENTS.get(name)
        try:
            if argument_model is None or set(params) - {"name", "arguments", "_meta"}:
                raise ValueError
            validated = argument_model.model_validate(params.get("arguments", {}))
        except (ValueError, ValidationError):
            # Do not let SDK validation echo input values (including attempted tokens).
            record_provenance(
                name if argument_model else "unavailable", "invalid_argument", None, {}
            )
            return CallToolResult(
                is_error=True,
                content=[TextContent(type="text", text="Invalid tool argument.")],
                structured_content={
                    "data": None,
                    "error": {"category": "invalid_argument", "retryable": False},
                },
            )
        try:
            result = await call_next(ctx)
            if isinstance(result, dict):
                result = CallToolResult.model_validate(result)
            if not isinstance(result, CallToolResult):
                raise ValueError
        except Exception:
            record_provenance(name, "internal_failure", validated.request, {})
            return CallToolResult(
                is_error=True,
                content=[TextContent(type="text", text="Tool unavailable.")],
                structured_content={
                    "data": None,
                    "error": {"category": "internal_failure", "retryable": False},
                },
            )
        structured = result.structured_content or {}
        error = structured.get("error")
        category = error["category"] if error else "success"
        record_provenance(name, category, validated.request, structured.get("data") or {})
        if error:
            return result.model_copy(update={"is_error": True})
        return result

    async def safe_governance(
        ctx: ServerRequestContext[Any, Any], call_next: CallNext
    ) -> HandlerResult:
        try:
            return await governance(ctx, call_next)
        except Exception:
            if ctx.method != "tools/call":
                raise
            # Audit/storage errors also remain sanitized; never hand raw DB failures to SDK logging.
            return CallToolResult(
                is_error=True,
                content=[TextContent(type="text", text="Tool unavailable.")],
                structured_content={
                    "data": None,
                    "error": {"category": "internal_failure", "retryable": False},
                },
            )

    server: MCPServer[Any] = MCPServer("investigation-evidence", middleware=[safe_governance])

    @server.tool(annotations=ToolAnnotations(open_world_hint=False, read_only_hint=True))
    def get_resolution_case(request: CaseRequest) -> ToolResult[CaseContext]:
        """Read bounded planning facts for the authorized investigation case."""
        return guarded(request, lambda state: CaseContext.model_validate(operations.context(state)))

    @server.tool(annotations=ToolAnnotations(open_world_hint=False, read_only_hint=True))
    def get_case_evidence(request: EvidenceRequest) -> ToolResult[EvidenceContext]:
        """Read case evidence and authoritative deterministic recomputation."""

        def read(state: InvestigationState) -> EvidenceContext:
            with sessions() as db:
                query = (
                    select(MatchEvidence)
                    .join(CandidateRecord)
                    .where(CandidateRecord.case_id == scope.case_id)
                )
                if request.evidence_id:
                    query = query.where(MatchEvidence.id == request.evidence_id)
                rows = db.scalars(query.order_by(MatchEvidence.id).limit(100)).all()
                if request.evidence_id and not rows:
                    raise LookupError
                evidence = [
                    EvidenceItem(
                        evidence_id=row.id,
                        candidate_id=row.candidate_id,
                        field_name=row.field_name,
                        source_value=row.source_value,
                        candidate_value=row.candidate_value,
                    )
                    for row in rows
                ]
            return EvidenceContext.model_validate(
                {**operations.analyze(state), "evidence": evidence}
            )

        return guarded(request, read)

    @server.tool(annotations=ToolAnnotations(open_world_hint=False, read_only_hint=True))
    def retrieve_candidate(request: CandidateRequest) -> ToolResult[CandidateContext]:
        """Read only investigation fields of a candidate belonging to this case."""

        def read(state: InvestigationState) -> CandidateContext:
            with sessions() as db:
                row = db.scalar(
                    select(CandidateRecord).where(
                        CandidateRecord.id == request.candidate_id,
                        CandidateRecord.case_id == scope.case_id,
                    )
                )
                if row is None:
                    raise LookupError
                return CandidateContext(
                    candidate_id=row.id,
                    **{
                        field: getattr(row, field)
                        for field in CandidateContext.model_fields
                        if field != "candidate_id"
                    },
                )

        return guarded(request, read)

    @server.tool(
        annotations=ToolAnnotations(
            open_world_hint=False, idempotent_hint=True, destructive_hint=False
        )
    )
    def retrieve_synthetic_notes(request: CaseRequest) -> ToolResult[NotesResult]:
        """Obtain approved synthetic evidence, validate facts and persist idempotently."""

        def retrieve(state: InvestigationState) -> NotesResult:
            with sessions() as db:
                artifact = approved_artifact(operations.load_case(db, state))
                if artifact is None:
                    raise ValueError
                candidate_id = str(uuid.uuid5(uuid.UUID(scope.run_id), artifact.provider_record_id))
                existing = db.get(CandidateRecord, candidate_id)
                if existing and existing.case_id != scope.case_id:
                    raise LookupError
                if existing is None and db.scalar(
                    select(CandidateRecord.id).where(
                        CandidateRecord.case_id == scope.case_id,
                        CandidateRecord.provider_source == artifact.provider_source,
                        CandidateRecord.provider_record_id == artifact.provider_record_id,
                    )
                ):
                    raise ValueError("Synthetic source already obtained.")
            if existing is None:
                state.update({"artifact_id": artifact.provider_record_id, "notes_used": False})
                state.update(operations.retrieve(state))
                state.update(operations.extract(state))
                operations.persist(state)
            return NotesResult(candidate_id=candidate_id, evidence_source=artifact.provider_source)

        return guarded(request, retrieve)

    @server.tool(
        annotations=ToolAnnotations(
            open_world_hint=False, idempotent_hint=True, destructive_hint=False
        )
    )
    def request_human_review(request: ReviewRequest) -> ToolResult[ReviewResult]:
        """Request investigation input; only the graph's existing interrupt handles it."""
        return guarded(request, lambda state: ReviewResult())

    return server


def call_investigation_tool(
    sessions: sessionmaker[Session],
    extractor: GeminiExtractor,
    state: InvestigationState,
    name: str,
    request: CaseRequest,
) -> dict[str, Any]:
    scope = InvestigationScope.from_run(sessions, state["investigation_run_id"])
    if scope.workspace_id != state["workspace_id"] or scope.case_id != state["case_id"]:
        raise ValueError("Investigation context is unavailable.")
    if name not in TOOL_ARGUMENTS:
        raise MCPToolFailure(ToolFailure(category="invalid_argument"))

    async def invoke() -> dict[str, Any]:
        async with Client(create_tool_server(sessions, scope, extractor)) as client:
            listing = await client.list_tools()
            if name not in {tool.name for tool in listing.tools}:
                result = None
            else:
                result = await client.call_tool(name, {"request": request.model_dump(mode="json")})
        # Raise application failures outside the SDK task groups to preserve retry categories.
        structured = result.structured_content if result else None
        if result is None or result.is_error or not structured or structured.get("error"):
            raise MCPToolFailure(
                ToolFailure.model_validate(
                    structured["error"]
                    if structured and structured.get("error")
                    else {"category": "internal_failure"}
                )
            )
        data = structured.get("data")
        if not isinstance(data, dict):
            raise MCPToolFailure(ToolFailure(category="internal_failure"))
        return data

    try:
        return asyncio.run(invoke())
    except MCPToolFailure:
        raise
    except Exception:
        raise MCPToolFailure(ToolFailure(category="internal_failure")) from None
