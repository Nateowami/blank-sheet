# blank-sheet

A lightweight LLM agent harness that connects an [Ollama](https://ollama.com/)
model to a web browser via [Playwright](https://playwright.dev/). The model
reads an objective from a markdown file and then interacts with web pages by
issuing simple JSON actions (click, type, scroll, etc.). A full conversation
log—with screenshots—is saved as markdown after every run.

## Prerequisites

- [Deno](https://deno.land/) ≥ 2.0
- [Ollama](https://ollama.com/) running locally (default `http://localhost:11434`)
- A multimodal model pulled into Ollama (default: `gemma3:27b`)

## Quick start

```bash
# 1. Pull a model (if you haven't already)
ollama pull gemma3:27b

# 2. Run the agent with the default objective
deno run --allow-all agent.ts

# 3. Or specify a custom objective file
deno run --allow-all agent.ts my-objective.md
```

## Configuration

All configuration is via environment variables:

| Variable        | Default                     | Description                      |
| --------------- | --------------------------- | -------------------------------- |
| `OLLAMA_BASE`   | `http://localhost:11434`    | Ollama API base URL              |
| `OLLAMA_MODEL`  | `gemma3:27b`                | Model name to use                |
| `MAX_TURNS`     | `40`                        | Maximum agent turns              |
| `ACTION_DELAY_MS` | `2000`                    | Pause (ms) after each action     |

## How it works

1. The agent reads an objective from a markdown file.
2. It launches a headless Chromium browser via Playwright.
3. Each turn, the model receives:
   - A screenshot of the current page
   - A text description of the page (URL, title, interactive elements, visible text)
4. The model responds with a single JSON action, e.g. `{"action": "click", "text": "Log in"}`.
5. The agent executes the action, waits briefly, and repeats.
6. If the model makes a mistake (bad action name, missing argument), it receives
   a helpful error message explaining what went wrong and how to fix it.
7. The run ends when the model uses the `"done"` action or hits the turn limit.

## Available actions

| Action   | Description                              | Example                                                    |
| -------- | ---------------------------------------- | ---------------------------------------------------------- |
| `click`  | Click an element by visible text/label   | `{"action": "click", "text": "Log in"}`                   |
| `type`   | Type into an input by placeholder/label  | `{"action": "type", "text": "Search", "input": "hello"}`  |
| `scroll` | Scroll the page up or down               | `{"action": "scroll", "direction": "down"}`                |
| `goto`   | Navigate to a URL                        | `{"action": "goto", "url": "https://example.com"}`        |
| `back`   | Go to the previous page                  | `{"action": "back"}`                                       |
| `wait`   | Wait for a number of seconds (max 10)    | `{"action": "wait", "seconds": 3}`                         |
| `done`   | Signal that the objective is complete    | `{"action": "done", "summary": "Found the answer: ..."}`  |
| `help`   | Get help on an action                    | `{"action": "help", "topic": "click"}`                     |

When multiple elements match a `click` or `type`, the model is shown a numbered
list and asked to retry with an `"index"` field.

## Output

Each run creates a timestamped directory under `runs/` containing:

- `turn-NNN.png` — screenshots for each turn
- `log.md` — the full conversation log with embedded screenshots

## Writing objectives

Create a markdown file describing what the model should do:

```markdown
# Objective

Go to https://en.wikipedia.org and search for "Deno (software)".
Find the name of the original author and the year of first release.
```