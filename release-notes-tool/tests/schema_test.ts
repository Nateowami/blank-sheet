// Tests for schema validation

import { assertEquals, assertThrows } from "./test_utils.ts";
import { validatePrSummary, SchemaValidationError } from "../lib/schema.ts";
import { CURRENT_PR_SCHEMA_VERSION } from "../lib/types.ts";

const validSummary = {
  schema_version: CURRENT_PR_SCHEMA_VERSION,
  pr_number: 312,
  title: "Add CSV export",
  merged_at: "2026-05-10T14:22:00Z",
  raw_context_summary: "Adds CSV export to the report service.",
  classification: "user-facing",
  significance: "minor",
  internal_line_item: "PR #312 — added CSV export endpoint and download button",
  external_line_item: "Users can now export reports as CSV",
  needs_review: false,
  needs_review_reason: null,
  insufficient_context: false,
  insufficient_context_reason: null,
  reverts_pr_number: null,
};

Deno.test("validatePrSummary - valid summary passes", () => {
  const result = validatePrSummary("test.json", validSummary);
  assertEquals(result.pr_number, 312);
  assertEquals(result.classification, "user-facing");
});

Deno.test("validatePrSummary - null pr_number is valid (direct commit)", () => {
  const summary = { ...validSummary, pr_number: null };
  const result = validatePrSummary("test.json", summary);
  assertEquals(result.pr_number, null);
});

Deno.test("validatePrSummary - wrong schema version throws", () => {
  const summary = { ...validSummary, schema_version: 999 };
  assertThrows(
    () => validatePrSummary("prs/312.json", summary),
    SchemaValidationError,
    "schema v999",
  );
});

Deno.test("validatePrSummary - missing field throws with file path", () => {
  const { classification: _, ...summary } = validSummary;
  assertThrows(
    () => validatePrSummary("prs/312.json", summary),
    SchemaValidationError,
    "prs/312.json",
  );
});

Deno.test("validatePrSummary - invalid classification throws", () => {
  const summary = { ...validSummary, classification: "unknown" };
  assertThrows(
    () => validatePrSummary("test.json", summary),
    SchemaValidationError,
    "classification",
  );
});

Deno.test("validatePrSummary - invalid significance throws", () => {
  const summary = { ...validSummary, significance: "huge" };
  assertThrows(
    () => validatePrSummary("test.json", summary),
    SchemaValidationError,
    "significance",
  );
});

Deno.test("validatePrSummary - non-object input throws", () => {
  assertThrows(() => validatePrSummary("test.json", "not an object"), SchemaValidationError);
  assertThrows(() => validatePrSummary("test.json", null), SchemaValidationError);
  assertThrows(() => validatePrSummary("test.json", []), SchemaValidationError);
});

Deno.test("validatePrSummary - wrong type for boolean field throws", () => {
  const summary = { ...validSummary, needs_review: "yes" };
  assertThrows(
    () => validatePrSummary("test.json", summary),
    SchemaValidationError,
    "needs_review",
  );
});

Deno.test("validatePrSummary - null external_line_item is valid for tooling", () => {
  const summary = {
    ...validSummary,
    classification: "tooling",
    external_line_item: null,
  };
  const result = validatePrSummary("test.json", summary);
  assertEquals(result.external_line_item, null);
});
