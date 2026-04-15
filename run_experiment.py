from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Optional

from translation_fusion import run_experiment_rows

logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Primary/secondary token-graph fusion experiment.\n\n"
            "By default uses the tiny stub adapters (no model weights needed).\n"
            "Pass real model names to use NLLB and TranslateGemma:\n"
            "  --primary-model facebook/nllb-200-distilled-600M\n"
            "  --secondary-model google/translategemma-4b-it\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("data/context_dataset.jsonl"),
        help="JSONL dataset with fields: text, context_before, source_lang, target_lang",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/fusion_run"),
        help="Directory where intermediary graphs and merged results are written.",
    )
    parser.add_argument(
        "--primary-weight",
        type=float,
        default=0.45,
        help="Merge weight for the primary model (default: 0.45).",
    )
    parser.add_argument(
        "--secondary-weight",
        type=float,
        default=0.55,
        help="Merge weight for the secondary model (default: 0.55).",
    )
    parser.add_argument(
        "--primary-model",
        type=str,
        default=None,
        help=(
            "HuggingFace model ID for the primary (NLLB-style) model. "
            "Example: facebook/nllb-200-distilled-600M. "
            "When omitted, the tiny stub adapter is used."
        ),
    )
    parser.add_argument(
        "--secondary-model",
        type=str,
        default=None,
        help=(
            "HuggingFace model ID for the secondary (TranslateGemma-style) model. "
            "Example: google/translategemma-4b-it. "
            "When omitted, the tiny stub adapter is used."
        ),
    )
    parser.add_argument(
        "--secondary-ollama-model",
        type=str,
        default=None,
        help=(
            "Ollama model name for the secondary model. "
            "Example: translategemma. "
            "Requires an Ollama server to be running (see --ollama-host). "
            "Takes precedence over --secondary-model when both are provided."
        ),
    )
    parser.add_argument(
        "--ollama-host",
        type=str,
        default="http://localhost:11434",
        help="Base URL of the Ollama server (default: http://localhost:11434).",
    )
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        help="Device for model inference (e.g. 'cpu', 'cuda', 'cuda:0'). "
             "Defaults to CUDA if available, otherwise CPU.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable INFO-level logging for model loading progress.",
    )
    return parser.parse_args()


def _build_adapters(args: argparse.Namespace):
    """Construct primary and secondary adapters based on CLI arguments."""
    from model_adapters import (
        NLLBAdapter,
        OllamaTranslateGemmaAdapter,
        TranslateGemmaAdapter,
        TinyPrimaryAdapter,
        TinySecondaryAdapter,
    )

    primary = (
        NLLBAdapter(model_name=args.primary_model, device=args.device)
        if args.primary_model
        else TinyPrimaryAdapter()
    )
    if args.secondary_ollama_model:
        secondary = OllamaTranslateGemmaAdapter(
            model_name=args.secondary_ollama_model,
            host=args.ollama_host,
        )
    elif args.secondary_model:
        secondary = TranslateGemmaAdapter(model_name=args.secondary_model, device=args.device)
    else:
        secondary = TinySecondaryAdapter()
    return primary, secondary


def main() -> None:
    args = parse_args()
    if args.verbose:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    rows = []
    for line in args.dataset.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))

    primary_adapter, secondary_adapter = _build_adapters(args)

    summaries = run_experiment_rows(
        rows=rows,
        output_dir=args.output_dir,
        primary_weight=args.primary_weight,
        secondary_weight=args.secondary_weight,
        primary_adapter=primary_adapter,
        secondary_adapter=secondary_adapter,
    )
    for idx, summary in enumerate(summaries, start=1):
        src_lang = summary.get("source_lang", "")
        tgt_lang = summary.get("target_lang", "")
        print(f"\n{'='*60}")
        print(f"Example {idx}  ({src_lang} → {tgt_lang})")
        print(f"Source:    {summary['source']}")
        print(f"Context:   {summary['context_before']}")
        print(f"Primary:   {summary['primary_best']}")
        print(f"Secondary: {summary['secondary_best']}")
        print(f"Final:     {summary['final']}")
        print(summary["impact_report"])


if __name__ == "__main__":
    main()
