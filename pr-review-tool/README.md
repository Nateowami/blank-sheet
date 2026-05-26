# PR Review Tool

A Deno script that reviews a GitHub pull request against its associated Jira issue(s) using an LLM.

## Usage

```sh
deno run --allow-net --allow-env review-pr.ts <github-pr-url>
```

Or, using the task shorthand:

```sh
deno task run <github-pr-url>
```

### Example

```sh
deno task run https://github.com/owner/repo/pull/42
```

## Environment variables

| Variable        | Required | Description |
|-----------------|----------|-------------|
| `LLM_BASE_URL`  | Yes      | Base URL of an OpenAI-compatible LLM API (e.g. `http://localhost:11434/v1` for Ollama) |
| `LLM_MODEL`     | Yes      | Model name to use (e.g. `gpt-4o`, `llama3`) |
| `LLM_API_KEY`   | No       | API key for the LLM (omit for local models) |
| `GITHUB_TOKEN`  | No       | GitHub personal access token. Omitting it reduces the rate limit to 60 requests/hour. |
| `JIRA_BASE_URL` | No*      | Base URL of your Jira instance (e.g. `https://jira.example.com`) |
| `JIRA_TOKEN`    | No*      | Jira personal access token |

\* Required when the PR title contains Jira issue keys (e.g. `SF-1234`).

## What it does

1. **Parses the PR URL** to extract the repository and PR number.
2. **Fetches the PR** — title, description, changed files (with diffs), commits, comments, and reviews — from the GitHub REST API.
3. **Extracts Jira issue keys** (standard `PROJECT-NNNN` format, e.g. `SF-1234`) from the PR title.
4. **Fetches each Jira issue** (including comments) from the Jira REST API, if keys are found and credentials are set.
5. **Calls the LLM** with all gathered context and asks it to evaluate:
   - Does the PR implement everything in the Jira issue(s)?
   - Does the PR title accurately describe what was done?
   - Are there omissions the Jira issue or title suggests should be present?
   - Are there any other problems noticed during the review?
6. **Prints the findings** to stdout.

Progress and warning messages are written to stderr so they can be separated from the report if needed.
