from __future__ import annotations

from dataclasses import dataclass, asdict
from difflib import SequenceMatcher
from pathlib import Path
from statistics import mean
from typing import Dict, Iterable, List, Sequence, Tuple
import json

WORD_SCORE_BASE = 0.9
SUBWORD_CONTINUATION_DISCOUNT = 0.98


@dataclass
class TokenWeight:
    token: str
    probability: float


@dataclass
class CandidatePath:
    token_weights: List[TokenWeight]
    path_probability: float


@dataclass
class TokenGraph:
    model_name: str
    paths: List[CandidatePath]
    best_text: str


@dataclass
class MergeChange:
    kind: str
    primary_segment: str
    secondary_segment: str
    primary_score: float
    secondary_score: float
    selected: str


@dataclass
class MergeResult:
    final_text: str
    changes: List[MergeChange]
    primary_text: str
    secondary_text: str


def _clamp_probability(value: float) -> float:
    return max(0.0, min(1.0, value))


def _token_probability_average(token_weights: Sequence[TokenWeight]) -> float:
    if not token_weights:
        return 0.0
    return mean(_clamp_probability(t.probability) for t in token_weights)


def _decode_tokens(tokens: Sequence[str]) -> str:
    has_word_boundary_markers = any(t.startswith("▁") or t.startswith("Ġ") for t in tokens)
    if has_word_boundary_markers:
        text = ""
        for token in tokens:
            if token.startswith("▁") or token.startswith("Ġ"):
                piece = token[1:]
                if text:
                    text += " "
                text += piece
            else:
                text += token
        return text.strip()

    text = ""
    for idx, token in enumerate(tokens):
        if idx == 0:
            text += token
        elif token in {".", ",", "!", "?", ":", ";"}:
            text += token
        else:
            text += " " + token
    return text.strip()


def _paths_to_graph(model_name: str, paths: Sequence[CandidatePath]) -> TokenGraph:
    if not paths:
        raise ValueError("At least one path is required.")
    sorted_paths = sorted(paths, key=lambda p: p.path_probability, reverse=True)
    best = sorted_paths[0]
    best_text = _decode_tokens([t.token for t in best.token_weights])
    return TokenGraph(model_name=model_name, paths=sorted_paths, best_text=best_text)


def _segment_confidences(graph: TokenGraph, token_joiner: str = " ") -> Tuple[List[str], List[float]]:
    top = graph.paths[0]
    decoded = _decode_tokens([t.token for t in top.token_weights])
    words = decoded.split()
    if not words:
        return [], []

    token_scores = [_clamp_probability(t.probability) for t in top.token_weights]
    if len(token_scores) == len(words):
        return words, token_scores

    if not token_scores:
        return words, [0.0] * len(words)

    # Handle differing tokenization by distributing token confidence across words
    total_chars = sum(len(w) for w in words)
    if total_chars == 0:
        return words, [mean(token_scores)] * len(words)
    avg = mean(token_scores)
    word_scores = []
    for w in words:
        ratio = len(w) / total_chars
        word_scores.append(max(0.0, min(1.0, avg * (WORD_SCORE_BASE + ratio))))
    return words, word_scores


def merge_graphs(
    primary_graph: TokenGraph,
    secondary_graph: TokenGraph,
    primary_weight: float = 0.7,
    secondary_weight: float = 0.3,
) -> MergeResult:
    p_words, p_scores = _segment_confidences(primary_graph)
    s_words, s_scores = _segment_confidences(secondary_graph)

    matcher = SequenceMatcher(a=p_words, b=s_words)
    merged_words: List[str] = []
    changes: List[MergeChange] = []

    for opcode, i1, i2, j1, j2 in matcher.get_opcodes():
        p_segment_words = p_words[i1:i2]
        s_segment_words = s_words[j1:j2]
        p_segment = " ".join(p_segment_words)
        s_segment = " ".join(s_segment_words)

        p_score = mean(p_scores[i1:i2]) if i2 > i1 else 0.0
        s_score = mean(s_scores[j1:j2]) if j2 > j1 else 0.0
        wp = p_score * primary_weight
        ws = s_score * secondary_weight

        if opcode == "equal":
            merged_words.extend(p_segment_words)
            continue

        choose_secondary = ws > wp and bool(s_segment_words)
        if choose_secondary:
            merged_words.extend(s_segment_words)
            selected = "secondary"
        else:
            merged_words.extend(p_segment_words)
            selected = "primary"

        changes.append(
            MergeChange(
                kind=opcode,
                primary_segment=p_segment,
                secondary_segment=s_segment,
                primary_score=round(wp, 4),
                secondary_score=round(ws, 4),
                selected=selected,
            )
        )

    return MergeResult(
        final_text=" ".join(merged_words).strip(),
        changes=changes,
        primary_text=" ".join(p_words).strip(),
        secondary_text=" ".join(s_words).strip(),
    )


class BaseModelAdapter:
    def __init__(self, name: str):
        self.name = name

    def build_token_graph(
        self,
        text: str,
        context_before: str,
        top_k_paths: int,
        min_path_probability: float,
    ) -> TokenGraph:
        raise NotImplementedError


class TinyPrimaryAdapter(BaseModelAdapter):
    def __init__(self) -> None:
        super().__init__("primary_tiny")

    def build_token_graph(
        self,
        text: str,
        context_before: str,
        top_k_paths: int = 2,
        min_path_probability: float = 0.05,
    ) -> TokenGraph:
        options = _context_options(text, context_before)
        paths: List[CandidatePath] = []
        for candidate_text, path_prob in options["primary"][:top_k_paths]:
            if path_prob < min_path_probability:
                continue
            words = candidate_text.split()
            token_weights = [TokenWeight(token=w, probability=path_prob) for w in words]
            paths.append(CandidatePath(token_weights=token_weights, path_probability=path_prob))
        return _paths_to_graph(self.name, paths)


class TinySecondaryAdapter(BaseModelAdapter):
    def __init__(self) -> None:
        super().__init__("secondary_tiny")

    def build_token_graph(
        self,
        text: str,
        context_before: str,
        top_k_paths: int = 3,
        min_path_probability: float = 0.12,
    ) -> TokenGraph:
        options = _context_options(text, context_before)
        paths: List[CandidatePath] = []
        for candidate_text, path_prob in options["secondary"][:top_k_paths]:
            if path_prob < min_path_probability:
                continue
            words = candidate_text.split()
            subword_tokens: List[TokenWeight] = []
            for word in words:
                if len(word) > 6:
                    split = max(3, len(word) // 2)
                    first = "▁" + word[:split]
                    second = word[split:]
                    subword_tokens.append(TokenWeight(token=first, probability=path_prob))
                    if second:
                        subword_tokens.append(
                            TokenWeight(token=second, probability=path_prob * SUBWORD_CONTINUATION_DISCOUNT)
                        )
                else:
                    subword_tokens.append(TokenWeight(token="▁" + word, probability=path_prob))
            paths.append(CandidatePath(token_weights=subword_tokens, path_probability=path_prob))
        return _paths_to_graph(self.name, paths)


def _context_options(text: str, context_before: str) -> Dict[str, List[Tuple[str, float]]]:
    joined = (context_before + " " + text).lower()
    if "river" in joined or "water" in joined:
        return {
            "primary": [("We sat near the bank", 0.64), ("We sat near the shore", 0.35)],
            "secondary": [("We sat near the shore", 0.71), ("We sat near the bank", 0.27)],
        }
    if "money" in joined or "loan" in joined:
        return {
            "primary": [("She visited the bank", 0.73), ("She visited the shore", 0.21)],
            "secondary": [("She visited the bank", 0.78), ("She visited the financial institution", 0.2)],
        }
    if "fish" in joined or "lake" in joined:
        return {
            "primary": [("The bass was huge", 0.66), ("The instrument was huge", 0.31)],
            "secondary": [("The fish was huge", 0.74), ("The bass was huge", 0.22)],
        }
    return {
        "primary": [(text, 0.61), (text, 0.3)],
        "secondary": [(text, 0.58), (text, 0.24)],
    }


def save_graph(graph: TokenGraph, output_path: Path) -> None:
    payload = {
        "model_name": graph.model_name,
        "best_text": graph.best_text,
        "paths": [
            {
                "path_probability": path.path_probability,
                "token_weights": [asdict(tw) for tw in path.token_weights],
            }
            for path in graph.paths
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))


def save_merge_result(merge_result: MergeResult, output_path: Path) -> None:
    payload = {
        "final_text": merge_result.final_text,
        "primary_text": merge_result.primary_text,
        "secondary_text": merge_result.secondary_text,
        "changes": [asdict(change) for change in merge_result.changes],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))


def format_change_report(result: MergeResult) -> str:
    if not result.changes:
        return "No primary/secondary differences affected the final output."
    lines = ["Secondary impact report:"]
    for idx, change in enumerate(result.changes, start=1):
        lines.append(
            f"{idx}. {change.kind}: '{change.primary_segment}' -> '{change.secondary_segment}' "
            f"(primary={change.primary_score}, secondary={change.secondary_score}, selected={change.selected})"
        )
    return "\n".join(lines)


def run_experiment_rows(
    rows: Iterable[Dict[str, str]],
    output_dir: Path,
    primary_weight: float = 0.45,
    secondary_weight: float = 0.55,
) -> List[Dict[str, str]]:
    primary = TinyPrimaryAdapter()
    secondary = TinySecondaryAdapter()
    summaries = []
    for idx, row in enumerate(rows):
        source = row["text"]
        context = row.get("context_before", "")
        primary_graph = primary.build_token_graph(source, context, top_k_paths=2, min_path_probability=0.05)
        secondary_graph = secondary.build_token_graph(source, context, top_k_paths=3, min_path_probability=0.12)
        merged = merge_graphs(
            primary_graph=primary_graph,
            secondary_graph=secondary_graph,
            primary_weight=primary_weight,
            secondary_weight=secondary_weight,
        )

        save_graph(primary_graph, output_dir / f"{idx:02d}_primary_graph.json")
        save_graph(secondary_graph, output_dir / f"{idx:02d}_secondary_graph.json")
        save_merge_result(merged, output_dir / f"{idx:02d}_merged.json")
        summaries.append(
            {
                "source": source,
                "context_before": context,
                "primary_best": primary_graph.best_text,
                "secondary_best": secondary_graph.best_text,
                "final": merged.final_text,
                "impact_report": format_change_report(merged),
            }
        )
    return summaries
