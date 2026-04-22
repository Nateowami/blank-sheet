"""Unit tests for language_similarity.py.

These tests use only synthetic data and require no external packages.
"""

import unittest

from language_similarity import _cosine_similarity, _ngram_freq, same_language, similarity_score

# Number of times to repeat a short phrase to build a large enough sample for
# n-gram distributions to stabilise during similarity tests.
_LARGE_REPEAT = 20
_MEDIUM_REPEAT = 10


class TestNgramFreq(unittest.TestCase):
    def test_empty_string_returns_empty_dict(self):
        self.assertEqual(_ngram_freq("", 1), {})
        self.assertEqual(_ngram_freq("", 2), {})

    def test_string_shorter_than_n_returns_empty(self):
        self.assertEqual(_ngram_freq("a", 2), {})

    def test_unigram_probabilities_sum_to_one(self):
        freq = _ngram_freq("aabbcc", 1)
        self.assertAlmostEqual(sum(freq.values()), 1.0)

    def test_bigram_probabilities_sum_to_one(self):
        freq = _ngram_freq("abcabc", 2)
        self.assertAlmostEqual(sum(freq.values()), 1.0)

    def test_known_unigram_frequencies(self):
        freq = _ngram_freq("aabc", 1)
        self.assertAlmostEqual(freq["a"], 2 / 4)
        self.assertAlmostEqual(freq["b"], 1 / 4)
        self.assertAlmostEqual(freq["c"], 1 / 4)

    def test_trigram_extracted_correctly(self):
        freq = _ngram_freq("abcde", 3)
        self.assertIn("abc", freq)
        self.assertIn("bcd", freq)
        self.assertIn("cde", freq)
        self.assertEqual(len(freq), 3)


class TestCosineSimilarity(unittest.TestCase):
    def test_identical_distributions(self):
        d = {"a": 0.5, "b": 0.5}
        self.assertAlmostEqual(_cosine_similarity(d, d), 1.0)

    def test_completely_disjoint_distributions(self):
        d1 = {"a": 1.0}
        d2 = {"b": 1.0}
        self.assertAlmostEqual(_cosine_similarity(d1, d2), 0.0)

    def test_empty_distribution_returns_zero(self):
        self.assertEqual(_cosine_similarity({}, {"a": 1.0}), 0.0)
        self.assertEqual(_cosine_similarity({"a": 1.0}, {}), 0.0)

    def test_symmetry(self):
        d1 = {"a": 0.6, "b": 0.4}
        d2 = {"a": 0.3, "b": 0.5, "c": 0.2}
        self.assertAlmostEqual(
            _cosine_similarity(d1, d2),
            _cosine_similarity(d2, d1),
        )

    def test_value_in_range(self):
        d1 = {"a": 0.7, "b": 0.3}
        d2 = {"a": 0.4, "c": 0.6}
        sim = _cosine_similarity(d1, d2)
        self.assertGreaterEqual(sim, 0.0)
        self.assertLessEqual(sim, 1.0)


class TestSimilarityScore(unittest.TestCase):
    def test_identical_text_scores_one(self):
        text = "the quick brown fox jumps over the lazy dog"
        self.assertAlmostEqual(similarity_score(text, text), 1.0, places=5)

    def test_score_in_unit_interval(self):
        a = "hello world this is english text"
        b = "مرحبا بالعالم هذا نص عربي"  # Arabic
        score = similarity_score(a, b)
        self.assertGreaterEqual(score, 0.0)
        self.assertLessEqual(score, 1.0)

    def test_symmetry(self):
        a = "the cat sat on the mat"
        b = "le chat était assis sur le tapis"
        self.assertAlmostEqual(similarity_score(a, b), similarity_score(b, a), places=10)

    def test_latin_vs_arabic_low_similarity(self):
        """Latin-script text vs Arabic-script text should score near 0."""
        english = (
            "the quick brown fox jumps over the lazy dog " * _LARGE_REPEAT
        )
        arabic = (
            "الثعلب البني السريع يقفز فوق الكلب الكسول " * _LARGE_REPEAT
        )
        score = similarity_score(english, arabic)
        self.assertLess(score, 0.2)

    def test_same_language_higher_than_different(self):
        """Two English texts should be more similar to each other than to Arabic."""
        en1 = "the cat sat on the mat and looked at the hat " * _MEDIUM_REPEAT
        en2 = "the dog ran through the park near the dark " * _MEDIUM_REPEAT
        ar = "القط جلس على الحصيرة ونظر إلى القبعة " * _MEDIUM_REPEAT

        sim_same = similarity_score(en1, en2)
        sim_diff = similarity_score(en1, ar)
        self.assertGreater(sim_same, sim_diff)

    def test_case_insensitive(self):
        lower = "the quick brown fox"
        upper = "THE QUICK BROWN FOX"
        self.assertAlmostEqual(similarity_score(lower, upper), 1.0, places=5)

    def test_custom_weights(self):
        a = "hello world"
        b = "hello world"
        # With any positive weights the score should still be 1.0 for identical text.
        self.assertAlmostEqual(similarity_score(a, b, weights=(2, 2, 2)), 1.0, places=5)

    def test_empty_corpora(self):
        # Both empty → 0-length, all n-gram freqs are empty → 0.0
        self.assertEqual(similarity_score("", ""), 0.0)


class TestSameLanguage(unittest.TestCase):
    def test_identical_text_is_same_language(self):
        text = "the quick brown fox jumps over the lazy dog"
        self.assertTrue(same_language(text, text))

    def test_latin_vs_arabic_different_language(self):
        english = "the quick brown fox jumps over the lazy dog " * 20
        arabic = "الثعلب البني السريع يقفز فوق الكلب الكسول " * 20
        self.assertFalse(same_language(english, arabic))

    def test_threshold_zero_always_same(self):
        en = "hello world"
        ar = "مرحبا بالعالم"
        # threshold=0 means everything is "same language"
        self.assertTrue(same_language(en, ar, threshold=0.0))

    def test_threshold_one_always_different_unless_identical(self):
        a = "hello world"
        b = "hello world different"
        # threshold=1 means only exact same distributions qualify
        self.assertFalse(same_language(a, b, threshold=1.0))

    def test_two_english_samples_are_same(self):
        # Use varied phrases so the corpus represents a typical English character
        # distribution rather than just a single repeated phrase.
        en1 = " ".join([
            "the cat sat on the mat and looked at the hat in the garden " * 8,
            "the quick brown fox jumps over the lazy dog near the old barn " * 8,
            "she walked through the forest and found a small clear river " * 8,
            "the children played in the park while their parents watched " * 8,
        ])
        en2 = " ".join([
            "a horse of a different color ran through the open field today " * 8,
            "for the love of the game they practiced every single day without fail " * 8,
            "under the stars they danced until the night was almost over " * 8,
            "the old man told stories of distant lands and faraway places " * 8,
        ])
        self.assertTrue(same_language(en1, en2))

    def test_cyrillic_vs_latin_different(self):
        latin = "the quick brown fox jumps over the lazy dog " * 20
        cyrillic = "быстрая коричневая лиса прыгает через ленивую собаку " * 20
        self.assertFalse(same_language(latin, cyrillic))


if __name__ == "__main__":
    unittest.main()
