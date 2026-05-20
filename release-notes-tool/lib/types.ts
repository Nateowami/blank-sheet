// Core TypeScript types for the release notes tool

export const CURRENT_PR_SCHEMA_VERSION = 1;
export const CURRENT_RELEASE_SCHEMA_VERSION = 1;

// ─── Configuration ────────────────────────────────────────────────────────────

export interface DiffConfig {
  max_tokens_per_pr: number;
  excluded_file_patterns: string[];
}

export interface Config {
  github_repo: string;
  base_branch: string;
  head_branch: string;
  app_context_path: string;
  prs_dir: string;
  releases_dir: string;
  logs_dir: string;
  diff: DiffConfig;
}

// ─── Per-PR Schema (Stage 1 output) ──────────────────────────────────────────

export type Classification = "tooling" | "internal" | "user-facing";
export type Significance = "major" | "minor" | "patch";
export type BumpType = "major" | "minor" | "patch";

export interface PrSummary {
  schema_version: number;
  pr_number: number | null;
  title: string;
  merged_at: string;
  raw_context_summary: string;
  classification: Classification;
  significance: Significance;
  internal_line_item: string;
  external_line_item: string | null;
  needs_review: boolean;
  needs_review_reason: string | null;
  insufficient_context: boolean;
  insufficient_context_reason: string | null;
  reverts_pr_number: number | null;
}

// ─── Release Schema (Stage 2 output) ─────────────────────────────────────────

export interface ReleaseChange {
  pr_numbers: number[];
  classification: Classification;
  significance: Significance;
  internal_line_item: string;
  external_line_item: string | null;
  needs_review: boolean;
  needs_review_reason: string | null;
}

export interface RevertedChange {
  pr_numbers: number[];
  note: string;
}

export interface NeedsReviewItem {
  pr_numbers: (number | string)[];
  reason: string;
}

export interface ReleaseNotes {
  schema_version: number;
  generated_at: string;
  base_ref: string;
  head_ref: string;
  version: string;
  previous_version: string;
  bump_type: BumpType;
  bump_override: boolean;
  changes: ReleaseChange[];
  reverted_changes: RevertedChange[];
  needs_review: NeedsReviewItem[];
}

// ─── GitHub API types ─────────────────────────────────────────────────────────

export interface GithubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  parents: Array<{ sha: string }>;
}

export interface GithubPR {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  state: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

export interface GithubPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GithubComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
}

export interface GithubReview {
  id: number;
  body: string | null;
  state: string;
  user: { login: string } | null;
  submitted_at: string | null;
}

export interface GithubTag {
  name: string;
  commit: { sha: string };
}

// ─── LLM API types ────────────────────────────────────────────────────────────

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmResponseUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface LlmResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: LlmToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: LlmResponseUsage;
  model?: string;
}

// ─── Audit log types ──────────────────────────────────────────────────────────

export interface AuditLogEntry {
  timestamp: string;
  stage: 1 | 2;
  pr_number: number | string | null;
  model: string;
  base_url: string;
  turn: number;
  messages_sent: LlmMessage[];
  tool_calls: LlmToolCall[];
  response_received: LlmResponse | { error: unknown };
  tokens_used: {
    input: number;
    output: number;
  };
  duration_ms: number;
}
