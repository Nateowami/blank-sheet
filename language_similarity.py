"""
language_similarity.py — detect whether two text corpora are in the same language.

Approach
--------
For each corpus, compute the normalized frequency distribution of:
  * individual characters (1-grams)
  * character pairs (2-grams)
  * character triples (3-grams)

Then measure the cosine similarity between the corresponding distributions.
A weighted average of the three similarities gives the final score.
Higher-order n-grams capture language-specific phonological and morphological
patterns, so they are given more weight.

A score at or above `threshold` (default 0.5) indicates the corpora are likely
in the same language.

Usage
-----
    from language_similarity import similarity_score, same_language

    score = similarity_score(corpus_a, corpus_b)   # float in [0, 1]
    print(same_language(corpus_a, corpus_b))        # True / False
"""

import math
from collections import Counter


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _ngram_freq(text: str, n: int) -> dict:
    """Return the normalized character n-gram frequency distribution."""
    counts: Counter = Counter(text[i : i + n] for i in range(len(text) - n + 1))
    total = sum(counts.values())
    if total == 0:
        return {}
    return {k: v / total for k, v in counts.items()}


def _cosine_similarity(dist1: dict, dist2: dict) -> float:
    """Cosine similarity between two frequency distributions."""
    if not dist1 or not dist2:
        return 0.0
    dot = sum(dist1.get(k, 0.0) * v for k, v in dist2.items())
    norm1 = math.sqrt(sum(v * v for v in dist1.values()))
    norm2 = math.sqrt(sum(v * v for v in dist2.values()))
    if norm1 == 0.0 or norm2 == 0.0:
        return 0.0
    return dot / (norm1 * norm2)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

#: Default weights applied to (1-gram, 2-gram, 3-gram) similarities.
#: Trigrams encode the most language-specific information, so they get the
#: highest weight.
DEFAULT_WEIGHTS = (1, 3, 5)


def similarity_score(
    corpus1: str,
    corpus2: str,
    weights: tuple = DEFAULT_WEIGHTS,
) -> float:
    """Compute a language similarity score between two text corpora.

    Parameters
    ----------
    corpus1, corpus2:
        Raw text strings (any length; longer is more reliable).
    weights:
        A 3-tuple ``(w1, w2, w3)`` weighting the 1-, 2-, and 3-gram
        similarities respectively.

    Returns
    -------
    float
        A value in ``[0, 1]``.  Values near 1 mean the corpora are likely the
        same language; values near 0 mean they are likely different languages.
    """
    # Lowercase to reduce sparsity without discarding script information.
    t1 = corpus1.lower()
    t2 = corpus2.lower()

    w1, w2, w3 = weights
    total_weight = w1 + w2 + w3

    weighted_sum = 0.0
    for n, w in zip((1, 2, 3), (w1, w2, w3)):
        d1 = _ngram_freq(t1, n)
        d2 = _ngram_freq(t2, n)
        weighted_sum += w * _cosine_similarity(d1, d2)

    return weighted_sum / total_weight


def same_language(
    corpus1: str,
    corpus2: str,
    threshold: float = 0.5,
    weights: tuple = DEFAULT_WEIGHTS,
) -> bool:
    """Return ``True`` if the two corpora are likely in the same language.

    Parameters
    ----------
    corpus1, corpus2:
        Raw text strings.
    threshold:
        Minimum similarity score to classify as the same language.
        The default (0.5) works well across a wide range of languages and
        corpus sizes.  For very short corpora you may want a lower threshold;
        for near-identical scripts (e.g. Spanish vs. Italian) a higher
        threshold may be needed.
    weights:
        Passed through to :func:`similarity_score`.
    """
    return similarity_score(corpus1, corpus2, weights=weights) >= threshold
