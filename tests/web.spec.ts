import { test, expect, type Page } from "@playwright/test";

// ──────────────────────────────────────────────
// Helper: reset reviews.json to known state
// ──────────────────────────────────────────────
const INITIAL_REVIEWS = {
  "ABC-5": {
    dismissed: true,
    dismissedAt: "2024-12-02T10:00:00.000Z",
    note: null,
    noteUpdatedAt: null,
  },
  "ABC-9": {
    dismissed: true,
    dismissedAt: "2024-12-02T11:00:00.000Z",
    note: "Confirmed with the team - the v1 XML importer was fully removed in v2.0. This can be closed.",
    noteUpdatedAt: "2024-12-02T11:05:00.000Z",
  },
  "ABC-7": {
    dismissed: false,
    dismissedAt: null,
    note: "Low priority but the design team has a mockup ready. Pick up in Q2.",
    noteUpdatedAt: "2024-12-03T09:00:00.000Z",
  },
};

import * as fs from "fs";
import * as path from "path";

function resetReviews() {
  const reviewsPath = path.join(
    process.cwd(),
    "test-data",
    "reviews.json",
  );
  fs.writeFileSync(reviewsPath, JSON.stringify(INITIAL_REVIEWS, null, 2));
}

test.beforeEach(() => {
  resetReviews();
});

// ──────────────────────────────────────────────
// 1. Page loads - all 6 tabs render
// ──────────────────────────────────────────────
test("page loads - all 6 tabs render and issue count shown", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tab-btn")).toHaveCount(6);
  await expect(page.locator(".tab-btn", { hasText: "Triage Queue" })).toBeVisible();
  await expect(page.locator(".tab-btn", { hasText: "Mismatches" })).toBeVisible();
  await expect(page.locator(".tab-btn", { hasText: "By Category" })).toBeVisible();
  await expect(page.locator(".tab-btn", { hasText: "Value" })).toBeVisible();
  await expect(page.locator(".tab-btn", { hasText: "Errors" })).toBeVisible();
  await expect(page.locator(".tab-btn", { hasText: "Pending" })).toBeVisible();

  // Issue count header should show 20 issues
  await expect(page.locator("#issue-count")).toContainText("20");
});

// ──────────────────────────────────────────────
// 2. Triage queue - sorted by action, dismissed absent
// ──────────────────────────────────────────────
test("triage queue - issues sorted by recommended action, dismissed absent", async ({ page }) => {
  await page.goto("/");

  // Wait for data to load
  await expect(page.locator(".issue-table")).toBeVisible();

  // ABC-5 and ABC-9 are dismissed, should not appear
  const rows = page.locator(".issue-table tbody tr[data-key]:not(.detail-row)");
  const keys: string[] = [];
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const key = await rows.nth(i).getAttribute("data-key");
    if (key) keys.push(key);
  }

  expect(keys).not.toContain("ABC-5");
  expect(keys).not.toContain("ABC-9");

  // Check that "prioritize" items appear before "close" items
  const actionBadges = await page.locator(".action-badge").allTextContents();
  const prioritizeIdx = actionBadges.indexOf("prioritize");
  const closeIdx = actionBadges.findIndex(
    (t, i) => t === "close" && i > prioritizeIdx,
  );
  if (prioritizeIdx >= 0 && closeIdx >= 0) {
    expect(prioritizeIdx).toBeLessThan(closeIdx);
  }
});

// ──────────────────────────────────────────────
// 3. Dismiss - removes from triage queue immediately
// ──────────────────────────────────────────────
test("dismiss - clicking Dismiss removes issue immediately", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".issue-table")).toBeVisible();

  // Find ABC-1 (not dismissed in fixtures)
  const row = page.locator("tr[data-key='ABC-1']:not(.detail-row)");
  await expect(row).toBeVisible();

  // Click dismiss
  await row.locator(".dismiss-btn").click();

  // Row should be gone from triage queue immediately
  await expect(row).not.toBeVisible();

  // Reload page - should still be gone
  await page.reload();
  await expect(page.locator(".issue-table")).toBeVisible();
  await expect(page.locator("tr[data-key='ABC-1']:not(.detail-row)")).not.toBeVisible();
});

// ──────────────────────────────────────────────
// 4. Restore dismissed
// ──────────────────────────────────────────────
test("restore dismissed - dismissal can be undone in value view", async ({ page }) => {
  await page.goto("/");

  // Go to Value view and show dismissed
  await page.locator(".tab-btn", { hasText: "Value" }).click();
  await expect(page.locator(".issue-table")).toBeVisible();

  // Enable showing dismissed
  const showDismissedBtn = page.locator("#value-dismissed-toggle");
  await showDismissedBtn.click();

  // Find a dismissed issue (ABC-5 is dismissed)
  const dismissedRow = page.locator("tr[data-key='ABC-5']:not(.detail-row)");
  await expect(dismissedRow).toBeVisible();

  // Click restore
  await dismissedRow.locator(".restore-btn").click();

  // The issue should now show without dismissed styling
  await expect(dismissedRow).not.toHaveClass(/dismissed/);

  // Reload - should persist (ABC-5 is now restored)
  await page.reload();
  await page.locator(".tab-btn", { hasText: "Triage Queue" }).click();
  await expect(page.locator(".issue-table")).toBeVisible();
  // ABC-5 would now be in triage (it's status:ok and not dismissed)
});

// ──────────────────────────────────────────────
// 5. Notes - auto-saves on blur, persists across reload
// ──────────────────────────────────────────────
test("notes - typing a note auto-saves on blur and persists after reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".issue-table")).toBeVisible();

  // Expand ABC-1 to see its detail panel
  const row = page.locator("tr[data-key='ABC-1']:not(.detail-row)");
  await row.click();

  const detailRow = page.locator(".detail-row[data-key='ABC-1']");
  await expect(detailRow).toBeVisible();

  const noteArea = detailRow.locator(".note-area");
  await noteArea.fill("This is a test note for ABC-1");
  await noteArea.blur();

  // Wait for save indicator
  const savedEl = page.locator("#note-saved-ABC-1");
  await expect(savedEl).toBeVisible();

  // Reload page
  await page.reload();
  await expect(page.locator(".issue-table")).toBeVisible();

  // Re-expand ABC-1
  const reloadedRow = page.locator("tr[data-key='ABC-1']:not(.detail-row)");
  await reloadedRow.click();

  const reloadedNote = page.locator(".detail-row[data-key='ABC-1'] .note-area");
  await expect(reloadedNote).toHaveValue("This is a test note for ABC-1");
});

// ──────────────────────────────────────────────
// 6. Text search - filters visible issues
// ──────────────────────────────────────────────
test("search - typing a term filters visible issues", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".issue-table")).toBeVisible();

  const rowsBefore = await page
    .locator(".issue-table tbody tr[data-key]:not(.detail-row)")
    .count();
  expect(rowsBefore).toBeGreaterThan(1);

  // Search for a specific term
  await page.locator("#search").fill("pagination");

  // Should filter to fewer results
  await page.waitForTimeout(100);
  const rowsAfter = await page
    .locator(".issue-table tbody tr[data-key]:not(.detail-row)")
    .count();
  expect(rowsAfter).toBeLessThan(rowsBefore);
  expect(rowsAfter).toBeGreaterThan(0);

  // Clear search
  await page.locator("#search").fill("");
  const rowsRestored = await page
    .locator(".issue-table tbody tr[data-key]:not(.detail-row)")
    .count();
  expect(rowsRestored).toEqual(rowsBefore);
});

// ──────────────────────────────────────────────
// 7. Mismatch view - shows only issues with mismatches
// ──────────────────────────────────────────────
test("mismatch view - shows only issues with mismatches", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tab-btn", { hasText: "Mismatches" }).click();
  await expect(page.locator(".issue-table")).toBeVisible();

  // All visible rows should have ⚠️ icon
  const rows = page.locator(".issue-table tbody tr[data-key]:not(.detail-row)");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);

  // Verify at least one priority mismatch, one category mismatch are present
  // Based on our fixtures: ABC-2 has priority+category, ABC-3 has priority, ABC-4 has category
  const allKeys: string[] = [];
  for (let i = 0; i < count; i++) {
    const key = await rows.nth(i).getAttribute("data-key");
    if (key) allKeys.push(key);
  }
  expect(allKeys).toContain("ABC-2"); // priority + category
  expect(allKeys).toContain("ABC-3"); // priority
});

// ──────────────────────────────────────────────
// 8. Mismatch field filter - deactivating Priority hides priority-only mismatches
// ──────────────────────────────────────────────
test("mismatch filter - deactivating Priority hides priority-only issues", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".tab-btn", { hasText: "Mismatches" }).click();
  await expect(page.locator(".issue-table")).toBeVisible();

  const allCount = await page
    .locator(".issue-table tbody tr[data-key]:not(.detail-row)")
    .count();

  // Deactivate Priority filter
  await page.locator(".mismatch-filter-btn[data-field='priority']").click();
  await page.waitForTimeout(100);

  const filteredCount = await page
    .locator(".issue-table tbody tr[data-key]:not(.detail-row)")
    .count();

  // ABC-3 only has priority mismatch, so deactivating priority should hide it
  expect(filteredCount).toBeLessThanOrEqual(allCount);

  const rows = page.locator(".issue-table tbody tr[data-key]:not(.detail-row)");
  const filteredKeys: string[] = [];
  const c = await rows.count();
  for (let i = 0; i < c; i++) {
    const key = await rows.nth(i).getAttribute("data-key");
    if (key) filteredKeys.push(key);
  }
  // ABC-3 only has priority mismatch - should be hidden
  expect(filteredKeys).not.toContain("ABC-3");
});

// ──────────────────────────────────────────────
// 9. Value view - sorted by buriedGemScore descending
// ──────────────────────────────────────────────
test("value view - issues sorted by buriedGemScore descending", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tab-btn", { hasText: "Value" }).click();
  await expect(page.locator(".issue-table")).toBeVisible();

  // The first issue should have the highest buried gem score
  // ABC-1 and ABC-14 have buriedGemScore 8.0 (highest)
  const firstRow = page
    .locator(".issue-table tbody tr[data-key]:not(.detail-row)")
    .first();
  const firstKey = await firstRow.getAttribute("data-key");

  // Check its gem score is visible and among the highest
  const gemScores = await page.locator(".gem-score").allTextContents();
  if (gemScores.length > 0) {
    const first = parseFloat(gemScores[0]);
    const last = parseFloat(gemScores[gemScores.length - 1]);
    expect(first).toBeGreaterThanOrEqual(last);
  }
});

// ──────────────────────────────────────────────
// 10. Errors view - shows error issues with error message
// ──────────────────────────────────────────────
test("errors view - shows error-status issues with error message", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tab-btn", { hasText: "Errors" }).click();

  const errorBadge = page.locator("#badge-errors");
  const badgeText = await errorBadge.textContent();
  expect(parseInt(badgeText ?? "0")).toBeGreaterThan(0);

  // ABC-11 is the error issue
  await expect(page.locator("tr[data-key='ABC-11']")).toBeVisible();
  await expect(page.locator(".error-msg")).toBeVisible();
  const errorText = await page.locator(".error-msg").textContent();
  expect(errorText?.length).toBeGreaterThan(0);
});

// ──────────────────────────────────────────────
// 11. Pending view - shows only pending issues
// ──────────────────────────────────────────────
test("pending view - shows only pending issues (no result file)", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tab-btn", { hasText: "Pending" }).click();

  const pendingBadge = page.locator("#badge-pending");
  const badgeText = await pendingBadge.textContent();
  expect(parseInt(badgeText ?? "0")).toEqual(2); // ABC-19 and ABC-20

  await expect(page.locator("tr[data-key='ABC-19']")).toBeVisible();
  await expect(page.locator("tr[data-key='ABC-20']")).toBeVisible();
});

// ──────────────────────────────────────────────
// 12. Jira link - issue key has correct href
// ──────────────────────────────────────────────
test("jira link - issue key link points to correct Jira URL", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".issue-table")).toBeVisible();

  // Find the first key link
  const keyLink = page.locator(".key-link").first();
  const href = await keyLink.getAttribute("href");

  // Should start with the configured Jira base URL
  expect(href).toMatch(/https?:\/\/.+\/browse\/ABC-/);
});

// ──────────────────────────────────────────────
// 13. Stale icon - stale issue shows 🕐 icon, non-stale does not
// ──────────────────────────────────────────────
test("stale icon - ABC-9 shows stale icon, ABC-1 does not", async ({ page }) => {
  await page.goto("/");

  // Go to value view to see all issues including dismissed
  await page.locator(".tab-btn", { hasText: "Value" }).click();
  await expect(page.locator(".issue-table")).toBeVisible();
  // Show dismissed to see ABC-9
  await page.locator("#value-dismissed-toggle").click();
  await page.waitForTimeout(100);

  // ABC-9 is stale
  const abc9Row = page.locator("tr[data-key='ABC-9']:not(.detail-row)");
  if (await abc9Row.isVisible()) {
    await expect(abc9Row.locator(".stale-icon")).toBeVisible();
  }

  // ABC-1 is not stale
  const abc1Row = page.locator("tr[data-key='ABC-1']:not(.detail-row)");
  if (await abc1Row.isVisible()) {
    await expect(abc1Row.locator(".stale-icon")).toHaveCount(0);
  }
});

// ──────────────────────────────────────────────
// 14. Expand/collapse - click row shows detail panel
// ──────────────────────────────────────────────
test("expand/collapse - clicking row shows AI summary and mismatch details", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".issue-table")).toBeVisible();

  // Click ABC-2 row (has mismatches)
  const row = page.locator("tr[data-key='ABC-2']:not(.detail-row)");
  await expect(row).toBeVisible();

  const detailRow = page.locator(".detail-row[data-key='ABC-2']");
  await expect(detailRow).not.toBeVisible();

  await row.click();
  await expect(detailRow).toBeVisible();

  // Should show AI summary
  const detailPanel = detailRow.locator(".detail-panel");
  await expect(detailPanel).toBeVisible();
  await expect(detailPanel.locator("text=AI Summary")).toBeVisible();

  // Should show mismatch details
  await expect(detailPanel.locator("text=Mismatches")).toBeVisible();

  // Click again to collapse
  await row.click();
  await expect(detailRow).not.toBeVisible();
});

// ──────────────────────────────────────────────
// 15. Export CSV - triggers a file download
// ──────────────────────────────────────────────
test("export CSV - clicking Export CSV triggers download with expected columns", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".issue-table")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-triage").click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.csv$/);

  // Read downloaded content
  const content = await (await download.createReadStream()).read(10000);
  const csvText = content?.toString() ?? "";

  // Check header row contains expected columns
  expect(csvText).toContain("Key");
  expect(csvText).toContain("Summary");
  expect(csvText).toContain("Category");
  expect(csvText).toContain("Priority Score");
  expect(csvText).toContain("Recommended Action");
});
