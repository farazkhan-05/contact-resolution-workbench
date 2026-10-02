# AI evaluation

`backend/benchmarks/ai_evaluation` evaluates the Gemini extraction boundary and the
LangGraph investigation through its real embedded MCP client/server. Dataset
`d4-synthetic-v1` contains 36 authored synthetic cases across 17 categories: clean
extraction, missing/conflicting fields, historical contact details, misleading notes,
prompt injection, suffix/middle-name contradictions, insufficient evidence, approved
retrieval, existing evidence, human input, unsupported requests, malformed output,
fabrication, and provider failure/retry. It reuses D1/D2 synthetic Elena Rostova notes.
No production records or external scraping are used.

## Offline checks

From `backend`:

```sh
uv sync --frozen --group ai-evaluation
uv run --frozen --group ai-evaluation pytest
uv run --frozen --group ai-evaluation python -m benchmarks.ai_evaluation
```

DeepEval 4.2.7 is pinned in the optional `ai-evaluation` dependency group. It is
excluded from the backend runtime image. DeepEval needs Click 8.3.3 and Rich 14.3.4 in its environment. The lock preserves
runtime Click 8.5.0 and all existing benchmark package versions. Because the
semantic benchmark needs a newer Click, uv declares these independent experiment
groups mutually exclusive; install each separately. No unrelated packages were upgraded.
Normal backend CI installs this group and runs only offline tests and evaluation.
A base install can run ordinary pytest without the group; D4 tests then skip.

Offline execution supplies scripted model responses to the actual Gemini parser,
then executes the actual graph against isolated SQLite and in-memory checkpoints.
These are contract and governance regressions, not measurements of Gemini accuracy.
Captured tool calls include failures/retries. DeepEval `ToolPermissionMetric` checks
the MCP allowlist; `ToolCorrectnessMetric` compares exact expected sequences and
stable server-generated arguments. `available_tools` is omitted to avoid optimality
judging. `JsonCorrectnessMetric` scores raw model JSON before normalization, with
reason generation disabled. A fail-on-call model adapter prevents accidental judges.
Pytest disables DeepEval's automatically registered plugin.

Ordinary Python checks report micro field precision/recall/F1, exact agreement,
unsupported fields, escalation classification, provenance, scope, contradiction
preservation and final-decision attempts. Existing deterministic pytest security
and domain tests remain authoritative. The suite also proves that malformed or
fabricated investigation output is rejected without persisting new evidence.

The checked-in [deterministic artifact](../backend/benchmarks/ai_evaluation/results/deterministic.json) has no timestamps, random IDs, prompts,
model output or credentials. Two runs must produce identical logical results.
Its schema-valid rate is 15/18: two intentionally malformed outputs and one provider
failure have no valid JSON. All three match the expected rejection labels, giving
100% schema expectation accuracy. Scripted field precision/recall/F1 are 1.0;
these values do not establish live model performance.

## Optional live evaluation

Explicitly set `GEMINI_API_KEY` and `AI_EVAL_JUDGE_MODEL`, then run:

```sh
uv run --frozen --group ai-evaluation python -m benchmarks.ai_evaluation --live
```

`AI_EVAL_APP_MODEL` optionally overrides the application's configured `GEMINI_MODEL`.
`AI_EVAL_JUDGE_API_KEY` optionally uses separate judge credentials; otherwise the
explicit Gemini key is shared. Credentials are environment variables, never source
or artifact fields. Missing credentials/configuration produce a clean `skipped`
report while offline checks still run; no judge scores are synthesized.

The live subset contains 15 representative cases. The real application extractor
and planner run before judging their actual outputs. DeepEval's native `GeminiModel`
reuses the installed `google-genai` SDK. Two G-Eval criteria assess semantic evidence
grounding and investigation action usefulness. Schema, permission, contradictions,
scope and final decisions continue to use deterministic checks. Model or judge
failures produce safe status labels without exception text or fabricated scores.
Live domain regressions fail the command regardless of subjective scores.

Live artifacts record both model identifiers, safe per-case deterministic metrics,
judge scores and UTC execution time. Both models currently use the Gemini family;
even different model identifiers do not provide independent model-family validation.
Judge scores support review and never authorize tool use or override domain rules.
No live performance numbers are claimed by D4's offline verification.

The command writes `results/live.json` (gitignored) unless `--output` selects another
local path. It runs only when explicitly invoked; there is no paid PR, push, scheduled
or manual GitHub workflow. No DeepEval login, Confident AI project, data upload,
Langfuse credentials or production telemetry export is used. Evaluation disables
DeepEval analytics, persisted login discovery and cloud trace sampling before import;
it uses standalone metric calls rather than cloud-managed evaluation/tracing.

TaskCompletionMetric and MCP task-completion judges are omitted: their trace-based
judging adds no distinct question beyond the labelled bounded workflow outcomes and
existing MCP integration tests.
