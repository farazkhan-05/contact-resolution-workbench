"""Standalone DeepEval metrics: no evaluate(), tracing, cloud, or judge client."""

from typing import Any

from deepeval.metrics import JsonCorrectnessMetric, ToolCorrectnessMetric, ToolPermissionMetric
from deepeval.models import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase, ToolCall, ToolCallParams

from app.schemas.resolution import ExtractedCandidateProfile
from app.services.investigation_mcp import TOOL_ARGUMENTS


class NoJudge(DeepEvalBaseLLM):  # type: ignore[no-untyped-call]
    """Some deterministic metric constructors require a model; fail on any use."""

    def load_model(self, *args: Any, **kwargs: Any) -> Any:
        return None

    def generate(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError("Deterministic evaluation attempted a judge call")

    async def a_generate(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError("Deterministic evaluation attempted a judge call")

    def get_model_name(self) -> str:
        return "disabled-no-judge"


def tool_scores(actual: list[ToolCall], expected: list[ToolCall]) -> tuple[float, float]:
    test = LLMTestCase(
        input="Synthetic governed investigation", tools_called=actual, expected_tools=expected
    )
    permission = ToolPermissionMetric(allowed_tools=sorted(TOOL_ARGUMENTS), strict_mode=True)
    correctness = ToolCorrectnessMetric(
        model=NoJudge(),
        async_mode=False,
        include_reason=False,
        should_exact_match=True,
        evaluation_params=[ToolCallParams.INPUT_PARAMETERS],
        eval_mode="llm",
    )
    # available_tools intentionally omitted: providing it enables paid optimality judging.
    return (
        permission.measure(test, _show_indicator=False),
        correctness.measure(test, _show_indicator=False),
    )


def schema_score(raw_output: str) -> float:
    metric = JsonCorrectnessMetric(
        # DeepEval's runtime API accepts a class; its annotation incorrectly says instance.
        expected_schema=ExtractedCandidateProfile,  # type: ignore[arg-type]
        model=NoJudge(),
        include_reason=False,
        async_mode=False,
        eval_mode="llm",
    )
    return metric.measure(
        LLMTestCase(input="Synthetic extraction", actual_output=raw_output), _show_indicator=False
    )


def field_counts(actual: dict[str, Any], expected: dict[str, str]) -> tuple[int, int, int]:
    predicted = {(key, value) for key, value in actual.items() if value is not None}
    labelled = set(expected.items())
    return len(predicted & labelled), len(predicted - labelled), len(labelled - predicted)


def field_scores(tp: int, fp: int, fn: int) -> dict[str, float]:
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    return {
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
    }


def escalation_counts(expected: bool, actual: bool) -> dict[str, int]:
    return {
        "correct": int(expected == actual),
        "failure_to_escalate": int(expected and not actual),
        "unnecessary_continuation": int(expected and not actual),
        "unnecessary_escalation": int(not expected and actual),
    }
