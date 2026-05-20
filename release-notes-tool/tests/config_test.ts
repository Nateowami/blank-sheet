// Tests for config loading

import { assertEquals, assertRejects } from "./test_utils.ts";
import { DEFAULT_CONFIG, resolveRelativePath } from "../lib/config.ts";

Deno.test("DEFAULT_CONFIG - has expected defaults", () => {
  assertEquals(DEFAULT_CONFIG.base_branch, "sf-live");
  assertEquals(DEFAULT_CONFIG.head_branch, "sf-qa");
  assertEquals(DEFAULT_CONFIG.app_context_path, "./app-context.md");
  assertEquals(DEFAULT_CONFIG.prs_dir, "./prs");
  assertEquals(DEFAULT_CONFIG.releases_dir, "./releases");
  assertEquals(DEFAULT_CONFIG.logs_dir, "./logs");
  assertEquals(DEFAULT_CONFIG.diff.max_tokens_per_pr, 50000);
  assertEquals(Array.isArray(DEFAULT_CONFIG.diff.excluded_file_patterns), true);
  assertEquals(DEFAULT_CONFIG.diff.excluded_file_patterns.includes("package-lock.json"), true);
  assertEquals(DEFAULT_CONFIG.diff.excluded_file_patterns.includes("yarn.lock"), true);
});

Deno.test("resolveRelativePath - relative path is resolved against config dir", () => {
  const result = resolveRelativePath("/some/dir/config.json", "./app-context.md");
  assertEquals(result, "/some/dir/app-context.md");
});

Deno.test("resolveRelativePath - absolute path is returned as-is", () => {
  const result = resolveRelativePath("/some/dir/config.json", "/absolute/path/app-context.md");
  assertEquals(result, "/absolute/path/app-context.md");
});

Deno.test("resolveRelativePath - config path without directory separator", () => {
  const result = resolveRelativePath("config.json", "./app-context.md");
  assertEquals(result, "app-context.md");
});
