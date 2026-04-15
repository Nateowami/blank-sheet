import json
import unittest
from pathlib import Path
from typing import List
from unittest.mock import MagicMock, patch

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


class TestOllamaTranslateGemmaAdapter(unittest.TestCase):
    """Tests for OllamaTranslateGemmaAdapter using a mocked Ollama client."""

    def _make_logprob(self, token: str, logprob: float):
        lp = MagicMock()
        lp.token = token
        lp.logprob = logprob
        return lp

    def _make_response(self, content: str, logprobs=None):
        resp = MagicMock()
        resp.message.content = content
        resp.logprobs = logprobs
        return resp

    def _make_adapter(self):
        from model_adapters import OllamaTranslateGemmaAdapter
        adapter = OllamaTranslateGemmaAdapter(model_name="translategemma")
        adapter._client = MagicMock()
        return adapter

    def test_builds_graph_from_logprobs(self):
        adapter = self._make_adapter()
        lps = [
            self._make_logprob("The", -0.1),
            self._make_logprob(" chef", -0.2),
            self._make_logprob(" cooked", -0.3),
            self._make_logprob(" lobster", -0.15),
        ]
        adapter._client.chat.return_value = self._make_response(
            "The chef cooked lobster", lps
        )
        graph = adapter.build_token_graph(
            text="El chef cocinó langosta",
            context_before="restaurante de mariscos",
            source_lang="spa_Latn",
            target_lang="eng_Latn",
            top_k_paths=1,
        )
        self.assertIsInstance(graph, TokenGraph)
        self.assertTrue(graph.paths)
        self.assertIn("lobster", graph.best_text.lower())

    def test_fallback_without_logprobs(self):
        """When Ollama returns no logprobs, the adapter falls back to uniform confidence."""
        adapter = self._make_adapter()
        adapter._client.chat.return_value = self._make_response(
            "The lawyer advised me", logprobs=None
        )
        graph = adapter.build_token_graph(
            text="Mon avocat m'a conseillé",
            context_before="le procès avait commencé",
            source_lang="fra_Latn",
            target_lang="eng_Latn",
            top_k_paths=1,
        )
        self.assertIsInstance(graph, TokenGraph)
        self.assertTrue(graph.paths)
        tokens = " ".join(tw.token for tw in graph.paths[0].token_weights)
        self.assertIn("lawyer", tokens.lower())

    def test_multiple_paths_normalised(self):
        """Multiple responses produce paths whose probabilities sum to ~1."""
        import math

        adapter = self._make_adapter()

        def _make_resp(word: str, score: float):
            lps = [self._make_logprob(word, score)]
            return self._make_response(word, lps)

        adapter._client.chat.side_effect = [
            _make_resp("locusts", -0.1),
            _make_resp("lobsters", -1.5),
        ]
        graph = adapter.build_token_graph(
            text="una plaga de langostas",
            context_before="plagas sobre Egipto",
            source_lang="spa_Latn",
            target_lang="eng_Latn",
            top_k_paths=2,
        )
        total_prob = sum(p.path_probability for p in graph.paths)
        self.assertAlmostEqual(total_prob, 1.0, places=5)

    def test_missing_ollama_package_raises_import_error(self):
        """A helpful ImportError is raised when the ollama package is absent."""
        from model_adapters import OllamaTranslateGemmaAdapter

        adapter = OllamaTranslateGemmaAdapter(model_name="translategemma")
        with patch.dict("sys.modules", {"ollama": None}):
            with self.assertRaises(ImportError):
                adapter._ensure_client()


class TestLlamaCppTranslateGemmaAdapter(unittest.TestCase):
    """Tests for LlamaCppTranslateGemmaAdapter using a mocked llama_cpp.Llama."""

    def _make_response(self, content: str, content_lps=None):
        """Build a dict that mimics the llama-cpp-python create_chat_completion return value."""
        if content_lps is not None:
            logprobs = {"content": content_lps}
        else:
            logprobs = None
        return {
            "choices": [
                {
                    "message": {"content": content},
                    "logprobs": logprobs,
                    "finish_reason": "stop",
                }
            ]
        }

    def _make_lp(self, token: str, logprob: float) -> dict:
        return {"token": token, "logprob": logprob, "bytes": None, "top_logprobs": []}

    def _make_adapter(self):
        from model_adapters import LlamaCppTranslateGemmaAdapter
        adapter = LlamaCppTranslateGemmaAdapter(model_path="/fake/model.gguf")
        adapter._llm = MagicMock()
        return adapter

    def test_builds_graph_from_logprobs(self):
        adapter = self._make_adapter()
        lps = [
            self._make_lp("The", -0.1),
            self._make_lp(" chef", -0.2),
            self._make_lp(" cooked", -0.3),
            self._make_lp(" lobster", -0.15),
        ]
        adapter._llm.create_chat_completion.return_value = self._make_response(
            "The chef cooked lobster", lps
        )
        graph = adapter.build_token_graph(
            text="El chef cocinó langosta",
            context_before="restaurante de mariscos",
            source_lang="spa_Latn",
            target_lang="eng_Latn",
            top_k_paths=1,
        )
        self.assertIsInstance(graph, TokenGraph)
        self.assertTrue(graph.paths)
        self.assertIn("lobster", graph.best_text.lower())

    def test_fallback_without_logprobs(self):
        """When no logprobs are returned, adapter falls back to uniform confidence."""
        adapter = self._make_adapter()
        adapter._llm.create_chat_completion.return_value = self._make_response(
            "The lawyer advised me", content_lps=None
        )
        graph = adapter.build_token_graph(
            text="Mon avocat m'a conseillé",
            context_before="le procès avait commencé",
            source_lang="fra_Latn",
            target_lang="eng_Latn",
            top_k_paths=1,
        )
        self.assertIsInstance(graph, TokenGraph)
        self.assertTrue(graph.paths)
        tokens = " ".join(tw.token for tw in graph.paths[0].token_weights)
        self.assertIn("lawyer", tokens.lower())

    def test_multiple_paths_normalised(self):
        """Multiple runs produce paths whose probabilities sum to ~1."""
        import math

        adapter = self._make_adapter()

        adapter._llm.create_chat_completion.side_effect = [
            self._make_response("locusts", [self._make_lp("locusts", -0.1)]),
            self._make_response("lobsters", [self._make_lp("lobsters", -1.5)]),
        ]
        graph = adapter.build_token_graph(
            text="una plaga de langostas",
            context_before="plagas sobre Egipto",
            source_lang="spa_Latn",
            target_lang="eng_Latn",
            top_k_paths=2,
        )
        total_prob = sum(p.path_probability for p in graph.paths)
        self.assertAlmostEqual(total_prob, 1.0, places=5)

    def test_greedy_run_uses_low_temperature(self):
        """The first call should use the low (greedy) temperature."""
        adapter = self._make_adapter()
        lps = [self._make_lp("Hello", -0.05)]
        adapter._llm.create_chat_completion.return_value = self._make_response("Hello", lps)
        adapter.build_token_graph(
            text="Hola", context_before="", source_lang="spa_Latn", target_lang="eng_Latn",
            top_k_paths=1,
        )
        call_kwargs = adapter._llm.create_chat_completion.call_args
        actual_temp = call_kwargs.kwargs.get("temperature")
        self.assertAlmostEqual(actual_temp, adapter._GREEDY_TEMP, places=3)

    def test_missing_package_raises_import_error(self):
        """A clear ImportError is raised when llama-cpp-python is absent."""
        from model_adapters import LlamaCppTranslateGemmaAdapter

        adapter = LlamaCppTranslateGemmaAdapter(model_path="/fake/model.gguf")
        with patch.dict("sys.modules", {"llama_cpp": None}):
            with self.assertRaises(ImportError):
                adapter._ensure_loaded()


class TestResolveOllamaGgufBlob(unittest.TestCase):
    """Tests for resolve_ollama_gguf_blob using a temporary fake Ollama model store."""

    def _write_manifest(self, models_root, registry, namespace, name, tag, layers):
        manifest_dir = models_root / "manifests" / registry / namespace / name
        manifest_dir.mkdir(parents=True)
        manifest = {"layers": layers}
        (manifest_dir / tag).write_text(json.dumps(manifest))

    def _write_blob(self, models_root, digest):
        blobs_dir = models_root / "blobs"
        blobs_dir.mkdir(parents=True, exist_ok=True)
        blob_name = digest.replace(":", "-")
        blob_path = blobs_dir / blob_name
        blob_path.write_bytes(b"GGUF")
        return blob_path

    def setUp(self):
        import tempfile
        self._tmpdir = tempfile.TemporaryDirectory()
        self.models_root = Path(self._tmpdir.name)

    def tearDown(self):
        self._tmpdir.cleanup()

    def _resolve(self, model_name):
        from model_adapters import resolve_ollama_gguf_blob
        return resolve_ollama_gguf_blob(model_name, ollama_models_dir=str(self.models_root))

    def test_simple_model_name(self):
        """'translategemma' resolves to registry.ollama.ai/library/translategemma:latest."""
        digest = "sha256:abc123"
        self._write_manifest(
            self.models_root,
            "registry.ollama.ai", "library", "translategemma", "latest",
            [{"mediaType": "application/vnd.ollama.image.model", "digest": digest}],
        )
        expected = self._write_blob(self.models_root, digest)
        result = self._resolve("translategemma")
        self.assertEqual(result, str(expected))

    def test_name_with_tag(self):
        """'translategemma:4b' resolves to the 4b tag manifest."""
        digest = "sha256:def456"
        self._write_manifest(
            self.models_root,
            "registry.ollama.ai", "library", "translategemma", "4b",
            [{"mediaType": "application/vnd.ollama.image.model", "digest": digest}],
        )
        self._write_blob(self.models_root, digest)
        result = self._resolve("translategemma:4b")
        self.assertTrue(result.endswith("sha256-def456"))

    def test_namespaced_model(self):
        """'user/mymodel:v1' uses the given namespace."""
        digest = "sha256:999aaa"
        self._write_manifest(
            self.models_root,
            "registry.ollama.ai", "user", "mymodel", "v1",
            [{"mediaType": "application/vnd.ollama.image.model", "digest": digest}],
        )
        self._write_blob(self.models_root, digest)
        result = self._resolve("user/mymodel:v1")
        self.assertTrue(result.endswith("sha256-999aaa"))

    def test_skips_non_model_layers(self):
        """Only the application/vnd.ollama.image.model layer is used."""
        digest = "sha256:modelblob"
        self._write_manifest(
            self.models_root,
            "registry.ollama.ai", "library", "translategemma", "latest",
            [
                {"mediaType": "application/vnd.ollama.image.params", "digest": "sha256:params"},
                {"mediaType": "application/vnd.ollama.image.model", "digest": digest},
            ],
        )
        self._write_blob(self.models_root, digest)
        result = self._resolve("translategemma")
        self.assertTrue(result.endswith("sha256-modelblob"))

    def test_missing_manifest_raises_file_not_found(self):
        """FileNotFoundError when the manifest does not exist."""
        with self.assertRaises(FileNotFoundError):
            self._resolve("nonexistent-model")

    def test_manifest_without_model_layer_raises_value_error(self):
        """ValueError when the manifest has no model layer."""
        self._write_manifest(
            self.models_root,
            "registry.ollama.ai", "library", "translategemma", "latest",
            [{"mediaType": "application/vnd.ollama.image.params", "digest": "sha256:params"}],
        )
        with self.assertRaises(ValueError):
            self._resolve("translategemma")

    def test_missing_blob_file_raises_file_not_found(self):
        """FileNotFoundError when the manifest exists but the blob is missing."""
        self._write_manifest(
            self.models_root,
            "registry.ollama.ai", "library", "translategemma", "latest",
            [{"mediaType": "application/vnd.ollama.image.model", "digest": "sha256:gone"}],
        )
        # deliberately do NOT write the blob
        with self.assertRaises(FileNotFoundError):
            self._resolve("translategemma")


if __name__ == "__main__":
    unittest.main()
