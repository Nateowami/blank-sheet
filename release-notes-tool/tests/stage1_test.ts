// Tests for Stage 1 PR summarization pipeline

import { assertEquals, assertStringIncludes } from "./test_utils.ts";
import { processPR, processDirectCommit, GET_FILE_DIFF_TOOL } from "../lib/stage1.ts";
import type { Config, GithubPR, GithubCommit, GithubPRFile, LlmResponse } from "../lib/types.ts";
import { GitHubClient } from "../lib/github.ts";
import { LlmClient } from "../lib/llm.ts";
import { Logger } from "../lib/logger.ts";
import { CURRENT_PR_SCHEMA_VERSION } from "../lib/types.ts";

// ─── Mock setup ───────────────────────────────────────────────────────────────

const config: Config = {
  github_repo: "owner/repo",
  base_branch: "sf-live",
  head_branch: "sf-qa",
  app_context_path: "./app-context.md",
  prs_dir: "/tmp/test-prs",
  releases_dir: "/tmp/test-releases",
  logs_dir: "/tmp/test-logs",
  diff: {
    max_tokens_per_pr: 50000,
    excluded_file_patterns: ["package-lock.json", "*.lock"],
  },
};

const samplePR: GithubPR = {
  number: 312,
  title: "Add CSV export to report service",
  body: "This PR adds CSV export functionality to the report service.",
  merged_at: "2026-05-10T14:22:00Z",
  state: "closed",
  head: { sha: "abc123", ref: "feature/csv-export" },
  base: { sha: "def456", ref: "sf-qa" },
};

const sampleCommits: GithubCommit[] = [
  {
    sha: "commit1",
    commit: {
      message: "Add CSV serializer",
      author: { name: "Dev", date: "2026-05-09T10:00:00Z" },
    },
    parents: [{ sha: "parent1" }],
  },
];

const sampleFiles: GithubPRFile[] = [
  {
    filename: "src/report/export.ts",
    status: "added",
    additions: 80,
    deletions: 0,
    changes: 80,
    patch: "+export function toCSV(data: Row[]): string {\n+  return data.map(r => r.join(',')).join('\\n');\n+}",
  },
  {
    filename: "package-lock.json",
    status: "modified",
    additions: 100,
    deletions: 50,
    changes: 150,
    patch: undefined,
  },
];

const mockModelJsonResponse = JSON.stringify({
  raw_context_summary: "PR adds CSV export to the report service.",
  classification: "user-facing",
  significance: "minor",
  internal_line_item: "PR #312 — added CSV export endpoint",
  external_line_item: "Users can now export reports as CSV",
  needs_review: false,
  needs_review_reason: null,
  insufficient_context: false,
  insufficient_context_reason: null,
  reverts_pr_number: null,
});

/** Build a mock fetch function that returns predefined responses. */
function makeMockFetch(
  githubResponses: Map<string, unknown>,
  llmResponses: LlmResponse[],
): (url: string, init?: RequestInit) => Promise<Response> {
  let llmCallIndex = 0;

  return async (url: string, _init?: RequestInit): Promise<Response> => {
    // LLM API calls
    if (url.includes("/chat/completions")) {
      const response = llmResponses[llmCallIndex] ?? llmResponses[llmResponses.length - 1];
      llmCallIndex++;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // GitHub API calls
    for (const [pattern, data] of githubResponses) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
  };
}

function makeGithubResponses(): Map<string, unknown> {
  return new Map([
    [`/pulls/312/files`, sampleFiles],
    [`/pulls/312/commits`, sampleCommits],
    [`/issues/312/comments`, []],
    [`/pulls/312/comments`, []],
    [`/pulls/312/reviews`, []],
  ]);
}

/** LLM response with no tool calls (direct JSON response). */
function makeFinalLlmResponse(content: string): LlmResponse {
  return {
    choices: [
      {
        message: { role: "assistant", content, tool_calls: [] },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
  };
}

/** LLM response with a tool call. */
function makeToolCallLlmResponse(filename: string): LlmResponse {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_file_diff",
                arguments: JSON.stringify({ filename }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 500, completion_tokens: 50 },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("processPR - basic happy path produces PrSummary", async () => {
  const mockFetch = makeMockFetch(
    makeGithubResponses(),
    [makeFinalLlmResponse(mockModelJsonResponse)],
  );

  const github = new GitHubClient("owner/repo", undefined, mockFetch);
  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger("/tmp/test-logs", "test.jsonl");

  // Ensure output dirs exist
  await Deno.mkdir("/tmp/test-prs", { recursive: true });
  await Deno.mkdir("/tmp/test-logs", { recursive: true });

  const result = await processPR(
    samplePR,
    config,
    "Test app context",
    github,
    llm,
    logger,
    false,
  );

  assertEquals(result.summary.pr_number, 312);
  assertEquals(result.summary.schema_version, CURRENT_PR_SCHEMA_VERSION);
  assertEquals(result.summary.classification, "user-facing");
  assertEquals(result.summary.significance, "minor");
  assertEquals(result.summary.title, "Add CSV export to report service");
  assertEquals(result.summary.merged_at, "2026-05-10T14:22:00Z");
  assertEquals(result.summary.external_line_item, "Users can now export reports as CSV");
  assertEquals(result.summary.needs_review, false);
});

Deno.test("processPR - agentic tool use: model reads a file diff then responds", async () => {
  const mockFetch = makeMockFetch(
    makeGithubResponses(),
    [
      makeToolCallLlmResponse("src/report/export.ts"),
      makeFinalLlmResponse(mockModelJsonResponse),
    ],
  );

  const github = new GitHubClient("owner/repo", undefined, mockFetch);
  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger("/tmp/test-logs", "test-tool-use.jsonl");

  await Deno.mkdir("/tmp/test-prs", { recursive: true });
  await Deno.mkdir("/tmp/test-logs", { recursive: true });

  const result = await processPR(
    samplePR,
    config,
    "Test app context",
    github,
    llm,
    logger,
    false,
  );

  assertEquals(result.summary.pr_number, 312);
  assertEquals(result.summary.classification, "user-facing");
});

Deno.test("processPR - manifest excludes lockfiles", async () => {
  // Track what was sent to the LLM to verify manifest content
  let capturedUserMessage = "";

  const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/chat/completions")) {
      const body = JSON.parse(init?.body as string);
      const userMsg = body.messages?.find((m: { role: string }) => m.role === "user");
      if (userMsg) capturedUserMessage = userMsg.content;
      return new Response(JSON.stringify(makeFinalLlmResponse(mockModelJsonResponse)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/pulls/312/files")) {
      return new Response(JSON.stringify(sampleFiles), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  const github = new GitHubClient("owner/repo", undefined, mockFetch);
  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger("/tmp/test-logs", "test-manifest.jsonl");

  await Deno.mkdir("/tmp/test-prs", { recursive: true });
  await Deno.mkdir("/tmp/test-logs", { recursive: true });

  await processPR(samplePR, config, "Test app context", github, llm, logger);

  assertStringIncludes(capturedUserMessage, "package-lock.json");
  assertStringIncludes(capturedUserMessage, "excluded");
  assertStringIncludes(capturedUserMessage, "lockfile");
});

Deno.test("processDirectCommit - always sets needs_review true", async () => {
  const directCommit: GithubCommit = {
    sha: "abcdef1234567890",
    commit: {
      message: "Fix urgent prod issue",
      author: { name: "Dev", date: "2026-05-10T10:00:00Z" },
    },
    parents: [{ sha: "parent1" }],
  };

  const modelResponse = JSON.stringify({
    raw_context_summary: "Urgent prod fix.",
    classification: "user-facing",
    significance: "patch",
    internal_line_item: "Direct commit abcdef12 — urgent prod fix",
    external_line_item: "Fixed an issue affecting users",
    needs_review: false,
    needs_review_reason: null,
    insufficient_context: false,
    insufficient_context_reason: null,
    reverts_pr_number: null,
  });

  const mockFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify(makeFinalLlmResponse(modelResponse)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger("/tmp/test-logs", "test-direct.jsonl");

  await Deno.mkdir("/tmp/test-prs", { recursive: true });
  await Deno.mkdir("/tmp/test-logs", { recursive: true });

  const result = await processDirectCommit(
    directCommit,
    [],
    config,
    "Test app context",
    llm,
    logger,
    false,
  );

  // Direct commits always have needs_review = true
  assertEquals(result.summary.needs_review, true);
  assertEquals(result.summary.pr_number, null);
});

Deno.test("processPR - model JSON with markdown fences is parsed correctly", async () => {
  const responseWithFences = "```json\n" + mockModelJsonResponse + "\n```";

  const mockFetch = makeMockFetch(
    makeGithubResponses(),
    [makeFinalLlmResponse(responseWithFences)],
  );

  const github = new GitHubClient("owner/repo", undefined, mockFetch);
  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger("/tmp/test-logs", "test-fences.jsonl");

  await Deno.mkdir("/tmp/test-prs", { recursive: true });
  await Deno.mkdir("/tmp/test-logs", { recursive: true });

  const result = await processPR(
    samplePR,
    config,
    "Test app context",
    github,
    llm,
    logger,
    false,
  );

  assertEquals(result.summary.classification, "user-facing");
});

Deno.test("GET_FILE_DIFF_TOOL - correct schema", () => {
  assertEquals(GET_FILE_DIFF_TOOL.type, "function");
  assertEquals(GET_FILE_DIFF_TOOL.function.name, "get_file_diff");
  assertEquals(typeof GET_FILE_DIFF_TOOL.function.description, "string");
});
