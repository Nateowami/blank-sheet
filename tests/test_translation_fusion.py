import unittest
from typing import List

from translation_fusion import CandidatePath, TokenGraph, TokenWeight, merge_graphs


def _graph(model: str, tokens: List[str], path_probability: float = 0.8) -> TokenGraph:
    return TokenGraph(
        model_name=model,
        best_text="",
        paths=[
            CandidatePath(
                token_weights=[TokenWeight(token=t, probability=path_probability) for t in tokens],
                path_probability=path_probability,
            )
        ],
    )


class TestTranslationFusion(unittest.TestCase):
    def test_merge_identical_tokenization_prefers_primary_with_higher_weight(self):
        primary = _graph("primary", ["We", "sat", "near", "the", "bank"], 0.8)
        secondary = _graph("secondary", ["We", "sat", "near", "the", "shore"], 0.8)
        merged = merge_graphs(primary, secondary, primary_weight=0.7, secondary_weight=0.3)
        self.assertEqual(merged.final_text, "We sat near the bank")
        self.assertTrue(merged.changes)
        self.assertEqual(merged.changes[0].selected, "primary")

    def test_merge_differing_tokenization_can_select_secondary(self):
        primary = _graph("primary", ["The", "bass", "was", "huge"], 0.55)
        secondary = _graph("secondary", ["▁The", "▁fish", "▁was", "▁hu", "ge"], 0.9)
        merged = merge_graphs(primary, secondary, primary_weight=0.2, secondary_weight=0.8)
        self.assertEqual(merged.final_text, "The fish was huge")
        self.assertTrue(merged.changes)
        self.assertEqual(merged.changes[0].selected, "secondary")


if __name__ == "__main__":
    unittest.main()
