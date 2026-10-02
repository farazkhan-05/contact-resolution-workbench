"""Bounded LangGraph investigation through the official embedded MCP client."""

from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import RetryPolicy, interrupt
from sqlalchemy.orm import Session, sessionmaker

from app.core.observability import annotate, traced
from app.schemas.investigation import EvidenceGap, HumanResponse, Operation
from app.services.extractor import GeminiExtractor
from app.services.investigation_mcp import (
    OPERATION_TO_TOOL,
    CaseRequest,
    EvidenceRequest,
    MCPToolFailure,
    ReviewRequest,
    call_investigation_tool,
)
from app.services.investigation_operations import (
    InvestigationState,
    interrupt_context,
)
from app.services.investigation_operations import (
    is_transient as domain_is_transient,
)


def is_transient(exc: Exception) -> bool:
    return (isinstance(exc, MCPToolFailure) and exc.error.retryable) or domain_is_transient(exc)


class MCPInvestigationOperations:
    def __init__(self, sessions: sessionmaker[Session], extractor: GeminiExtractor) -> None:
        self.sessions = sessions
        self.extractor = extractor

    def call(self, state: InvestigationState, name: str, request: CaseRequest) -> dict[str, Any]:
        return call_investigation_tool(self.sessions, self.extractor, state, name, request)

    @traced("investigation.plan", **{"workflow.node": "plan", "langfuse.observation.type": "agent"})
    def plan(self, state: InvestigationState) -> InvestigationState:
        context = self.call(state, "get_resolution_case", CaseRequest(case_id=state["case_id"]))
        artifact_id = context.pop("artifact_id")
        gap = (
            EvidenceGap(category="human_clarification", operation=Operation.HUMAN_INPUT)
            if artifact_id is None
            else EvidenceGap.model_validate(self.extractor.determine_evidence_gap(context))
        )
        if gap.operation == Operation.RETRIEVE_SYNTHETIC_NOTES and artifact_id is None:
            raise ValueError("Selected operation is unavailable.")
        return {
            "evidence_gap": gap.category,
            "operation": gap.operation.value,
            "artifact_id": artifact_id,
            "notes_used": False,
            "outcome": None,
        }

    @traced("investigation.retrieve", **{"workflow.node": "retrieve"})
    def retrieve(self, state: InvestigationState) -> InvestigationState:
        if state.get("notes_used"):
            raise ValueError("Synthetic operation budget exhausted.")
        self.call(
            state,
            OPERATION_TO_TOOL[Operation.RETRIEVE_SYNTHETIC_NOTES],
            CaseRequest(case_id=state["case_id"]),
        )
        return {"notes_used": True, "extracted": {}}

    @traced("investigation.analyze", **{"workflow.node": "analyze"})
    def analyze(self, state: InvestigationState) -> InvestigationState:
        result = self.call(
            state,
            OPERATION_TO_TOOL[Operation.INSPECT_EXISTING],
            EvidenceRequest(case_id=state["case_id"]),
        )
        return {
            "deterministic_routing": result["deterministic_routing"],
            "blocking": result["blocking"],
            "outcome": result["outcome"],
        }

    @traced("investigation.human", **{"workflow.node": "human"})
    def human(self, state: InvestigationState) -> InvestigationState:
        self.call(
            state,
            OPERATION_TO_TOOL[Operation.HUMAN_INPUT],
            ReviewRequest.model_validate(
                {
                    "case_id": state["case_id"],
                    "reason": state.get("evidence_gap", "human_clarification"),
                }
            ),
        )
        return human(state)


def human(state: InvestigationState) -> InvestigationState:
    # No side effects precede interrupt. This node restarts on resume.
    annotate(**{"investigation.interrupted": True})
    response = interrupt(interrupt_context(state), response_schema=HumanResponse)
    annotate(**{"investigation.resumed": True})
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
    operations = MCPInvestigationOperations(sessions, extractor or GeminiExtractor())
    graph = StateGraph(InvestigationState)
    retry = RetryPolicy(max_attempts=3, initial_interval=0.1, jitter=False, retry_on=is_transient)
    graph.add_node("determine_gap", operations.plan, retry_policy=retry)
    graph.add_node("retrieve", operations.retrieve, retry_policy=retry)
    graph.add_node("deterministic_analysis", operations.analyze)
    graph.add_node("human_input", operations.human)
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
    graph.add_edge("retrieve", "deterministic_analysis")
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
