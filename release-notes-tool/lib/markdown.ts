// Markdown generation from ReleaseNotes JSON

import type { ReleaseChange, ReleaseNotes } from "./types.ts";

function formatDate(isoString: string): string {
  return isoString.slice(0, 10); // YYYY-MM-DD
}

function prRef(prNumbers: (number | string)[]): string {
  if (prNumbers.length === 1) return `PR #${prNumbers[0]}`;
  return `PRs ${prNumbers.map((n) => `#${n}`).join(", ")}`;
}

function renderSection(
  title: string,
  items: string[],
  emoji?: string,
): string {
  if (items.length === 0) return "";
  const heading = emoji ? `## ${emoji} ${title}` : `## ${title}`;
  return `${heading}\n\n${items.map((i) => `- ${i}`).join("\n")}\n`;
}

/**
 * Generate a Markdown release notes document from a ReleaseNotes JSON object.
 */
export function generateMarkdown(notes: ReleaseNotes): string {
  const sections: string[] = [];

  sections.push(`# Release Notes — ${notes.version}`);
  sections.push(
    `Generated: ${formatDate(notes.generated_at)} | ${notes.base_ref} → ${notes.head_ref}`,
  );
  sections.push("---");

  // Sort changes by significance
  const significanceOrder: Record<string, number> = { major: 0, minor: 1, patch: 2 };
  const sortedChanges = [...notes.changes].sort(
    (a, b) =>
      (significanceOrder[a.significance] ?? 3) - (significanceOrder[b.significance] ?? 3),
  );

  // Public-Facing Changes
  const userFacing = sortedChanges.filter(
    (c) => c.classification === "user-facing" && c.external_line_item,
  );
  if (userFacing.length > 0) {
    const items = userFacing.map((c) => c.external_line_item!);
    sections.push(renderSection("Public-Facing Changes", items));
  }

  // Internal Changes
  const internal = sortedChanges.filter((c) => c.classification === "internal");
  if (internal.length > 0) {
    const items = internal.map((c) => c.internal_line_item);
    sections.push(renderSection("Internal Changes", items));
  }

  // Tooling
  const tooling = sortedChanges.filter((c) => c.classification === "tooling");
  if (tooling.length > 0) {
    const items = tooling.map((c) => c.internal_line_item);
    sections.push(renderSection("Tooling", items));
  }

  // Needs Review
  if (notes.needs_review.length > 0) {
    const items = notes.needs_review.map((nr) => {
      const ref = prRef(nr.pr_numbers);
      return `${ref} — ${nr.reason}`;
    });
    sections.push(renderSection("Needs Review", items, "⚠️"));
  }

  // Reverted Changes
  if (notes.reverted_changes.length > 0) {
    const items = notes.reverted_changes.map((r) => {
      return `${prRef(r.pr_numbers)} — ${r.note}`;
    });
    sections.push(renderSection("Reverted (not externally visible)", items, "↩️"));
  }

  return sections.join("\n\n") + "\n";
}
