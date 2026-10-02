"""uv run --group ai-evaluation python -m benchmarks.ai_evaluation [--live]."""

import argparse
import json
from pathlib import Path

from benchmarks.ai_evaluation.runner import deterministic_results


def main() -> None:
    parser = argparse.ArgumentParser(description="Local synthetic AI contract evaluation")
    parser.add_argument("--live", action="store_true", help="Opt into Gemini SUT and G-Eval calls")
    parser.add_argument(
        "--output", type=Path, default=Path("benchmarks/ai_evaluation/results/deterministic.json")
    )
    args = parser.parse_args()
    result = deterministic_results()
    if args.live:
        from benchmarks.ai_evaluation.live import run_live

        result["live"] = run_live()
        if args.output == Path("benchmarks/ai_evaluation/results/deterministic.json"):
            args.output = Path("benchmarks/ai_evaluation/results/live.json")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "failures": result["failures"],
                "live_status": result["live"]["status"],
            }
        )
    )
    if result["failures"] or result["live"]["status"] == "partial_failure":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
