// Tests for markdown generation

import { assertEquals, assertStringIncludes } from "./test_utils.ts";
import { generateMarkdown } from "../lib/markdown.ts";
import type { ReleaseNotes } from "../lib/types.ts";

const sampleReleaseNotes: ReleaseNotes = {
  schema_version: 1,
  generated_at: "2026-05-20T10:32:00Z",
  base_ref: "sf-live",
  head_ref: "sf-qa",
  version: "SFv5.57.0",
  previous_version: "SFv5.56.0",
  bump_type: "minor",
  bump_override: false,
  changes: [
    {
      pr_numbers: [312],
      classification: "user-facing",
      significance: "minor",
      internal_line_item: "PR #312 — added CSV export endpoint and download button",
      external_line_item: "Users can now export reports as CSV",
      needs_review: false,
      needs_review_reason: null,
    },
    {
      pr_numbers: [318, 322, 331],
      classification: "user-facing",
      significance: "patch",
      internal_line_item: "PRs #318, #322, #331 — various UI alignment fixes",
      external_line_item: "Various minor UI fixes",
      needs_review: false,
      needs_review_reason: null,
    },
    {
      pr_numbers: [314],
      classification: "internal",
      significance: "minor",
      internal_line_item: "PR #314 — updated serval admin dashboard",
      external_line_item: null,
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
  reverted_changes: [
    {
      pr_numbers: [309, 316],
      note: "PR #309 introduced a new billing flow. PR #316 reverted it.",
    },
  ],
  needs_review: [
    {
      pr_numbers: [320],
      reason: "Direct commit with no associated PR. Limited context available.",
    },
  ],
};

Deno.test("generateMarkdown - includes version in title", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  assertStringIncludes(md, "# Release Notes — SFv5.57.0");
});

Deno.test("generateMarkdown - includes branch info", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  assertStringIncludes(md, "sf-live → sf-qa");
});

Deno.test("generateMarkdown - includes public-facing section", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  assertStringIncludes(md, "## Public-Facing Changes");
  assertStringIncludes(md, "Users can now export reports as CSV");
  assertStringIncludes(md, "Various minor UI fixes");
});

Deno.test("generateMarkdown - public-facing section sorts minor before patch", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  const csvIndex = md.indexOf("export reports as CSV");
  const uiIndex = md.indexOf("Various minor UI fixes");
  // CSV (minor) should come before UI fixes (patch)
  assertEquals(csvIndex < uiIndex, true);
});

Deno.test("generateMarkdown - internal section uses internal_line_item", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  assertStringIncludes(md, "## Internal Changes");
  assertStringIncludes(md, "updated serval admin dashboard");
});

Deno.test("generateMarkdown - tooling section", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  assertStringIncludes(md, "## Tooling");
  assertStringIncludes(md, "migrated CI pipeline to GitHub Actions");
});

Deno.test("generateMarkdown - needs review section with emoji", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  assertStringIncludes(md, "⚠️");
  assertStringIncludes(md, "Direct commit with no associated PR");
});

Deno.test("generateMarkdown - reverted section with emoji", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  assertStringIncludes(md, "↩️");
  assertStringIncludes(md, "PR #309 introduced a new billing flow");
});

Deno.test("generateMarkdown - external_line_item null skips item from public section", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  // Internal items should not appear in Public-Facing Changes
  const publicStart = md.indexOf("## Public-Facing Changes");
  const internalStart = md.indexOf("## Internal Changes");
  const adminText = "updated serval admin dashboard";
  const adminIndex = md.indexOf(adminText);
  // The admin text should be in Internal, not Public-Facing
  assertEquals(adminIndex > internalStart, true);
});

Deno.test("generateMarkdown - empty reverted_changes hides section", () => {
  const notes = { ...sampleReleaseNotes, reverted_changes: [] };
  const md = generateMarkdown(notes);
  assertEquals(md.includes("↩️"), false);
  assertEquals(md.includes("Reverted"), false);
});

Deno.test("generateMarkdown - empty needs_review hides section", () => {
  const notes = { ...sampleReleaseNotes, needs_review: [] };
  const md = generateMarkdown(notes);
  assertEquals(md.includes("⚠️"), false);
  assertEquals(md.includes("Needs Review"), false);
});

Deno.test("generateMarkdown - date is formatted correctly", () => {
  const md = generateMarkdown(sampleReleaseNotes);
  assertStringIncludes(md, "2026-05-20");
  // Should not include full ISO timestamp in the header line
  assertEquals(md.includes("10:32:00"), false);
});
