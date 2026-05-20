// Stage 2: Release note generation

import type { Config, PrSummary, ReleaseNotes, BumpType } from "./types.ts";
import { CURRENT_RELEASE_SCHEMA_VERSION } from "./types.ts";
import type { LlmClient } from "./llm.ts";
import type { Logger } from "./logger.ts";
import { validatePrSummary } from "./schema.ts";
import { inferBumpType, bumpVersion, parseVersion } from "./version.ts";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

// ─── System prompt ────────────────────────────────────────────────────────────

function buildStage2SystemPrompt(appContext: string): string {
  return `You are a release notes generator. Your job is to synthesize a set of per-PR summaries into a structured release notes document.

## Application Context

${appContext}

## Your Task

Given an array of PR summary objects, produce a final release notes JSON document. Follow these rules precisely:

### 1. Identify Revert Pairs
If PR B has \`reverts_pr_number\` pointing to PR A (and PR A is in the set), both A and B are a revert pair. Move both to \`reverted_changes\` only. Do NOT include them in \`changes\`.

### 2. Exclude Same-Cycle Bug Intro + Fix Pairs
If a PR introduces a bug and another PR in this same set fixes it, neither should appear in external notes. They may appear in internal notes but should not appear in \`changes\` as user-facing items.

### 3. Collapse Related Changes
Multiple PRs that address the same general area (e.g., several minor UI fixes, several dependency upgrades) should be collapsed into a single entry with a \`pr_numbers\` array containing all PR numbers. The collapsed external line item should be general (e.g., "Various minor UI fixes").

### 4. Sort by Significance
Within each section, order items by significance: \`major\` first, then \`minor\`, then \`patch\`.

### 5. Write Natural Prose
For \`external_line_item\`: write concise, non-technical prose for non-technical end users. Mention affected roles where natural (e.g., "Admins can now...", "Fixed a bug that prevented Editors from..."). Do NOT include the specific technical scenario.

For \`internal_line_item\`: be specific and technical. Reference PR numbers (e.g., "PR #312 — ...").

Set \`external_line_item\` to null for \`tooling\` and \`internal\` classification.

### 6. Flag Needs Review Items
Any PR with \`needs_review: true\` or \`insufficient_context: true\` should appear in the \`needs_review\` array of the output (in addition to appearing in \`changes\` if applicable).

### 7. Output Only Valid JSON
Respond with ONLY a valid JSON object matching the schema below. No markdown fences, no preamble, no explanation.

## Output Schema

\`\`\`
{
  "schema_version": 1,
  "generated_at": "<ISO 8601>",
  "base_ref": "<base_branch>",
  "head_ref": "<head_branch>",
  "version": "<proposed_version>",
  "previous_version": "<current_version>",
  "bump_type": "major" | "minor" | "patch",
  "bump_override": boolean,
  "changes": [
    {
      "pr_numbers": [312],
      "classification": "user-facing",
      "significance": "minor",
      "internal_line_item": "PR #312 — ...",
      "external_line_item": "Users can now ...",
      "needs_review": false,
      "needs_review_reason": null
    }
  ],
  "reverted_changes": [
    {
      "pr_numbers": [309, 316],
      "note": "PR #309 introduced X. PR #316 reverted it."
    }
  ],
  "needs_review": [
    {
      "pr_numbers": [320],
      "reason": "..."
    }
  ]
}
\`\`\``;
}

// ─── JSON extraction ──────────────────────────────────────────────────────────

function extractJson(content: string): unknown {
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : content.trim();
  const start = jsonStr.indexOf("{");
  const end = jsonStr.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in model response: ${content.slice(0, 200)}`);
  }
  return JSON.parse(jsonStr.slice(start, end + 1));
}

// ─── Read all PR summaries from prs/ directory ────────────────────────────────

export async function loadAllPrSummaries(prsDir: string): Promise<PrSummary[]> {
  const summaries: PrSummary[] = [];
  try {
    for await (const entry of Deno.readDir(prsDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const filePath = join(prsDir, entry.name);
      const text = await Deno.readTextFile(filePath);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error(`Failed to parse JSON in ${filePath}`);
      }
      summaries.push(validatePrSummary(filePath, raw));
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return [];
    }
    throw err;
  }
  return summaries;
}

// ─── Main Stage 2 function ────────────────────────────────────────────────────

export interface Stage2Options {
  config: Config;
  appContext: string;
  llm: LlmClient;
  logger: Logger;
  currentVersion: string | null;
  bumpOverride?: BumpType;
  verbose?: boolean;
}

export async function runStage2(options: Stage2Options): Promise<{
  releaseNotes: ReleaseNotes;
  jsonPath: string;
  mdPath: string;
}> {
  const { config, appContext, llm, logger, currentVersion, bumpOverride, verbose } = options;

  const summaries = await loadAllPrSummaries(config.prs_dir);

  if (summaries.length === 0) {
    throw new Error("No PR summaries found in prs/ directory. Run generate-pr-summaries first.");
  }

  if (verbose) console.log(`Loaded ${summaries.length} PR summaries.`);

  // Pre-flight: detect revert pairs
  const revertedPrNumbers = new Set<number | null>();
  for (const s of summaries) {
    if (s.reverts_pr_number !== null) {
      revertedPrNumbers.add(s.reverts_pr_number);
      revertedPrNumbers.add(s.pr_number);
    }
  }

  // Auto-infer bump type from significances
  const significances = summaries
    .filter((s) => s.pr_number !== null && !revertedPrNumbers.has(s.pr_number))
    .map((s) => s.significance);
  const inferredBump = inferBumpType(significances.length > 0 ? significances : ["patch"]);
  const bumpType: BumpType = bumpOverride ?? inferredBump;

  // Resolve next version
  const previousVersion = currentVersion ?? "SFv0.0.0";
  const parsed = parseVersion(previousVersion);
  const nextVersion = parsed
    ? bumpVersion(parsed, bumpType)
    : `SFv0.1.0`;

  if (verbose) {
    console.log(`Previous version: ${previousVersion}`);
    console.log(`Next version: ${nextVersion} (${bumpType}${bumpOverride ? " — overridden" : ""})`);
  }

  // Build the Stage 2 prompt
  const systemPrompt = buildStage2SystemPrompt(appContext);
  const generatedAt = new Date().toISOString();

  const userMessage = `Please generate release notes for this release.

## Release Metadata

- Base branch: ${config.base_branch}
- Head branch: ${config.head_branch}
- Previous version: ${previousVersion}
- Proposed next version: ${nextVersion}
- Bump type: ${bumpType}${bumpOverride ? " (manually overridden)" : " (auto-inferred)"}
- Generated at: ${generatedAt}

## PR Summaries

\`\`\`json
${JSON.stringify(summaries, null, 2)}
\`\`\``;

  if (verbose) console.log("Calling LLM for release notes generation...");

  const result = await llm.complete(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    {
      stage: 2,
      prNumber: null,
      logger,
    },
  );

  let raw: unknown;
  try {
    raw = extractJson(result.content);
  } catch (err) {
    throw new Error(`Failed to parse release notes JSON from model: ${err}`);
  }

  // Merge in authoritative values (don't trust model for these)
  const releaseNotes: ReleaseNotes = {
    ...(raw as ReleaseNotes),
    schema_version: CURRENT_RELEASE_SCHEMA_VERSION,
    generated_at: generatedAt,
    base_ref: config.base_branch,
    head_ref: config.head_branch,
    version: nextVersion,
    previous_version: previousVersion,
    bump_type: bumpType,
    bump_override: !!bumpOverride,
  };

  // Write output files
  const timestamp = generatedAt.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-").replace("Z", "");
  const baseName = `${nextVersion}_${timestamp}`;
  const jsonPath = join(config.releases_dir, `${baseName}.json`);
  const mdPath = join(config.releases_dir, `${baseName}.md`);

  await mkdir(config.releases_dir, { recursive: true });
  await Deno.writeTextFile(jsonPath, JSON.stringify(releaseNotes, null, 2) + "\n");

  return { releaseNotes, jsonPath, mdPath };
}
