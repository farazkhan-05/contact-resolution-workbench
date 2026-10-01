import argparse
import json
from pathlib import Path

from benchmarks.identity_resolution.dataset import SPLITS, Config, generate
from benchmarks.identity_resolution.evaluate import evaluate, measure_latency


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Offline deterministic identity retrieval evaluation"
    )
    parser.add_argument("--split", choices=(*SPLITS, "all"), default="validation")
    parser.add_argument("--seed", type=int, default=20261001)
    parser.add_argument(
        "--output", type=Path, default=Path("benchmarks/identity_resolution/results")
    )
    parser.add_argument("--latency-repeats", type=int, default=5)
    args = parser.parse_args()
    data = generate(Config(seed=args.seed))
    args.output.mkdir(parents=True, exist_ok=True)

    def write(name: str, value: object) -> None:
        (args.output / name).write_text(
            json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

    write("manifest.json", data.manifest())
    for split in SPLITS:
        if args.split in (split, "all"):
            result = evaluate(data, split)
            latency = measure_latency(data, split, args.latency_repeats)
            write(f"{split}.json", result)
            write(f"{split}-latency.json", latency)
            print(
                json.dumps(
                    {
                        "split": split,
                        "corpus_size": result["corpus_size"],
                        "metrics": result["metrics"],
                        "latency": latency,
                    },
                    sort_keys=True,
                )
            )


if __name__ == "__main__":
    main()
