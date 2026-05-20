// Schema validation for PrSummary and ReleaseNotes

import type {
  Classification,
  PrSummary,
  ReleaseChange,
  ReleaseNotes,
  RevertedChange,
  Significance,
  NeedsReviewItem,
} from "./types.ts";
import { CURRENT_PR_SCHEMA_VERSION, CURRENT_RELEASE_SCHEMA_VERSION } from "./types.ts";

export class SchemaValidationError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(`Schema validation error in ${filePath}: ${message}`);
    this.name = "SchemaValidationError";
  }
}

const VALID_CLASSIFICATIONS: Classification[] = ["tooling", "internal", "user-facing"];
const VALID_SIGNIFICANCES: Significance[] = ["major", "minor", "patch"];

function assertField(
  filePath: string,
  obj: Record<string, unknown>,
  field: string,
  type: string,
  nullable = false,
): void {
  const value = obj[field];
  if (nullable && (value === null || value === undefined)) return;
  if (value === undefined) {
    throw new SchemaValidationError(filePath, `missing required field "${field}"`);
  }
  if (type === "number" && typeof value !== "number") {
    throw new SchemaValidationError(filePath, `field "${field}" must be a number, got ${typeof value}`);
  }
  if (type === "string" && typeof value !== "string") {
    throw new SchemaValidationError(filePath, `field "${field}" must be a string, got ${typeof value}`);
  }
  if (type === "boolean" && typeof value !== "boolean") {
    throw new SchemaValidationError(filePath, `field "${field}" must be a boolean, got ${typeof value}`);
  }
}

function assertNullableField(
  filePath: string,
  obj: Record<string, unknown>,
  field: string,
  type: string,
): void {
  const value = obj[field];
  if (!(field in obj)) {
    throw new SchemaValidationError(filePath, `missing required field "${field}"`);
  }
  if (value !== null && typeof value !== type) {
    throw new SchemaValidationError(
      filePath,
      `field "${field}" must be ${type} or null, got ${typeof value}`,
    );
  }
}

/**
 * Validate a raw parsed JSON object as a PrSummary.
 * Throws SchemaValidationError on any issue.
 */
export function validatePrSummary(filePath: string, raw: unknown): PrSummary {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SchemaValidationError(filePath, "expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  assertField(filePath, obj, "schema_version", "number");
  const schemaVersion = obj["schema_version"] as number;
  if (schemaVersion !== CURRENT_PR_SCHEMA_VERSION) {
    throw new SchemaValidationError(
      filePath,
      `was generated with schema v${schemaVersion}, current schema is v${CURRENT_PR_SCHEMA_VERSION}.\n` +
        `Delete the file and re-run generate-pr-summaries to regenerate it.`,
    );
  }

  // pr_number can be number or null
  if (!("pr_number" in obj)) {
    throw new SchemaValidationError(filePath, `missing required field "pr_number"`);
  }
  if (obj["pr_number"] !== null && typeof obj["pr_number"] !== "number") {
    throw new SchemaValidationError(filePath, `field "pr_number" must be a number or null`);
  }

  assertField(filePath, obj, "title", "string");
  assertField(filePath, obj, "merged_at", "string");
  assertField(filePath, obj, "raw_context_summary", "string");

  assertField(filePath, obj, "classification", "string");
  if (!VALID_CLASSIFICATIONS.includes(obj["classification"] as Classification)) {
    throw new SchemaValidationError(
      filePath,
      `field "classification" must be one of: ${VALID_CLASSIFICATIONS.join(", ")}`,
    );
  }

  assertField(filePath, obj, "significance", "string");
  if (!VALID_SIGNIFICANCES.includes(obj["significance"] as Significance)) {
    throw new SchemaValidationError(
      filePath,
      `field "significance" must be one of: ${VALID_SIGNIFICANCES.join(", ")}`,
    );
  }

  assertField(filePath, obj, "internal_line_item", "string");
  assertNullableField(filePath, obj, "external_line_item", "string");
  assertField(filePath, obj, "needs_review", "boolean");
  assertNullableField(filePath, obj, "needs_review_reason", "string");
  assertField(filePath, obj, "insufficient_context", "boolean");
  assertNullableField(filePath, obj, "insufficient_context_reason", "string");
  assertNullableField(filePath, obj, "reverts_pr_number", "number");

  return raw as PrSummary;
}

/**
 * Validate a raw parsed JSON object as a ReleaseNotes document.
 */
export function validateReleaseNotes(filePath: string, raw: unknown): ReleaseNotes {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SchemaValidationError(filePath, "expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  assertField(filePath, obj, "schema_version", "number");
  const schemaVersion = obj["schema_version"] as number;
  if (schemaVersion !== CURRENT_RELEASE_SCHEMA_VERSION) {
    throw new SchemaValidationError(
      filePath,
      `schema version mismatch: expected ${CURRENT_RELEASE_SCHEMA_VERSION}, got ${schemaVersion}`,
    );
  }

  assertField(filePath, obj, "generated_at", "string");
  assertField(filePath, obj, "base_ref", "string");
  assertField(filePath, obj, "head_ref", "string");
  assertField(filePath, obj, "version", "string");
  assertField(filePath, obj, "previous_version", "string");
  assertField(filePath, obj, "bump_type", "string");
  assertField(filePath, obj, "bump_override", "boolean");

  if (!Array.isArray(obj["changes"])) {
    throw new SchemaValidationError(filePath, `field "changes" must be an array`);
  }
  if (!Array.isArray(obj["reverted_changes"])) {
    throw new SchemaValidationError(filePath, `field "reverted_changes" must be an array`);
  }
  if (!Array.isArray(obj["needs_review"])) {
    throw new SchemaValidationError(filePath, `field "needs_review" must be an array`);
  }

  const changes = (obj["changes"] as unknown[]).map((c, i) =>
    validateReleaseChange(`${filePath}#changes[${i}]`, c)
  );
  const reverted_changes = (obj["reverted_changes"] as unknown[]).map((r, i) =>
    validateRevertedChange(`${filePath}#reverted_changes[${i}]`, r)
  );
  const needs_review = (obj["needs_review"] as unknown[]).map((n, i) =>
    validateNeedsReviewItem(`${filePath}#needs_review[${i}]`, n)
  );

  return {
    ...(raw as ReleaseNotes),
    changes,
    reverted_changes,
    needs_review,
  };
}

function validateReleaseChange(path: string, raw: unknown): ReleaseChange {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SchemaValidationError(path, "expected an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj["pr_numbers"])) {
    throw new SchemaValidationError(path, `field "pr_numbers" must be an array`);
  }
  assertField(path, obj, "classification", "string");
  assertField(path, obj, "significance", "string");
  assertField(path, obj, "internal_line_item", "string");
  assertNullableField(path, obj, "external_line_item", "string");
  assertField(path, obj, "needs_review", "boolean");
  assertNullableField(path, obj, "needs_review_reason", "string");
  return raw as ReleaseChange;
}

function validateRevertedChange(path: string, raw: unknown): RevertedChange {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SchemaValidationError(path, "expected an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj["pr_numbers"])) {
    throw new SchemaValidationError(path, `field "pr_numbers" must be an array`);
  }
  assertField(path, obj, "note", "string");
  return raw as RevertedChange;
}

function validateNeedsReviewItem(path: string, raw: unknown): NeedsReviewItem {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SchemaValidationError(path, "expected an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj["pr_numbers"])) {
    throw new SchemaValidationError(path, `field "pr_numbers" must be an array`);
  }
  assertField(path, obj, "reason", "string");
  return raw as NeedsReviewItem;
}
