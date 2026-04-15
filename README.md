# blank-sheet

Primary/secondary translation-fusion experiment combining NLLB (encoder-decoder,
high accuracy) with TranslateGemma (decoder-only, context-aware).

## How it works

1. **Primary model** (NLLB) translates a sentence and produces a token-weight
   graph from beam search.  Multiple beams give multiple candidate paths; per-token
   probabilities come from `compute_transition_scores`.
2. **Secondary model** (TranslateGemma) receives the same sentence *plus*
   `context_before` in a structured prompt so it can resolve context-dependent
   word senses (e.g. Spanish *langosta* → locust vs. lobster).
3. **Fusion** merges the two graphs by comparing word-level confidence
   segments weighted by `--primary-weight` / `--secondary-weight`.
4. A human-readable **impact report** shows exactly which words or phrases were
   swapped because of the secondary model.

Intermediary token graphs and merge results are saved to `artifacts/fusion_run/`
as JSON for inspection.

## Requirements

```bash
pip install -r requirements.txt
```

## Run with real models

### Option A — llama.cpp / llama-cpp-python (no server, no HuggingFace token)

#### From an Ollama-pulled model (easiest)

If you have already pulled the model with Ollama, you can point llama.cpp
directly at the GGUF blob that Ollama already downloaded — **no separate GGUF
download and no Ollama server needed**:

```bash
ollama pull translategemma:4b   # only needed once; skip if already pulled
pip install llama-cpp-python
python run_experiment.py \
  --primary-model facebook/nllb-200-distilled-600M \
  --llamacpp-from-ollama-model translategemma:4b \
  --primary-weight 0.6 \
  --secondary-weight 0.4 \
  --verbose
```

`--llamacpp-from-ollama-model` reads the Ollama manifest under
`~/.ollama/models/` and resolves the matching GGUF blob automatically.

#### From a standalone GGUF file

Download a GGUF of TranslateGemma (e.g. from HuggingFace or convert with
`llama.cpp/convert_hf_to_gguf.py`), then run:

```bash
pip install llama-cpp-python
python run_experiment.py \
  --primary-model facebook/nllb-200-distilled-600M \
  --secondary-llamacpp-model /path/to/translategemma-4b-it-q4_k_m.gguf \
  --primary-weight 0.6 \
  --secondary-weight 0.4 \
  --verbose
```

Use `--llamacpp-n-gpu-layers -1` to offload all layers to GPU (works with both
`--llamacpp-from-ollama-model` and `--secondary-llamacpp-model`).

> **Note:** llama.cpp does not implement HuggingFace-style beam search.
> Multiple independent generation runs at varying temperatures are used instead
> to produce the same set of candidate paths.

### Option B — Ollama (requires a running Ollama server)

Install [Ollama](https://ollama.com), pull a compatible TranslateGemma GGUF,
then run:

```bash
ollama pull translategemma   # or whatever model name you imported
python run_experiment.py \
  --primary-model facebook/nllb-200-distilled-600M \
  --secondary-ollama-model translategemma \
  --primary-weight 0.6 \
  --secondary-weight 0.4 \
  --verbose
```

The `--ollama-host` flag (default: `http://localhost:11434`) lets you point at a
remote Ollama server.

### Option C — HuggingFace (loads weights into Python memory)

`google/translategemma-4b-it` is a gated model.  Before running, you must:

1. Accept Google's licence at <https://huggingface.co/google/translategemma-4b-it>
2. Set your HuggingFace token: `export HF_TOKEN=<your_token>`

Then run:

```bash
python run_experiment.py \
  --primary-model facebook/nllb-200-distilled-600M \
  --secondary-model google/translategemma-4b-it \
  --primary-weight 0.6 \
  --secondary-weight 0.4 \
  --verbose
```

Swap `--primary-model` for `facebook/nllb-200-3.3B` for higher-accuracy primary
translations.

## Run without model weights (stubs)

Omit `--primary-model` and `--secondary-model` to use the lightweight stub
adapters.  They return canned translations that still exercise the full fusion
and reporting pipeline:

```bash
python run_experiment.py
```

## Test

```bash
python -m unittest discover -s tests -p "test_*.py"
```

## Dataset

`data/context_dataset.jsonl` — twelve cross-language, context-dependent
sentences spanning Spanish, French, and German.  Each sentence contains a word
whose translation changes depending on surrounding context:

| Ambiguous word | Language | Context A → meaning | Context B → meaning |
|---|---|---|---|
| *langosta* | Spanish | Biblical plagues → **locust** | Seafood restaurant → **lobster** |
| *avocat* | French | Courtroom → **lawyer** | Healthy breakfast → **avocado** |
| *copa* | Spanish | Sports win → **trophy/cup** | Restaurant → **wine glass** |
| *Bank* | German | Park bench → **bench** | Finance → **bank** |
| *grève* | French | Labor dispute → **strike** | Seaside holiday → **shore/beach** |
| *planta* | Spanish | Hiking feet → **sole (of foot)** | Office building → **ground floor** |

