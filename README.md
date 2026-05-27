# Bugsnag Error Analysis Tool

A locally-run error analysis tool that ingests raw events from Bugsnag, archives them permanently, and applies multi-layer smart grouping to produce actionable error intelligence.

## Tech Stack

- **Runtime**: Deno (TypeScript)
- **Database**: MongoDB (local install)
- **LLM + Embeddings**: Any OpenAI-compatible endpoint (default: Ollama)
- **UI**: Web app served by Deno on `localhost:3000`

## Setup

1. **Install prerequisites**
   - [Deno](https://deno.land/) v1.40+
   - [MongoDB](https://www.mongodb.com/try/download/community) running locally
   - [Ollama](https://ollama.ai/) (or any OpenAI-compatible endpoint)

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your Bugsnag API key
   ```

3. **Configure project** — edit `config.json`:
   - Set `bugsnag.projectId` to your Bugsnag project ID
   - Set `llm.embeddingModel` and `llm.chatModel` to your Ollama models
   - Adjust grouping thresholds as needed

4. **Pull Ollama models**
   ```bash
   ollama pull mxbai-embed-large
   ollama pull llama3
   ```

## Usage

```bash
# Ingest new events from Bugsnag + run grouping pipeline
deno task ingest

# Start the web UI (http://localhost:3000)
deno task serve
```

## Web UI

Visit `http://localhost:3000` after starting the server. Pages:

| Page | Description |
|---|---|
| Dashboard | Stats, events/day chart, top groups |
| Groups | All active groups with filtering/sorting |
| Group Detail | Full detail, stack trace, merge history, markdown export |
| Merge Suggestions | LLM-proposed merges awaiting human review |
| Merge History | Log of all merges with undo capability |
| Trends | Stacked area chart of error volume over time |

## Architecture

```
src/
├── ingest/       — Bugsnag API client + ingest pipeline
├── grouping/     — Normalize, template match, embedding similarity, pipeline
├── llm/          — OpenAI-compatible client with concurrency-1 queue
├── db/           — MongoDB connection + typed collections
├── server/       — HTTP server + API handlers + web UI
└── summary/      — Markdown summary generator
```

## Data Model

- **`events`** — Append-only raw Bugsnag events
- **`groups`** — Smart grouping layer; events are never moved
- **`merge_suggestions`** — LLM-proposed merges pending review
- **`event_embeddings`** — Stored embeddings (separate from immutable events)
- **`ingestion_state`** — Last ingested timestamp per project

## Grouping Pipeline

1. **Exact normalized message match** — instant deduplication
2. **Template match** — regex patterns from LLM-extracted templates
3. **Embedding similarity** — cosine similarity with auto-merge and LLM-candidate thresholds
4. **Template extraction** — LLM extracts templates for groups with ≥5 events
5. **Feedback loop** — newly-extracted templates re-match existing singletons
6. **LLM merge suggestions** — arbiter LLM decides whether similar groups should merge
