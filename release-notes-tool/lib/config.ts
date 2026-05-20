// Configuration loading from config.json and environment variables

import type { Config } from "./types.ts";
import { join } from "node:path";

export const DEFAULT_CONFIG: Omit<Config, "github_repo"> = {
  base_branch: "sf-live",
  head_branch: "sf-qa",
  app_context_path: "./app-context.md",
  prs_dir: "./prs",
  releases_dir: "./releases",
  logs_dir: "./logs",
  diff: {
    max_tokens_per_pr: 50000,
    excluded_file_patterns: [
      "package-lock.json",
      "yarn.lock",
      "*.lock",
      "*.min.js",
      "*.min.css",
      "dist/**",
      "build/**",
      "*.generated.*",
      "migrations/**",
    ],
  },
};

export interface LoadedConfig {
  config: Config;
  /** Environment-derived secrets */
  llmApiKey: string | undefined;
  llmBaseUrl: string;
  llmModel: string;
  githubToken: string | undefined;
}

/**
 * Load configuration from a config.json file path and environment variables.
 * Throws on missing required fields.
 * Prints startup warnings to stderr for optional-but-recommended vars.
 */
export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  let fileJson: Record<string, unknown> = {};
  try {
    const text = await Deno.readTextFile(configPath);
    fileJson = JSON.parse(text);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Config file not found — rely entirely on defaults and env
    } else {
      throw new Error(`Failed to read config file at ${configPath}: ${err}`);
    }
  }

  const merged: Config = {
    github_repo: (fileJson["github_repo"] as string | undefined) ?? "",
    base_branch: (fileJson["base_branch"] as string | undefined) ?? DEFAULT_CONFIG.base_branch,
    head_branch: (fileJson["head_branch"] as string | undefined) ?? DEFAULT_CONFIG.head_branch,
    app_context_path:
      (fileJson["app_context_path"] as string | undefined) ?? DEFAULT_CONFIG.app_context_path,
    prs_dir: (fileJson["prs_dir"] as string | undefined) ?? DEFAULT_CONFIG.prs_dir,
    releases_dir: (fileJson["releases_dir"] as string | undefined) ?? DEFAULT_CONFIG.releases_dir,
    logs_dir: (fileJson["logs_dir"] as string | undefined) ?? DEFAULT_CONFIG.logs_dir,
    diff: {
      max_tokens_per_pr:
        ((fileJson["diff"] as Record<string, unknown> | undefined)?.[
          "max_tokens_per_pr"
        ] as number | undefined) ?? DEFAULT_CONFIG.diff.max_tokens_per_pr,
      excluded_file_patterns:
        ((fileJson["diff"] as Record<string, unknown> | undefined)?.[
          "excluded_file_patterns"
        ] as string[] | undefined) ?? DEFAULT_CONFIG.diff.excluded_file_patterns,
    },
  };

  const llmApiKey = Deno.env.get("LLM_API_KEY");
  const llmBaseUrl = Deno.env.get("LLM_BASE_URL") ?? "";
  const llmModel = Deno.env.get("LLM_MODEL") ?? "";
  const githubToken = Deno.env.get("GITHUB_TOKEN");

  // Validate required fields
  const missing: string[] = [];
  if (!merged.github_repo) missing.push("github_repo (in config.json)");
  if (!llmBaseUrl) missing.push("LLM_BASE_URL (environment variable)");
  if (!llmModel) missing.push("LLM_MODEL (environment variable)");

  if (missing.length > 0) {
    throw new Error(`Missing required configuration:\n  - ${missing.join("\n  - ")}`);
  }

  // Startup warnings to stderr
  if (!githubToken) {
    console.error(
      "Warning: GITHUB_TOKEN is not set. GitHub will rate-limit unauthenticated requests to 60/hr.",
    );
  }
  if (!llmApiKey) {
    console.error(
      "Warning: LLM_API_KEY is not set. API calls will be made without authentication.",
    );
  }

  // Warn about missing app-context.md
  const appContextPath = resolveRelativePath(configPath, merged.app_context_path);
  try {
    await Deno.stat(appContextPath);
  } catch {
    console.error(
      `Warning: app-context.md not found at ${appContextPath}. The model will have no application context. ` +
        `Please create it to improve classification accuracy.`,
    );
  }

  return { config: merged, llmApiKey, llmBaseUrl, llmModel, githubToken };
}

/**
 * Resolve a path that may be relative (to the config file's directory) or absolute.
 */
export function resolveRelativePath(configPath: string, targetPath: string): string {
  if (targetPath.startsWith("/")) return targetPath;
  const configDir = configPath.includes("/")
    ? configPath.substring(0, configPath.lastIndexOf("/"))
    : ".";
  return join(configDir, targetPath);
}
