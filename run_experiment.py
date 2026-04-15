from __future__ import annotations

import argparse
import json
from pathlib import Path

from translation_fusion import run_experiment_rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Primary/secondary token-graph fusion experiment.")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("data/context_dataset.jsonl"),
        help="JSONL dataset with fields: text, context_before",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/fusion_run"),
        help="Where intermediary graphs and merged results are written.",
    )
    parser.add_argument("--primary-weight", type=float, default=0.45, help="Primary model merge weight.")
    parser.add_argument("--secondary-weight", type=float, default=0.55, help="Secondary model merge weight.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = []
    for line in args.dataset.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))

    summaries = run_experiment_rows(
        rows=rows,
        output_dir=args.output_dir,
        primary_weight=args.primary_weight,
        secondary_weight=args.secondary_weight,
    )
    for idx, summary in enumerate(summaries, start=1):
        print(f"\nExample {idx}")
        print(f"Source: {summary['source']}")
        print(f"Context: {summary['context_before']}")
        print(f"Primary best: {summary['primary_best']}")
        print(f"Secondary best: {summary['secondary_best']}")
        print(f"Final: {summary['final']}")
        print(summary["impact_report"])


if __name__ == "__main__":
    main()
