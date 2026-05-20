// Tests for Stage 2 release note generation

import { assertEquals, assertStringIncludes, assertRejects } from "./test_utils.ts";
import { runStage2, loadAllPrSummaries } from "../lib/stage2.ts";
import type { Config, LlmResponse, PrSummary, ReleaseNotes } from "../lib/types.ts";
import { LlmClient } from "../lib/llm.ts";
import { Logger } from "../lib/logger.ts";
import { CURRENT_PR_SCHEMA_VERSION, CURRENT_RELEASE_SCHEMA_VERSION } from "../lib/types.ts";
import { join } from "node:path";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const config: Config = {
  github_repo: "owner/repo",
  base_branch: "sf-live",
  head_branch: "sf-qa",
  app_context_path: "./app-context.md",
  prs_dir: "/tmp/test-stage2-prs",
  releases_dir: "/tmp/test-stage2-releases",
  logs_dir: "/tmp/test-stage2-logs",
  diff: {
    max_tokens_per_pr: 50000,
    excluded_file_patterns: ["package-lock.json"],
  },
};

const sampleSummaries: PrSummary[] = [
  {
    schema_version: CURRENT_PR_SCHEMA_VERSION,
    pr_number: 312,
    title: "Add CSV export",
    merged_at: "2026-05-10T14:22:00Z",
    raw_context_summary: "Adds CSV export to report service.",
    classification: "user-facing",
    significance: "minor",
    internal_line_item: "PR #312 — added CSV export",
    external_line_item: "Users can now export reports as CSV",
    needs_review: false,
    needs_review_reason: null,
    insufficient_context: false,
    insufficient_context_reason: null,
    reverts_pr_number: null,
  },
  {
    schema_version: CURRENT_PR_SCHEMA_VERSION,
    pr_number: 315,
    title: "Migrate CI to GitHub Actions",
    merged_at: "2026-05-11T10:00:00Z",
    raw_context_summary: "Migrates CI pipeline.",
    classification: "tooling",
    significance: "patch",
    internal_line_item: "PR #315 — migrated CI pipeline",
    external_line_item: null,
    needs_review: false,
    needs_review_reason: null,
    insufficient_context: false,
    insufficient_context_reason: null,
    reverts_pr_number: null,
  },
];

const sampleReleaseNotesModel: Omit<ReleaseNotes, "schema_version" | "generated_at" | "base_ref" | "head_ref" | "version" | "previous_version" | "bump_type" | "bump_override"> = {
  changes: [
    {
      pr_numbers: [312],
      classification: "user-facing",
      significance: "minor",
      internal_line_item: "PR #312 — added CSV export endpoint",
      external_line_item: "Users can now export reports as CSV",
      needs_review: false,
      needs_review_reason: null,
    },
    {
      pr_numbers: [315],
      classification: "tooling",
      significance: "patch",
      internal_line_item: "PR #315 — migrated CI pipeline to GitHub Actions",
      external_line_item: null,
      needs_review: false,
      needs_review_reason: null,
    },
  ],
  reverted_changes: [],
  needs_review: [],
};

function makeModelReleaseResponse(partial = {}): string {
  return JSON.stringify({
    schema_version: 1,
    generated_at: "2026-05-20T10:32:00Z",
    base_ref: "sf-live",
    head_ref: "sf-qa",
    version: "SFv5.57.0",
    previous_version: "SFv5.56.0",
    bump_type: "minor",
    bump_override: false,
    ...sampleReleaseNotesModel,
    ...partial,
  });
}

function makeLlmResponse(content: string): LlmResponse {
  return {
    choices: [
      {
        message: { role: "assistant", content, tool_calls: [] },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 2000, completion_tokens: 500 },
  };
}

async function writePrSummaries(dir: string, summaries: PrSummary[]): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  for (const s of summaries) {
    const filename = s.pr_number !== null ? `${s.pr_number}.json` : "direct.json";
    await Deno.writeTextFile(join(dir, filename), JSON.stringify(s, null, 2));
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("runStage2 - generates release notes from PR summaries", async () => {
  await writePrSummaries(config.prs_dir, sampleSummaries);
  await Deno.mkdir(config.releases_dir, { recursive: true });
  await Deno.mkdir(config.logs_dir, { recursive: true });

  const mockFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify(makeLlmResponse(makeModelReleaseResponse())), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  };

  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger(config.logs_dir, "release-test.jsonl");

  const result = await runStage2({
    config,
    appContext: "Test app context",
    llm,
    logger,
    currentVersion: "SFv5.56.0",
    verbose: false,
  });

  assertEquals(result.releaseNotes.schema_version, CURRENT_RELEASE_SCHEMA_VERSION);
  assertEquals(result.releaseNotes.previous_version, "SFv5.56.0");
  assertEquals(result.releaseNotes.base_ref, "sf-live");
  assertEquals(result.releaseNotes.head_ref, "sf-qa");
  assertEquals(result.releaseNotes.bump_override, false);
  assertEquals(result.releaseNotes.changes.length, 2);
});

Deno.test("runStage2 - bump override is respected", async () => {
  await writePrSummaries(config.prs_dir, sampleSummaries);

  const mockFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify(makeLlmResponse(makeModelReleaseResponse())), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  };

  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger(config.logs_dir, "release-bump-test.jsonl");

  const result = await runStage2({
    config,
    appContext: "Test app context",
    llm,
    logger,
    currentVersion: "SFv5.56.0",
    bumpOverride: "major",
    verbose: false,
  });

  assertEquals(result.releaseNotes.bump_type, "major");
  assertEquals(result.releaseNotes.bump_override, true);
  assertEquals(result.releaseNotes.version, "SFv6.0.0");
});

Deno.test("runStage2 - authoritative fields override model output", async () => {
  await writePrSummaries(config.prs_dir, sampleSummaries);

  const mockFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes("/chat/completions")) {
      // Model tries to set wrong values — our code should override them
      const wrongResponse = makeModelReleaseResponse({
        base_ref: "wrong-branch",
        head_ref: "also-wrong",
        schema_version: 999,
      });
      return new Response(JSON.stringify(makeLlmResponse(wrongResponse)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  };

  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger(config.logs_dir, "release-override-test.jsonl");

  const result = await runStage2({
    config,
    appContext: "Test app context",
    llm,
    logger,
    currentVersion: "SFv5.56.0",
    verbose: false,
  });

  // Our code forces the correct values
  assertEquals(result.releaseNotes.base_ref, "sf-live");
  assertEquals(result.releaseNotes.head_ref, "sf-qa");
  assertEquals(result.releaseNotes.schema_version, CURRENT_RELEASE_SCHEMA_VERSION);
});

Deno.test("runStage2 - null currentVersion falls back gracefully", async () => {
  await writePrSummaries(config.prs_dir, sampleSummaries);

  const mockFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify(makeLlmResponse(makeModelReleaseResponse())), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  };

  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger(config.logs_dir, "release-null-version.jsonl");

  const result = await runStage2({
    config,
    appContext: "Test app context",
    llm,
    logger,
    currentVersion: null,
    verbose: false,
  });

  assertEquals(result.releaseNotes.previous_version, "SFv0.0.0");
});

Deno.test("loadAllPrSummaries - returns empty array when dir missing", async () => {
  const summaries = await loadAllPrSummaries("/tmp/nonexistent-prs-dir-xyz");
  assertEquals(summaries, []);
});

Deno.test("loadAllPrSummaries - reads and validates all JSON files", async () => {
  const testDir = "/tmp/test-load-prs";
  await writePrSummaries(testDir, sampleSummaries);

  const summaries = await loadAllPrSummaries(testDir);
  assertEquals(summaries.length, 2);
  // Verify they all passed validation
  for (const s of summaries) {
    assertEquals(s.schema_version, CURRENT_PR_SCHEMA_VERSION);
  }
});

Deno.test("runStage2 - infers minor bump from mixed significances", async () => {
  await writePrSummaries(config.prs_dir, sampleSummaries); // has minor + patch

  const mockFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify(makeLlmResponse(makeModelReleaseResponse())), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  };

  const llm = new LlmClient({
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: undefined,
    fetchFn: mockFetch,
  });
  const logger = new Logger(config.logs_dir, "release-infer-bump.jsonl");

  const result = await runStage2({
    config,
    appContext: "Test app context",
    llm,
    logger,
    currentVersion: "SFv5.56.0",
    verbose: false,
  });

  // minor + patch → minor bump
  assertEquals(result.releaseNotes.bump_type, "minor");
  assertEquals(result.releaseNotes.version, "SFv5.57.0");
});
