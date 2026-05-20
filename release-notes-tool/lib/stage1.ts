// Stage 1: PR summarization pipeline

import type { Config, GithubCommit, GithubPR, GithubPRFile, PrSummary } from "./types.ts";
import { CURRENT_PR_SCHEMA_VERSION } from "./types.ts";
import type { GitHubClient } from "./github.ts";
import type { LlmClient } from "./llm.ts";
import { Logger } from "./logger.ts";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

// ─── Manifest building ────────────────────────────────────────────────────────

const MAX_FILE_LINES = 200;
// Rough approximation: 4 characters per token
const CHARS_PER_TOKEN = 4;

function matchesExcludePattern(filename: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (matchGlob(filename, pattern)) {
      if (
        pattern.includes("lock") ||
        filename.endsWith(".lock") ||
        filename === "package-lock.json" ||
        filename === "yarn.lock"
      ) {
        return "lockfile";
      }
      if (pattern.includes("min.js") || pattern.includes("min.css")) {
        return "minified file";
      }
      if (pattern.includes("dist") || pattern.includes("build")) {
        return "build artifact";
      }
      if (pattern.includes("generated")) {
        return "generated file";
      }
      if (pattern.includes("migrations")) {
        return "migration file";
      }
      return "excluded by pattern";
    }
  }
  return null;
}

function matchGlob(filename: string, pattern: string): boolean {
  // Simple glob matching: support *, **, and exact names
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  // Also check just the basename for patterns without slashes
  const basename = filename.split("/").pop() ?? filename;
  return regex.test(filename) || (!pattern.includes("/") && regex.test(basename));
}

interface FileManifestEntry {
  filename: string;
  additions: number;
  deletions: number;
  excluded: boolean;
  excludeReason: string | null;
  truncated: boolean;
  originalLines: number;
  patch: string | null;
}

function buildManifest(
  files: GithubPRFile[],
  excludePatterns: string[],
): FileManifestEntry[] {
  return files.map((f) => {
    const excludeReason = matchesExcludePattern(f.filename, excludePatterns);
    if (excludeReason) {
      return {
        filename: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        excluded: true,
        excludeReason,
        truncated: false,
        originalLines: 0,
        patch: null,
      };
    }

    const patch = f.patch ?? null;
    const lines = patch ? patch.split("\n") : [];
    const truncated = lines.length > MAX_FILE_LINES;

    return {
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      excluded: false,
      excludeReason: null,
      truncated,
      originalLines: lines.length,
      patch: truncated ? lines.slice(0, MAX_FILE_LINES).join("\n") : patch,
    };
  });
}

function renderManifest(entries: FileManifestEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const name = e.filename.padEnd(50);
    if (e.excluded) {
      lines.push(`${name} [excluded — ${e.excludeReason}]`);
    } else if (e.truncated) {
      lines.push(
        `${name} +${e.additions} / -${e.deletions}  [truncated — ${e.originalLines} lines, showing first ${MAX_FILE_LINES}]`,
      );
    } else {
      lines.push(`${name} +${e.additions} / -${e.deletions}`);
    }
  }
  return lines.join("\n");
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildStage1SystemPrompt(appContext: string): string {
  return `You are a release notes analyst. Your job is to analyze GitHub pull requests and produce structured JSON summaries.

## Application Context

${appContext}

## Your Task

Analyze the provided pull request and determine:
1. What the PR actually accomplished and why (regardless of what the title says)
2. How to classify it
3. Its significance
4. Appropriate line items for internal and external release notes

## Classification Categories

- **tooling**: Developer-only changes — CI/CD pipelines, dependency upgrades, refactors, tests, build infrastructure, code style, linting. These changes have no impact on users or admins.
- **internal**: Changes affecting serval admins or system admins (system-level roles, not project-level users). Examples: admin dashboards, system configuration, audit logs, org-level management.
- **user-facing**: Changes visible or impactful to project-level users (Project Admins, Editors, Viewers, Reviewers). This includes any UI changes, workflow changes, bug fixes, or new features that affect end users.

## Significance Levels

- **major**: Extremely rare. Reserved for breaking changes, fundamental architecture shifts, or changes that significantly alter how large groups of users work. Set the bar very high.
- **minor**: New features, meaningful improvements, significant bug fixes that users will notice.
- **patch**: Small bug fixes, minor UI tweaks, performance improvements, invisible internal refactors.

## Instructions

- Be skeptical of PR titles. Weight code diffs and discussion more heavily when they conflict with the title.
- Write user-facing line items that naturally mention affected roles where relevant (e.g., "Admins can now...", "Fixed a bug that prevented Editors from...").
- The \`external_line_item\` must be null if classification is "tooling" or "internal".
- Keep \`external_line_item\` concise and non-technical. Write for a non-technical end user.
- Set \`insufficient_context: true\` if you genuinely cannot determine the intent or impact with confidence. A flagged unknown is preferable to a wrong answer.
- Set \`needs_review: true\` if you flag something requiring human attention (e.g., the PR seems risky, the diff and title conflict significantly, or context is insufficient).
- Set \`reverts_pr_number\` if this PR appears to undo another specific PR's changes (provide the PR number being reverted).
- The \`internal_line_item\` should be a technical description suitable for internal documentation, including the PR number and key technical details.
- The \`raw_context_summary\` should describe what the PR actually accomplished and why, including notable discussion points or drift from the stated title.

## Tool Use

You have access to a \`get_file_diff\` tool. Use it to read specific file diffs when needed to understand the changes. Start with the files most relevant to understanding the PR's purpose. You do not need to read every file — focus on files with meaningful logic changes.

## Output Format

After using tools as needed, respond with ONLY a valid JSON object (no markdown fences, no preamble) matching this schema:

\`\`\`
{
  "raw_context_summary": "string",
  "classification": "tooling" | "internal" | "user-facing",
  "significance": "major" | "minor" | "patch",
  "internal_line_item": "string",
  "external_line_item": "string | null",
  "needs_review": boolean,
  "needs_review_reason": "string | null",
  "insufficient_context": boolean,
  "insufficient_context_reason": "string | null",
  "reverts_pr_number": number | null
}
\`\`\``;
}

function buildDirectCommitSystemPrompt(appContext: string): string {
  return buildStage1SystemPrompt(appContext).replace(
    "## Tool Use",
    `## Note
This is a **direct commit** — it was not associated with any pull request. You have no PR discussion, description, or review context available. Only the commit message and diff manifest are provided. Because of this limited context, you must set \`needs_review: true\` with an appropriate reason.

## Tool Use`,
  );
}

// ─── User message ─────────────────────────────────────────────────────────────

interface PRContext {
  pr: GithubPR;
  commits: GithubCommit[];
  comments: string[];
  reviewComments: string[];
  reviews: string[];
  manifest: FileManifestEntry[];
}

function buildPRUserMessage(ctx: PRContext): string {
  const sections: string[] = [];

  sections.push(`# PR #${ctx.pr.number}: ${ctx.pr.title}`);
  sections.push(`**Merged at**: ${ctx.pr.merged_at ?? "unknown"}`);

  if (ctx.pr.body?.trim()) {
    sections.push(`\n## PR Description\n\n${ctx.pr.body}`);
  } else {
    sections.push(`\n## PR Description\n\n*(no description provided)*`);
  }

  if (ctx.commits.length > 0) {
    const msgs = ctx.commits
      .map((c) => `- ${c.commit.message.split("\n")[0]}`)
      .join("\n");
    sections.push(`\n## Commit Messages\n\n${msgs}`);
  }

  if (ctx.comments.length > 0) {
    sections.push(`\n## PR Comments\n\n${ctx.comments.join("\n\n---\n\n")}`);
  }

  if (ctx.reviewComments.length > 0) {
    sections.push(
      `\n## Review Comments\n\n${ctx.reviewComments.join("\n\n---\n\n")}`,
    );
  }

  if (ctx.reviews.length > 0) {
    sections.push(`\n## Reviews\n\n${ctx.reviews.join("\n\n---\n\n")}`);
  }

  sections.push(`\n## Changed Files (Manifest)\n\n\`\`\`\n${renderManifest(ctx.manifest)}\n\`\`\``);
  sections.push(
    `\nUse the \`get_file_diff\` tool to read specific file diffs before producing your JSON summary.`,
  );

  return sections.join("\n");
}

interface DirectCommitContext {
  sha: string;
  commitMessage: string;
  manifest: FileManifestEntry[];
}

function buildDirectCommitUserMessage(ctx: DirectCommitContext): string {
  return [
    `# Direct Commit: ${ctx.sha.slice(0, 8)}`,
    `\n## Commit Message\n\n${ctx.commitMessage}`,
    `\n## Changed Files (Manifest)\n\n\`\`\`\n${renderManifest(ctx.manifest)}\n\`\`\``,
    `\nThis commit was not associated with any pull request. Use the \`get_file_diff\` tool to read specific file diffs before producing your JSON summary.`,
  ].join("\n");
}

// ─── Tool definition ──────────────────────────────────────────────────────────

import type { LlmToolDefinition } from "./types.ts";

export const GET_FILE_DIFF_TOOL: LlmToolDefinition = {
  type: "function",
  function: {
    name: "get_file_diff",
    description:
      "Get the diff for a specific file in the pull request. Returns the patch content for that file.",
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The filename path as shown in the manifest",
        },
      },
      required: ["filename"],
    },
  },
};

function makeToolExecutor(
  manifest: FileManifestEntry[],
  maxTokens: number,
): { execute: (name: string, args: Record<string, unknown>) => Promise<string>; tokensUsed: () => number } {
  let tokensUsed = 0;

  const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name !== "get_file_diff") {
      return `Unknown tool: ${name}`;
    }

    const filename = args["filename"] as string;
    if (!filename) return "Error: filename argument is required";

    const entry = manifest.find((e) => e.filename === filename);
    if (!entry) {
      return `File not found in manifest: ${filename}. Check the manifest for exact filenames.`;
    }

    if (entry.excluded) {
      return `File "${filename}" is excluded (${entry.excludeReason}) and has no diff available.`;
    }

    if (!entry.patch) {
      return `File "${filename}" has no diff content (it may be a binary file or empty).`;
    }

    const approxTokens = Math.ceil(entry.patch.length / CHARS_PER_TOKEN);

    if (tokensUsed + approxTokens > maxTokens) {
      return (
        `Token limit reached (${tokensUsed}/${maxTokens} tokens used). ` +
        `Cannot read more file diffs. Please produce your summary with the context you have.`
      );
    }

    tokensUsed += approxTokens;

    let result = `## Diff: ${filename}\n\n\`\`\`diff\n${entry.patch}\n\`\`\``;
    if (entry.truncated) {
      result +=
        `\n\n*(Showing first ${MAX_FILE_LINES} lines of ${entry.originalLines} total lines)*`;
    }
    return result;
  };

  return { execute, tokensUsed: () => tokensUsed };
};

// ─── JSON extraction ──────────────────────────────────────────────────────────

function extractJson(content: string): unknown {
  // Strip markdown code fences if present
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : content.trim();

  // Find first { and last }
  const start = jsonStr.indexOf("{");
  const end = jsonStr.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in model response: ${content.slice(0, 200)}`);
  }

  return JSON.parse(jsonStr.slice(start, end + 1));
}

// ─── Main processing functions ────────────────────────────────────────────────

export interface ProcessPRResult {
  summary: PrSummary;
  filePath: string;
}

export async function processPR(
  pr: GithubPR,
  config: Config,
  appContext: string,
  github: GitHubClient,
  llm: LlmClient,
  logger: Logger,
  verbose: boolean = false,
): Promise<ProcessPRResult> {
  if (verbose) console.log(`  Fetching data for PR #${pr.number}...`);

  const [files, commits, comments, reviewComments, reviews] = await Promise.all([
    github.getPRFiles(pr.number),
    github.getPRCommits(pr.number),
    github.getPRComments(pr.number),
    github.getPRReviewComments(pr.number),
    github.getPRReviews(pr.number),
  ]);

  const manifest = buildManifest(files, config.diff.excluded_file_patterns);
  const { execute: toolExecutor } = makeToolExecutor(manifest, config.diff.max_tokens_per_pr);

  const ctx: PRContext = {
    pr,
    commits,
    comments: comments
      .filter((c) => c.body.trim())
      .map((c) => `**${c.user?.login ?? "unknown"}**: ${c.body}`),
    reviewComments: reviewComments
      .filter((c) => c.body.trim())
      .map((c) => `**${c.user?.login ?? "unknown"}** (review comment): ${c.body}`),
    reviews: reviews
      .filter((r) => r.body?.trim())
      .map(
        (r) =>
          `**${r.user?.login ?? "unknown"}** (${r.state}): ${r.body}`,
      ),
    manifest,
  };

  const systemPrompt = buildStage1SystemPrompt(appContext);
  const userMessage = buildPRUserMessage(ctx);

  if (verbose) console.log(`  Calling LLM for PR #${pr.number}...`);

  const result = await llm.runLoop(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    [GET_FILE_DIFF_TOOL],
    {
      stage: 1,
      prNumber: pr.number,
      toolExecutor,
      logger,
    },
  );

  if (verbose) console.log(`  LLM finished PR #${pr.number} in ${result.turns} turns.`);

  let modelOutput: unknown;
  try {
    modelOutput = extractJson(result.content);
  } catch (err) {
    throw new Error(`Failed to parse model JSON for PR #${pr.number}: ${err}`);
  }

  const summary: PrSummary = {
    schema_version: CURRENT_PR_SCHEMA_VERSION,
    pr_number: pr.number,
    title: pr.title,
    merged_at: pr.merged_at ?? new Date().toISOString(),
    ...(modelOutput as object),
  } as PrSummary;

  const filePath = join(config.prs_dir, `${pr.number}.json`);
  await mkdir(config.prs_dir, { recursive: true });
  await Deno.writeTextFile(filePath, JSON.stringify(summary, null, 2) + "\n");

  return { summary, filePath };
}

export async function processDirectCommit(
  commit: GithubCommit,
  commitFiles: GithubPRFile[],
  config: Config,
  appContext: string,
  llm: LlmClient,
  logger: Logger,
  verbose: boolean = false,
): Promise<ProcessPRResult> {
  const sha = commit.sha;
  const shortSha = sha.slice(0, 8);

  if (verbose) console.log(`  Processing direct commit ${shortSha}...`);

  const manifest = buildManifest(commitFiles, config.diff.excluded_file_patterns);
  const { execute: toolExecutor } = makeToolExecutor(manifest, config.diff.max_tokens_per_pr);

  const ctx: DirectCommitContext = {
    sha,
    commitMessage: commit.commit.message,
    manifest,
  };

  const systemPrompt = buildDirectCommitSystemPrompt(appContext);
  const userMessage = buildDirectCommitUserMessage(ctx);

  const result = await llm.runLoop(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    [GET_FILE_DIFF_TOOL],
    {
      stage: 1,
      prNumber: shortSha,
      toolExecutor,
      logger,
    },
  );

  let modelOutput: unknown;
  try {
    modelOutput = extractJson(result.content);
  } catch (err) {
    throw new Error(`Failed to parse model JSON for commit ${shortSha}: ${err}`);
  }

  const partial = modelOutput as Partial<PrSummary>;

  const summary: PrSummary = {
    schema_version: CURRENT_PR_SCHEMA_VERSION,
    pr_number: null,
    title: `Direct commit: ${commit.commit.message.split("\n")[0].slice(0, 72)}`,
    merged_at: commit.commit.author?.date ?? new Date().toISOString(),
    raw_context_summary: partial.raw_context_summary ?? "",
    classification: partial.classification ?? "tooling",
    significance: partial.significance ?? "patch",
    internal_line_item: partial.internal_line_item ?? `Direct commit ${shortSha}`,
    external_line_item: partial.external_line_item ?? null,
    needs_review: true,
    needs_review_reason:
      partial.needs_review_reason ??
        "Direct commit with no associated PR. Limited context available. Manual review required.",
    insufficient_context: partial.insufficient_context ?? false,
    insufficient_context_reason: partial.insufficient_context_reason ?? null,
    reverts_pr_number: partial.reverts_pr_number ?? null,
  };

  const filePath = join(config.prs_dir, `${shortSha}.json`);
  await mkdir(config.prs_dir, { recursive: true });
  await Deno.writeTextFile(filePath, JSON.stringify(summary, null, 2) + "\n");

  return { summary, filePath };
}

/**
 * Discover and process all unprocessed PRs in the base..head diff.
 * Returns an array of summaries (existing + newly processed).
 */
export async function runStage1(
  config: Config,
  appContext: string,
  github: GitHubClient,
  llm: LlmClient,
  verbose: boolean = false,
): Promise<void> {
  if (verbose) console.log(`Fetching commits in ${config.base_branch}..${config.head_branch}...`);

  const commits = await github.getCommitsInRange(config.base_branch, config.head_branch);

  if (verbose) console.log(`Found ${commits.length} commits.`);

  // Filter out merge commits (2+ parents)
  const nonMergeCommits = commits.filter((c) => c.parents.length < 2);

  if (verbose) {
    console.log(
      `Skipping ${commits.length - nonMergeCommits.length} merge commits. Processing ${nonMergeCommits.length} commits.`,
    );
  }

  // Build a map of PR number -> PR (deduplicating)
  const prMap = new Map<number, GithubPR>();
  const directCommits: GithubCommit[] = [];

  for (const commit of nonMergeCommits) {
    const prs = await github.getCommitPRs(commit.sha);
    if (prs.length === 0) {
      directCommits.push(commit);
    } else {
      // Use the most recently merged PR
      const merged = prs.filter((p) => p.merged_at !== null);
      const pr = merged.length > 0 ? merged[merged.length - 1] : prs[prs.length - 1];
      prMap.set(pr.number, pr);
    }
  }

  if (verbose) {
    console.log(
      `Found ${prMap.size} unique PRs and ${directCommits.length} direct commits.`,
    );
  }

  // Determine which PRs already have JSON files
  const processedPRs = new Set<number | string>();
  try {
    for await (const entry of Deno.readDir(config.prs_dir)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        const name = entry.name.replace(/\.json$/, "");
        const num = parseInt(name, 10);
        processedPRs.add(isNaN(num) ? name : num);
      }
    }
  } catch {
    // Directory doesn't exist yet
  }

  // Process unprocessed PRs
  const unprocessedPRs = [...prMap.values()].filter((pr) => !processedPRs.has(pr.number));
  const unprocessedCommits = directCommits.filter((c) => !processedPRs.has(c.sha.slice(0, 8)));

  const total = unprocessedPRs.length + unprocessedCommits.length;
  let remaining = total;

  if (total === 0) {
    console.log("All PRs are already processed. Nothing to do.");
    return;
  }

  for (const pr of unprocessedPRs) {
    const logFileName = Logger.prLogFileName(pr.number);
    const logger = new Logger(config.logs_dir, logFileName);

    console.log(`Processing PR #${pr.number}... (${remaining} remaining)`);
    await processPR(pr, config, appContext, github, llm, logger, verbose);
    remaining--;
    console.log(`PR #${pr.number} done. (${remaining} remaining)`);
  }

  for (const commit of unprocessedCommits) {
    const shortSha = commit.sha.slice(0, 8);
    const logFileName = Logger.prLogFileName(shortSha);
    const logger = new Logger(config.logs_dir, logFileName);

    console.log(`Processing direct commit ${shortSha}... (${remaining} remaining)`);
    // For direct commits we don't have a separate PR files endpoint - use the compare endpoint per commit
    // We pass empty files since we don't have individual commit file access via compare
    // In practice, direct commit processing works with manifest only
    await processDirectCommit(commit, [], config, appContext, llm, logger, verbose);
    remaining--;
    console.log(`Commit ${shortSha} done. (${remaining} remaining)`);
  }
}
