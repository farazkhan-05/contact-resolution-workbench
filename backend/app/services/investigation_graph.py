"""The sole graph: bounded investigation of ambiguous, synthetic evidence."""

import uuid
from datetime import UTC, datetime
from typing import Any, TypedDict

import httpx
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import RetryPolicy, interrupt
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models.audit import AuditLog
from app.models.case import CandidateRecord, Case, Contradiction, MatchEvidence
from app.models.investigation import InvestigationRun
from app.schemas.investigation import EvidenceGap, HumanResponse, Operation
from app.schemas.resolution import CaseQuery, ExtractedCandidateProfile, RawCandidate
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.normalizer import normalize_name, parse_name_parts
from app.services.providers import UNSTRUCTURED_EVIDENCE_FIXTURES, UnstructuredEvidenceRecord
from app.services.resolution_service import ResolutionService
from app.services.router import route_resolution


class InvestigationState(TypedDict, total=False):
    investigation_run_id: str
    workspace_id: str
    case_id: str
    evidence_gap: str
    operation: str
    artifact_id: str | None
    retrieved_at: str
    extracted: dict[str, Any]
    notes_used: bool
    blocking: bool
    deterministic_routing: str
    outcome: str | None
    human_action: str


def is_transient(exc: Exception) -> bool:
    cause = exc.__cause__ if isinstance(exc, GeminiExtractionError) else exc
    return isinstance(
        cause, (TimeoutError, ConnectionError, httpx.TimeoutException, httpx.NetworkError)
    ) or getattr(cause, "code", None) in (
        429,
        500,
        502,
        503,
        504,
    )


def case_query(case: Case) -> CaseQuery:
    return CaseQuery(
        name=case.raw_name,
        first_name=case.first_name,
        middle_name=case.middle_name,
        last_name=case.last_name,
        name_suffix=case.name_suffix,
        email=case.raw_email,
        phone=case.raw_phone,
        employer=case.raw_employer,
        location=case.raw_location,
    )


def approved_artifact(case: Case) -> UnstructuredEvidenceRecord | None:
    # Only existing local synthetic fixtures. Model/browser never selects an artifact ID.
    tokens = [token for token in normalize_name(case.raw_name).split() if len(token) > 2]
    return next(
        (
            record
            for record in UNSTRUCTURED_EVIDENCE_FIXTURES
            if tokens and all(t in record.raw_evidence_text.lower() for t in tokens)
        ),
        None,
    )


def interrupt_context(state: InvestigationState) -> dict[str, Any]:
    return {
        "reason": (
            "Contradictions require reviewer direction."
            if state.get("blocking")
            else "Available evidence still requires human review."
        ),
        "evidence_gap": state.get("evidence_gap", "human_clarification"),
        "allowed_actions": (
            ["STOP", "RETRIEVE_SYNTHETIC_NOTES"]
            if state.get("artifact_id") and not state.get("notes_used")
            else ["STOP"]
        ),
    }


class InvestigationOperations:
    def __init__(self, sessions: sessionmaker[Session], extractor: GeminiExtractor) -> None:
        self.sessions = sessions
        self.extractor = extractor

    def load_case(self, db: Session, state: InvestigationState) -> Case:
        case = db.scalar(
            select(Case).where(
                Case.id == state["case_id"], Case.workspace_id == state["workspace_id"]
            )
        )
        run = db.scalar(
            select(InvestigationRun).where(
                InvestigationRun.id == state["investigation_run_id"],
                InvestigationRun.workspace_id == state["workspace_id"],
                InvestigationRun.case_id == state["case_id"],
            )
        )
        if case is None or run is None:
            raise ValueError("Investigation context is unavailable.")
        if case.review_decision not in ("PENDING", "NEED_MORE_EVIDENCE"):
            raise ValueError("Case review has already finished.")
        return case

    def plan(self, state: InvestigationState) -> InvestigationState:
        with self.sessions() as db:
            case = self.load_case(db, state)
            artifact = approved_artifact(case)
            if artifact and any(
                candidate.provider_source == artifact.provider_source
                and candidate.provider_record_id == artifact.provider_record_id
                for candidate in case.candidates
            ):
                artifact = None
            context = {
                "missing_phone": not case.raw_phone,
                "missing_email": not case.raw_email,
                "missing_employer": not case.raw_employer,
                "missing_location": not case.raw_location,
                "candidate_count": len(case.candidates),
                "blocking_contradictions": any(
                    c.has_serious_contradiction for c in case.candidates
                ),
                "notes_available": artifact is not None,
            }
        # There is no useful automatic operation without an approved synthetic artifact.
        # Avoid spending a model call merely to rediscover that constraint.
        gap = (
            EvidenceGap(category="human_clarification", operation=Operation.HUMAN_INPUT)
            if artifact is None
            else EvidenceGap.model_validate(self.extractor.determine_evidence_gap(context))
        )
        if gap.operation == Operation.RETRIEVE_SYNTHETIC_NOTES and artifact is None:
            raise ValueError("Selected operation is unavailable.")
        return {
            "evidence_gap": gap.category,
            "operation": gap.operation.value,
            "artifact_id": artifact.provider_record_id if artifact else None,
            "notes_used": False,
            "outcome": None,
        }

    def retrieve(self, state: InvestigationState) -> InvestigationState:
        if state.get("notes_used"):
            raise ValueError("Synthetic operation budget exhausted.")
        with self.sessions() as db:
            artifact = approved_artifact(self.load_case(db, state))
            if artifact is None or artifact.provider_record_id != state.get("artifact_id"):
                raise ValueError("Invalid synthetic artifact.")
        # Reference only; raw source is reloaded at extraction, not copied to checkpoint.
        return {"retrieved_at": datetime.now(UTC).isoformat()}

    def extract(self, state: InvestigationState) -> InvestigationState:
        with self.sessions() as db:
            artifact = approved_artifact(self.load_case(db, state))
            if artifact is None or artifact.provider_record_id != state.get("artifact_id"):
                raise ValueError("Invalid synthetic artifact.")
        profile = ExtractedCandidateProfile.model_validate(
            self.extractor.extract_from_unstructured_text(artifact.raw_evidence_text)
        )
        # Ground every claimed value in the source, even after schema validation.
        for value in profile.model_dump().values():
            if value is not None and (
                not value.strip()
                or len(value) > 255
                or value.casefold() not in artifact.raw_evidence_text.casefold()
            ):
                raise ValueError("Extracted fact is unsupported by the source.")
        if not profile.name:
            raise ValueError("Extraction requires an explicit name.")
        return {"extracted": profile.model_dump()}

    def persist(self, state: InvestigationState) -> InvestigationState:
        candidate_id = str(
            uuid.uuid5(uuid.UUID(state["investigation_run_id"]), str(state["artifact_id"]))
        )
        with self.sessions() as db:
            case = self.load_case(db, state)
            artifact = approved_artifact(case)
            if artifact is None or artifact.provider_record_id != state.get("artifact_id"):
                raise ValueError("Invalid synthetic artifact.")
            if db.get(CandidateRecord, candidate_id) is None:
                profile = ExtractedCandidateProfile.model_validate(state["extracted"])
                raw = RawCandidate(
                    **profile.model_dump(),
                    provider_source=artifact.provider_source,
                    provider_record_id=artifact.provider_record_id,
                    provenance_summary=(
                        f"Synthetic notes; Gemini extraction; "
                        f"artifact {artifact.provider_record_id}; "
                        f"retrieved {state['retrieved_at']}"
                    ),
                )
                result = ResolutionService().resolve_candidate(case_query(case), raw)
                parts = parse_name_parts(raw.name)
                candidate = CandidateRecord(
                    id=candidate_id,
                    case_id=case.id,
                    **raw.model_dump(
                        exclude={"first_name", "middle_name", "last_name", "name_suffix"}
                    ),
                    first_name=parts.get("first_name"),
                    middle_name=parts.get("middle_name"),
                    last_name=parts.get("last_name"),
                    name_suffix=parts.get("suffix"),
                    **{
                        key: getattr(result, key)
                        for key in (
                            "total_score",
                            "name_score",
                            "email_score",
                            "phone_score",
                            "employer_score",
                            "location_score",
                            "has_serious_contradiction",
                        )
                    },
                )
                db.add(candidate)
                db.flush()
                for evidence in result.field_evidence:
                    db.add(MatchEvidence(candidate_id=candidate.id, **evidence.model_dump()))
                for contradiction in result.contradictions:
                    db.add(
                        Contradiction(
                            candidate_id=candidate.id, **contradiction.model_dump(mode="json")
                        )
                    )
                db.add(
                    AuditLog(
                        id=str(uuid.uuid5(uuid.UUID(candidate_id), "evidence-audit")),
                        case_id=case.id,
                        event_type="INVESTIGATION_EVIDENCE_ADDED",
                        actor="system",
                        payload={
                            "investigation_id": state["investigation_run_id"],
                            "candidate_id": candidate.id,
                            "artifact_id": artifact.provider_record_id,
                            "provider": artifact.provider_source,
                            "operation": Operation.RETRIEVE_SYNTHETIC_NOTES.value,
                            "retrieved_at": state["retrieved_at"],
                            "extracted_by": "Gemini",
                        },
                    )
                )
                db.commit()
        return {"notes_used": True, "extracted": {}}

    def analyze(self, state: InvestigationState) -> InvestigationState:
        with self.sessions() as db:
            case = self.load_case(db, state)
            resolver = ResolutionService()
            results = [
                resolver.resolve_candidate(
                    case_query(case),
                    RawCandidate(
                        **{key: getattr(candidate, key) for key in RawCandidate.model_fields}
                    ),
                )
                for candidate in case.candidates
            ]
        _, routing, _ = route_resolution(results)
        blocking = any(result.has_serious_contradiction for result in results)
        return {
            "deterministic_routing": routing.value,
            "blocking": blocking,
            "outcome": "EVIDENCE_READY"
            if routing.value == "LIKELY_MATCH" and not blocking
            else None,
        }


def human(state: InvestigationState) -> InvestigationState:
    # No side effects precede interrupt. This node restarts on resume.
    response = interrupt(interrupt_context(state), response_schema=HumanResponse)
    if response.action not in interrupt_context(state)["allowed_actions"]:
        raise ValueError("Human action is unavailable.")
    return {
        "human_action": response.action,
        "outcome": "HUMAN_REVIEW_REQUIRED" if response.action == "STOP" else None,
    }


def build_graph(
    sessions: sessionmaker[Session],
    checkpointer: BaseCheckpointSaver[Any],
    extractor: GeminiExtractor | None = None,
) -> CompiledStateGraph[Any, Any, Any, Any]:
    operations = InvestigationOperations(sessions, extractor or GeminiExtractor())
    graph = StateGraph(InvestigationState)
    retry = RetryPolicy(max_attempts=3, initial_interval=0.1, jitter=False, retry_on=is_transient)
    graph.add_node("determine_gap", operations.plan, retry_policy=retry)
    graph.add_node("retrieve", operations.retrieve, retry_policy=retry)
    graph.add_node("extract_validate", operations.extract, retry_policy=retry)
    graph.add_node("persist_evidence", operations.persist)
    graph.add_node("deterministic_analysis", operations.analyze)
    graph.add_node("human_input", human)
    graph.add_edge(START, "determine_gap")
    graph.add_conditional_edges(
        "determine_gap",
        lambda s: s["operation"],
        {
            Operation.RETRIEVE_SYNTHETIC_NOTES.value: "retrieve",
            Operation.INSPECT_EXISTING.value: "deterministic_analysis",
            Operation.HUMAN_INPUT.value: "human_input",
        },
    )
    graph.add_edge("retrieve", "extract_validate")
    graph.add_edge("extract_validate", "persist_evidence")
    graph.add_edge("persist_evidence", "deterministic_analysis")
    graph.add_conditional_edges(
        "deterministic_analysis",
        lambda s: "ready" if s.get("outcome") else "human",
        {"ready": END, "human": "human_input"},
    )
    graph.add_conditional_edges(
        "human_input",
        lambda s: s["human_action"],
        {"STOP": END, "RETRIEVE_SYNTHETIC_NOTES": "retrieve"},
    )
    return graph.compile(checkpointer=checkpointer)
