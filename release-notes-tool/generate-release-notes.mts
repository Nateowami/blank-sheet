#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
// Stage 2 entry point: generate release notes (runs Stage 1 first if needed)

import { loadConfig, resolveRelativePath } from "./lib/config.ts";
import { GitHubClient } from "./lib/github.ts";
import { LlmClient } from "./lib/llm.ts";
import { Logger } from "./lib/logger.ts";
import { runStage1 } from "./lib/stage1.ts";
import { runStage2 } from "./lib/stage2.ts";
import { resolveCurrentVersion } from "./lib/version.ts";
import { generateMarkdown } from "./lib/markdown.ts";
import type { BumpType } from "./lib/types.ts";

const CONFIG_PATH = new URL("./config.json", import.meta.url).pathname;

function parseBumpFlag(args: string[]): BumpType | undefined {
  const bumpArg = args.find((a) => a.startsWith("--bump="));
  if (!bumpArg) return undefined;
  const value = bumpArg.split("=")[1];
  if (value === "major" || value === "minor" || value === "patch") return value;
  console.error(`Error: invalid --bump value "${value}". Must be major, minor, or patch.`);
  Deno.exit(1);
}

async function main() {
  const args = Deno.args;
  const verbose = args.includes("--verbose");
  const bumpOverride = parseBumpFlag(args);

  let loaded;
  try {
    loaded = await loadConfig(CONFIG_PATH);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }

  const { config, llmApiKey, llmBaseUrl, llmModel, githubToken } = loaded;

  // Load app context
  let appContext = "";
  const appContextPath = resolveRelativePath(CONFIG_PATH, config.app_context_path);
  try {
    appContext = await Deno.readTextFile(appContextPath);
  } catch {
    // Warning already printed by loadConfig
  }

  const github = new GitHubClient(config.github_repo, githubToken);
  const llm = new LlmClient({ baseUrl: llmBaseUrl, model: llmModel, apiKey: llmApiKey });

  // Stage 1: process any unprocessed PRs
  try {
    await runStage1(config, appContext, github, llm, verbose);
  } catch (err) {
    console.error(`Stage 1 error: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }

  // Resolve current version
  let currentVersion: string | null = null;
  try {
    currentVersion = await resolveCurrentVersion(github, config.base_branch);
    if (currentVersion) {
      console.log(`Current version: ${currentVersion}`);
    } else {
      console.error(
        `Warning: No version tag matching SFv\\d+.\\d+.\\d+ found on ${config.base_branch}. Using SFv0.0.0 as base.`,
      );
    }
  } catch (err) {
    console.error(`Warning: Failed to resolve current version: ${err}. Using SFv0.0.0 as base.`);
  }

  // Stage 2: generate release notes
  const timestamp = Logger.formatTimestamp();
  const releaseLogFileName = Logger.releaseLogFileName("pending", timestamp);
  const releaseLogger = new Logger(config.logs_dir, releaseLogFileName);

  let result;
  try {
    result = await runStage2({
      config,
      appContext,
      llm,
      logger: releaseLogger,
      currentVersion,
      bumpOverride,
      verbose,
    });
  } catch (err) {
    console.error(`Stage 2 error: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }

  const { releaseNotes, jsonPath, mdPath } = result;

  // Generate and write markdown
  const markdown = generateMarkdown(releaseNotes);
  await Deno.writeTextFile(mdPath, markdown);

  console.log(`\nRelease notes generated:`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  Markdown: ${mdPath}`);

  if (releaseNotes.needs_review.length > 0) {
    console.log(
      `\n⚠️  ${releaseNotes.needs_review.length} item(s) require manual review before publishing.`,
    );
  }
}

await main();
