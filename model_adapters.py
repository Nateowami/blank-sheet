"""
Model adapters for the primary (NLLB) and secondary (TranslateGemma) translation models.

Primary model  – facebook/nllb-200-distilled-600M (default; swap to the full
                 facebook/nllb-200-3.3B when accuracy matters)
Secondary model – google/gemma-3-1b-it (default; swap to a dedicated
                 TranslateGemma checkpoint, e.g. google/translate-gemma-9b,
                 when one is available from HuggingFace)

For offline / unit-test use, pass ``--use-stubs`` to run_experiment.py; this
selects TinyPrimaryAdapter / TinySecondaryAdapter which never load any weights.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional, Tuple

from translation_fusion import (
    BaseModelAdapter,
    CandidatePath,
    TokenGraph,
    TokenWeight,
    _paths_to_graph,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Language code helpers
# ---------------------------------------------------------------------------

#: Mapping from NLLB language codes to human-readable names used in prompts.
NLLB_CODE_TO_NAME: Dict[str, str] = {
    "eng_Latn": "English",
    "spa_Latn": "Spanish",
    "fra_Latn": "French",
    "deu_Latn": "German",
    "ita_Latn": "Italian",
    "por_Latn": "Portuguese",
    "rus_Cyrl": "Russian",
    "zho_Hans": "Chinese (Simplified)",
    "zho_Hant": "Chinese (Traditional)",
    "jpn_Jpan": "Japanese",
    "kor_Hang": "Korean",
    "ara_Arab": "Arabic",
    "hin_Deva": "Hindi",
}


def lang_name(nllb_code: str) -> str:
    """Return the human-readable language name for an NLLB language code."""
    return NLLB_CODE_TO_NAME.get(nllb_code, nllb_code)


# ---------------------------------------------------------------------------
# NLLB adapter (primary, encoder-decoder)
# ---------------------------------------------------------------------------

class NLLBAdapter(BaseModelAdapter):
    """Primary adapter wrapping facebook/nllb-200-* seq2seq models.

    Token graphs are built from beam search with per-token probabilities
    computed via ``model.compute_transition_scores``.
    """

    DEFAULT_MODEL = "facebook/nllb-200-distilled-600M"

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        device: Optional[str] = None,
    ) -> None:
        super().__init__(model_name)
        self._model_name = model_name
        self._device = device  # resolved lazily
        self._model = None
        self._tokenizer = None

    # ------------------------------------------------------------------
    # Lazy loading
    # ------------------------------------------------------------------

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return

        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        if self._device is None:
            self._device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info("Loading NLLB model %s on %s …", self._model_name, self._device)
        # AutoTokenizer returns NllbTokenizerFast in transformers 5.x, which is
        # better maintained than the legacy slow NllbTokenizer.
        self._tokenizer = AutoTokenizer.from_pretrained(self._model_name)
        # Load model directly onto the target device to avoid a CPU→GPU copy
        # that would double peak memory usage.
        self._model = AutoModelForSeq2SeqLM.from_pretrained(
            self._model_name,
            device_map=self._device,
        )
        self._model.eval()
        logger.info("NLLB model loaded.")

    # ------------------------------------------------------------------
    # TokenGraph construction
    # ------------------------------------------------------------------

    def build_token_graph(
        self,
        text: str,
        context_before: str,
        source_lang: str = "spa_Latn",
        target_lang: str = "eng_Latn",
        top_k_paths: int = 4,
        min_path_probability: float = 0.02,
    ) -> TokenGraph:
        import torch

        self._ensure_loaded()

        # NLLB does not use context_before; it translates one sentence at a time.
        self._tokenizer.src_lang = source_lang
        inputs = self._tokenizer(text, return_tensors="pt").to(self._device)
        # NllbTokenizerFast (returned by AutoTokenizer) does not expose
        # lang_code_to_id; use convert_tokens_to_ids which works for both the
        # fast and slow variants.
        forced_bos_token_id = self._tokenizer.convert_tokens_to_ids(target_lang)

        with torch.no_grad():
            outputs = self._model.generate(
                **inputs,
                forced_bos_token_id=forced_bos_token_id,
                num_beams=max(top_k_paths, 4),
                num_return_sequences=top_k_paths,
                output_scores=True,
                return_dict_in_generate=True,
                max_new_tokens=256,
                early_stopping=True,
            )

        # Per-token log-probs → probabilities
        beam_indices = getattr(outputs, "beam_indices", None)
        transition_scores = self._model.compute_transition_scores(
            outputs.sequences, outputs.scores, beam_indices, normalize_logits=True
        )
        token_probs = torch.exp(transition_scores)  # (num_seqs, gen_len)

        # Normalise overall sequence scores to [0, 1] across beams.
        # sequences_scores is present for beam search with return_dict_in_generate=True.
        raw_seq_scores = getattr(outputs, "sequences_scores", None)
        if raw_seq_scores is not None:
            seq_scores = raw_seq_scores.float()
            path_probs_tensor = torch.softmax(seq_scores, dim=0)
        else:
            # Fallback: uniform distribution across returned sequences
            n = outputs.sequences.shape[0]
            path_probs_tensor = torch.full((n,), 1.0 / n)

        paths: List[CandidatePath] = []
        # Build the set of special token IDs that terminate generation so the
        # token loop works correctly even when eos_token_id is a list.
        eos_id = self._tokenizer.eos_token_id
        eos_id_set: set = set(eos_id) if isinstance(eos_id, (list, tuple)) else {eos_id}
        pad_id = self._tokenizer.pad_token_id
        if pad_id is not None:
            eos_id_set.add(pad_id)

        for seq_idx in range(outputs.sequences.shape[0]):
            path_prob = float(path_probs_tensor[seq_idx])
            if path_prob < min_path_probability:
                continue

            # The decoder sequence for seq2seq models is:
            #   [decoder_start_token, forced_bos (lang code), t1, t2, …, EOS]
            # transition_scores[i] has length = len(sequences[i]) - 1
            # because it doesn't score the decoder_start position.
            # So transition_scores[i, 0] = score for forced_bos (index 1 in seq)
            #    transition_scores[i, 1] = score for t1 (index 2 in seq), etc.
            gen_token_ids = outputs.sequences[seq_idx][2:].tolist()  # skip start + lang
            per_tok_probs = token_probs[seq_idx][1:].tolist()  # skip lang-code score

            token_weights: List[TokenWeight] = []
            for tok_id, prob in zip(gen_token_ids, per_tok_probs):
                if tok_id in eos_id_set:
                    break
                tok_str = self._tokenizer.convert_ids_to_tokens(tok_id)
                if tok_str is None:
                    continue
                token_weights.append(TokenWeight(token=tok_str, probability=float(prob)))

            if token_weights:
                paths.append(
                    CandidatePath(
                        token_weights=token_weights,
                        path_probability=path_prob,
                    )
                )

        if not paths:
            # Fallback: decode best beam with uniform per-token confidence
            best_text = self._tokenizer.decode(
                outputs.sequences[0], skip_special_tokens=True
            )
            words = best_text.split()
            fallback_prob = float(path_probs_tensor[0])
            token_weights = [TokenWeight(token=w, probability=fallback_prob) for w in words]
            paths.append(
                CandidatePath(token_weights=token_weights, path_probability=fallback_prob)
            )

        return _paths_to_graph(self.name, paths)


# ---------------------------------------------------------------------------
# TranslateGemma adapter (secondary, decoder-only)
# ---------------------------------------------------------------------------

_SECONDARY_PROMPT_TEMPLATE = """\
Translate the following text from {source_lang_name} to {target_lang_name}.

Previous context (already translated, for reference only): "{context_before}"

Text to translate: "{text}"

Translation:"""

_SECONDARY_PROMPT_NO_CONTEXT = """\
Translate the following text from {source_lang_name} to {target_lang_name}.

Text to translate: "{text}"

Translation:"""


class TranslateGemmaAdapter(BaseModelAdapter):
    """Secondary adapter wrapping instruction-tuned decoder-only models.

    The adapter feeds ``context_before`` to the model via a structured prompt
    so that the model can resolve context-dependent word senses (e.g. "langosta"
    as locust vs. lobster depending on the surrounding passage).

    By default this targets ``google/gemma-3-1b-it`` (the smallest Gemma that
    follows instructions).  Swap ``model_name`` to the full TranslateGemma
    checkpoint when available.
    """

    DEFAULT_MODEL = "google/gemma-3-1b-it"

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        device: Optional[str] = None,
    ) -> None:
        super().__init__(model_name)
        self._model_name = model_name
        self._device = device
        self._model = None
        self._tokenizer = None

    # ------------------------------------------------------------------
    # Lazy loading
    # ------------------------------------------------------------------

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return

        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        if self._device is None:
            self._device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(
            "Loading TranslateGemma model %s on %s …", self._model_name, self._device
        )
        self._tokenizer = AutoTokenizer.from_pretrained(self._model_name)
        # Load model directly onto the target device to avoid a CPU→GPU copy
        # that would double peak memory usage when NLLB is already on GPU.
        self._model = AutoModelForCausalLM.from_pretrained(
            self._model_name,
            torch_dtype="auto",
            device_map=self._device,
        )
        self._model.eval()
        logger.info("TranslateGemma model loaded.")

    # ------------------------------------------------------------------
    # Prompt building
    # ------------------------------------------------------------------

    @staticmethod
    def _build_prompt(
        text: str,
        context_before: str,
        source_lang: str,
        target_lang: str,
    ) -> str:
        src_name = lang_name(source_lang)
        tgt_name = lang_name(target_lang)
        if context_before.strip():
            return _SECONDARY_PROMPT_TEMPLATE.format(
                source_lang_name=src_name,
                target_lang_name=tgt_name,
                context_before=context_before.strip(),
                text=text.strip(),
            )
        return _SECONDARY_PROMPT_NO_CONTEXT.format(
            source_lang_name=src_name,
            target_lang_name=tgt_name,
            text=text.strip(),
        )

    # ------------------------------------------------------------------
    # TokenGraph construction
    # ------------------------------------------------------------------

    def build_token_graph(
        self,
        text: str,
        context_before: str,
        source_lang: str = "spa_Latn",
        target_lang: str = "eng_Latn",
        top_k_paths: int = 4,
        min_path_probability: float = 0.02,
    ) -> TokenGraph:
        import torch

        self._ensure_loaded()

        prompt = self._build_prompt(text, context_before, source_lang, target_lang)
        inputs = self._tokenizer(prompt, return_tensors="pt").to(self._device)
        prompt_len = inputs.input_ids.shape[1]

        # Build a flat list of EOS token IDs.
        # self._tokenizer.eos_token_id may be an int *or* a list for
        # instruction-tuned models (e.g. Gemma-IT sets it to [1, 107]).
        base_eos = self._tokenizer.eos_token_id
        eos_ids: List[int] = list(base_eos) if isinstance(base_eos, (list, tuple)) else [base_eos]
        # Also stop at the first newline to avoid multi-sentence outputs.
        nl_token_ids = self._tokenizer.encode("\n", add_special_tokens=False)
        if nl_token_ids:
            eos_ids = list(dict.fromkeys(eos_ids + nl_token_ids[:1]))  # dedup, preserve order

        with torch.no_grad():
            outputs = self._model.generate(
                **inputs,
                num_beams=max(top_k_paths, 4),
                num_return_sequences=top_k_paths,
                output_scores=True,
                return_dict_in_generate=True,
                max_new_tokens=128,
                early_stopping=True,
                eos_token_id=eos_ids,
            )

        beam_indices = getattr(outputs, "beam_indices", None)
        transition_scores = self._model.compute_transition_scores(
            outputs.sequences, outputs.scores, beam_indices, normalize_logits=True
        )
        token_probs = torch.exp(transition_scores)  # (num_seqs, new_len)

        # sequences_scores is present for beam search with return_dict_in_generate=True.
        raw_seq_scores = getattr(outputs, "sequences_scores", None)
        if raw_seq_scores is not None:
            seq_scores = raw_seq_scores.float()
            path_probs_tensor = torch.softmax(seq_scores, dim=0)
        else:
            n = outputs.sequences.shape[0]
            path_probs_tensor = torch.full((n,), 1.0 / n)

        # Collect the set of token IDs that signal end-of-sequence so we can
        # stop the token loop correctly even when eos_token_id is a list.
        eos_id_set = set(eos_ids)
        pad_id = self._tokenizer.pad_token_id
        if pad_id is not None:
            eos_id_set.add(pad_id)

        paths: List[CandidatePath] = []
        for seq_idx in range(outputs.sequences.shape[0]):
            path_prob = float(path_probs_tensor[seq_idx])
            if path_prob < min_path_probability:
                continue

            # For causal LM the sequences tensor is [prompt | new_tokens].
            # transition_scores[i] already corresponds to the new_tokens only.
            gen_token_ids = outputs.sequences[seq_idx][prompt_len:].tolist()
            per_tok_probs = token_probs[seq_idx].tolist()

            token_weights: List[TokenWeight] = []
            for tok_id, prob in zip(gen_token_ids, per_tok_probs):
                if tok_id in eos_id_set:
                    break
                tok_str = self._tokenizer.convert_ids_to_tokens(tok_id)
                if tok_str is None:
                    continue
                token_weights.append(TokenWeight(token=tok_str, probability=float(prob)))

            if token_weights:
                paths.append(
                    CandidatePath(
                        token_weights=token_weights,
                        path_probability=path_prob,
                    )
                )

        if not paths:
            best_gen_ids = outputs.sequences[0][prompt_len:]
            best_text = self._tokenizer.decode(best_gen_ids, skip_special_tokens=True)
            best_text = best_text.split("\n")[0].strip()
            words = best_text.split()
            fallback_prob = float(path_probs_tensor[0])
            token_weights = [TokenWeight(token=w, probability=fallback_prob) for w in words]
            paths.append(
                CandidatePath(token_weights=token_weights, path_probability=fallback_prob)
            )

        return _paths_to_graph(self.name, paths)


# ---------------------------------------------------------------------------
# Stub adapters (no model loading; used for offline testing)
# ---------------------------------------------------------------------------

def _context_options(
    text: str, context_before: str
) -> Dict[str, List[Tuple[str, float]]]:
    """Return canned translations used by the stub adapters.

    Disambiguation is driven by *context_before*, not the ambiguous word in
    *text*, so the same ambiguous word resolves differently depending on the
    surrounding passage.
    """
    ctx = context_before.lower()
    txt = text.lower()

    # --- langosta: locust (plague) vs lobster (seafood) ---
    if any(k in ctx for k in ("plaga", "egipt", "plagues", "moisés", "faraón", "mosé")):
        return {
            "primary": [
                ("If you refuse, beware! For tomorrow I will bring a plague of locusts upon your land.", 0.68),
                ("If you refuse, beware! For tomorrow I will bring a plague of lobsters upon your land.", 0.28),
            ],
            "secondary": [
                ("If you refuse, beware! For tomorrow I will bring a plague of locusts upon your land.", 0.76),
                ("If you refuse, watch out! Tomorrow I will bring a locust plague upon your land.", 0.21),
            ],
        }
    if any(k in ctx for k in ("restauran", "mariscos", "chef", "seafood", "costa")) and \
            any(k in ctx for k in ("mariscos", "seafood", "marisco", "langosta", "langost")):
        return {
            "primary": [
                ("The chef prepared an exquisite lobster with truffle butter.", 0.72),
                ("The chef prepared an exquisite locust with truffle butter.", 0.22),
            ],
            "secondary": [
                ("The chef prepared an exquisite lobster with truffle butter.", 0.81),
                ("The chef prepared a delicious lobster with truffle butter.", 0.17),
            ],
        }

    # --- avocat: lawyer (court) vs avocado (food) ---
    if any(k in ctx for k in ("procès", "tribunal", "jugement", "cour ", "juge", "témoin")):
        return {
            "primary": [
                ("My lawyer advised me not to testify.", 0.70),
                ("My avocado advised me not to testify.", 0.24),
            ],
            "secondary": [
                ("My lawyer advised me not to testify.", 0.79),
                ("My attorney advised me not to testify.", 0.19),
            ],
        }
    if any(k in ctx for k in ("salade", "manger", "repas", "déjeuner", "sain", "jogging", "petit-déjeuner")):
        return {
            "primary": [
                ("I ate a ripe avocado with lemon this morning.", 0.66),
                ("I ate a ripe lawyer with lemon this morning.", 0.28),
            ],
            "secondary": [
                ("I ate a ripe avocado with lemon this morning.", 0.75),
                ("I had a ripe avocado with lemon for breakfast.", 0.22),
            ],
        }

    # --- copa: trophy (sports) vs wine glass (dining) ---
    if any(k in ctx for k in ("campeonat", "partido", "árbitro", "jugadores", "trophy", "champion")):
        return {
            "primary": [
                ("The team lifted the cup after winning the championship.", 0.65),
                ("The team lifted the glass after winning the championship.", 0.28),
            ],
            "secondary": [
                ("The team lifted the trophy after winning the championship.", 0.73),
                ("The team lifted the cup after winning the championship.", 0.24),
            ],
        }
    if any(k in ctx for k in ("sommelier", "vino", "cena", "restaurante", "wine", "dinner")):
        return {
            "primary": [
                ("He ordered a glass of red wine with dinner.", 0.71),
                ("He ordered a cup of red wine with dinner.", 0.23),
            ],
            "secondary": [
                ("He ordered a glass of red wine with dinner.", 0.77),
                ("He requested a glass of red wine with his dinner.", 0.20),
            ],
        }

    # --- Bank (German): bench (park) vs financial bank ---
    if any(k in ctx for k in ("park", "enten", "familie", "stadtpark", "sonnig")):
        return {
            "primary": [
                ("He sat on the bench in the park and watched the ducks.", 0.69),
                ("He sat on the bank in the park and watched the ducks.", 0.25),
            ],
            "secondary": [
                ("He sat on the bench in the park watching the ducks.", 0.78),
                ("He sat on the park bench and observed the ducks.", 0.20),
            ],
        }
    if any(k in ctx for k in ("kredit", "darlehen", "schulden", "bonität", "loan", "credit", "finance")):
        return {
            "primary": [
                ("The bank denied him credit due to poor credit rating.", 0.72),
                ("The bench denied him credit due to poor credit rating.", 0.21),
            ],
            "secondary": [
                ("The bank refused him a loan due to poor credit score.", 0.80),
                ("The financial institution denied his loan application.", 0.18),
            ],
        }

    # --- grève (French): strike (labor) vs beach/shore (coastal) ---
    if any(k in ctx for k in ("syndicat", "salaire", "direction", "négociation", "mineur", "travail")):
        return {
            "primary": [
                ("The miners voted to strike after the failure of negotiations.", 0.67),
                ("The miners voted to go to the beach after the failure of negotiations.", 0.27),
            ],
            "secondary": [
                ("The miners voted for a strike after negotiations broke down.", 0.75),
                ("The miners decided to strike after negotiations failed.", 0.22),
            ],
        }
    if any(k in ctx for k in ("vacances", "mer ", "chalet", "bord de mer", "coucher", "sunset", "sea")):
        return {
            "primary": [
                ("We walked along the beach at sunset.", 0.64),
                ("We walked along the strike at sunset.", 0.30),
            ],
            "secondary": [
                ("We strolled along the shore at sunset.", 0.74),
                ("We walked on the beach at sunset.", 0.23),
            ],
        }

    # --- planta (Spanish): sole of foot vs ground floor ---
    if any(k in ctx for k in ("caminar", "senderos", "kilómetros", "pie", "montaña", "hiking", "walk", "sendero")):
        return {
            "primary": [
                ("The soles of her feet hurt after walking so much.", 0.66),
                ("The plant of her feet hurt after walking so much.", 0.28),
            ],
            "secondary": [
                ("Her feet ached from so much walking.", 0.74),
                ("The soles of her feet were sore from so much walking.", 0.23),
            ],
        }
    if any(k in ctx for k in ("edificio", "piso", "aparcamiento", "corporativo", "oficina", "floor", "building")):
        return {
            "primary": [
                ("The ground floor of the main building is reserved for offices.", 0.68),
                ("The plant of the main building is reserved for offices.", 0.26),
            ],
            "secondary": [
                ("The first floor of the main building is reserved for offices.", 0.76),
                ("The ground floor of the main building is reserved for offices.", 0.21),
            ],
        }

    # Generic fallback
    return {
        "primary": [(txt or text, 0.61), (f"{txt or text} (alternative)", 0.3)],
        "secondary": [(txt or text, 0.58), (f"{txt or text} (variant)", 0.24)],
    }


class TinyPrimaryAdapter(BaseModelAdapter):
    """Stub primary adapter for offline testing. Never loads model weights."""

    def __init__(self) -> None:
        super().__init__("primary_tiny")

    def build_token_graph(
        self,
        text: str,
        context_before: str,
        source_lang: str = "spa_Latn",
        target_lang: str = "eng_Latn",
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
    """Stub secondary adapter for offline testing. Never loads model weights."""

    # How many characters before splitting a word into subword pieces.
    _SUBWORD_SPLIT_THRESHOLD = 6
    _MIN_SUBWORD_SPLIT_POSITION = 3
    _SUBWORD_CONTINUATION_DISCOUNT = 0.98

    def __init__(self) -> None:
        super().__init__("secondary_tiny")

    def build_token_graph(
        self,
        text: str,
        context_before: str,
        source_lang: str = "spa_Latn",
        target_lang: str = "eng_Latn",
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
                if len(word) > self._SUBWORD_SPLIT_THRESHOLD:
                    split = max(self._MIN_SUBWORD_SPLIT_POSITION, len(word) // 2)
                    first = "▁" + word[:split]
                    second = word[split:]
                    subword_tokens.append(TokenWeight(token=first, probability=path_prob))
                    if second:
                        subword_tokens.append(
                            TokenWeight(
                                token=second,
                                probability=path_prob * self._SUBWORD_CONTINUATION_DISCOUNT,
                            )
                        )
                else:
                    subword_tokens.append(
                        TokenWeight(token="▁" + word, probability=path_prob)
                    )
            paths.append(CandidatePath(token_weights=subword_tokens, path_probability=path_prob))
        return _paths_to_graph(self.name, paths)
