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


class TestMergeGraphs(unittest.TestCase):
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

    def test_merge_equal_sequences_produces_no_changes(self):
        primary = _graph("primary", ["Hello", "world"], 0.9)
        secondary = _graph("secondary", ["Hello", "world"], 0.9)
        merged = merge_graphs(primary, secondary, primary_weight=0.5, secondary_weight=0.5)
        self.assertEqual(merged.final_text, "Hello world")
        self.assertEqual(merged.changes, [])

    def test_merge_empty_secondary_keeps_primary(self):
        primary = _graph("primary", ["Only", "primary"], 0.9)
        secondary = _graph("secondary", [], 0.1)
        # An empty token list gives an empty best_text; merge should not crash.
        merged = merge_graphs(primary, secondary, primary_weight=0.7, secondary_weight=0.3)
        self.assertIn("Only", merged.final_text)

    def test_change_report_lists_secondary_selections(self):
        from translation_fusion import format_change_report

        primary = _graph("primary", ["locust", "plague"], 0.5)
        secondary = _graph("secondary", ["▁locust", "▁swarm"], 0.95)
        merged = merge_graphs(primary, secondary, primary_weight=0.2, secondary_weight=0.8)
        report = format_change_report(merged)
        self.assertIn("secondary", report)


class TestStubAdapters(unittest.TestCase):
    """Verify that the stub adapters honour the updated interface."""

    def test_tiny_primary_adapter_builds_graph(self):
        from model_adapters import TinyPrimaryAdapter

        adapter = TinyPrimaryAdapter()
        graph = adapter.build_token_graph(
            text="Si te niegas",
            context_before="plaga de Egipto",
            source_lang="spa_Latn",
            target_lang="eng_Latn",
        )
        self.assertIsInstance(graph.best_text, str)
        self.assertTrue(graph.paths)

    def test_tiny_secondary_adapter_builds_graph(self):
        from model_adapters import TinySecondaryAdapter

        adapter = TinySecondaryAdapter()
        graph = adapter.build_token_graph(
            text="El chef preparó una langosta",
            context_before="restaurante de mariscos",
            source_lang="spa_Latn",
            target_lang="eng_Latn",
        )
        self.assertIsInstance(graph.best_text, str)
        self.assertTrue(graph.paths)

    def test_stub_langosta_locust_vs_lobster(self):
        """In a plague context, the stub returns 'locusts'; in a seafood context, 'lobster'."""
        from model_adapters import TinySecondaryAdapter

        adapter = TinySecondaryAdapter()

        locust_graph = adapter.build_token_graph(
            text="una plaga de langostas",
            context_before="plaga sobre Egipto",
            source_lang="spa_Latn",
            target_lang="eng_Latn",
        )
        lobster_graph = adapter.build_token_graph(
            text="una exquisita langosta",
            context_before="restaurante de mariscos en la costa",
            source_lang="spa_Latn",
            target_lang="eng_Latn",
        )
        self.assertIn("locust", locust_graph.best_text.lower())
        self.assertIn("lobster", lobster_graph.best_text.lower())

    def test_stub_avocat_lawyer_vs_avocado(self):
        """In a courtroom context, avocat → lawyer; in a food context, avocat → avocado."""
        from model_adapters import TinySecondaryAdapter

        adapter = TinySecondaryAdapter()

        lawyer_graph = adapter.build_token_graph(
            text="Mon avocat m'a conseillé",
            context_before="le procès avait commencé",
            source_lang="fra_Latn",
            target_lang="eng_Latn",
        )
        avocado_graph = adapter.build_token_graph(
            text="J'ai mangé un avocat mûr",
            context_before="je prépare toujours un repas sain salade",
            source_lang="fra_Latn",
            target_lang="eng_Latn",
        )
        self.assertIn("lawyer", lawyer_graph.best_text.lower())
        self.assertIn("avocado", avocado_graph.best_text.lower())


class TestRunExperimentRows(unittest.TestCase):
    def test_run_produces_summaries_for_each_row(self):
        import tempfile
        from pathlib import Path
        from translation_fusion import run_experiment_rows
        from model_adapters import TinyPrimaryAdapter, TinySecondaryAdapter

        rows = [
            {
                "text": "una plaga de langostas",
                "context_before": "plagas sobre Egipto",
                "source_lang": "spa_Latn",
                "target_lang": "eng_Latn",
            },
            {
                "text": "Mon avocat m'a conseillé",
                "context_before": "le procès avait commencé",
                "source_lang": "fra_Latn",
                "target_lang": "eng_Latn",
            },
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            summaries = run_experiment_rows(
                rows=rows,
                output_dir=Path(tmpdir),
                primary_adapter=TinyPrimaryAdapter(),
                secondary_adapter=TinySecondaryAdapter(),
            )
        self.assertEqual(len(summaries), 2)
        for s in summaries:
            self.assertIn("final", s)
            self.assertIn("impact_report", s)
            self.assertIn("source_lang", s)


if __name__ == "__main__":
    unittest.main()
