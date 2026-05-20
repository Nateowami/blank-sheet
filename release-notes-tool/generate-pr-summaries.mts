#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
// Stage 1 entry point: process unprocessed PRs in the base..head diff

import { loadConfig, resolveRelativePath } from "./lib/config.ts";
import { GitHubClient } from "./lib/github.ts";
import { LlmClient } from "./lib/llm.ts";
import { runStage1 } from "./lib/stage1.ts";

const CONFIG_PATH = new URL("./config.json", import.meta.url).pathname;

async function main() {
  const args = Deno.args;
  const verbose = args.includes("--verbose");

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

  try {
    await runStage1(config, appContext, github, llm, verbose);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}

await main();
