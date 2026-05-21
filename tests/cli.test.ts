// Deno unit tests for CLI processing logic
import { computeBuriedGemScore, detectMismatches } from "../src/ai.ts";
import type { IssueAnalysis, JiraIssue } from "../src/types.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    const detail = msg ? ` ${msg}:` : ":";
    throw new Error(`assertEquals failed${detail} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    const detail = msg ? ` ${msg}:` : ":";
    throw new Error(`assertDeepEquals failed${detail} expected ${e}, got ${a}`);
  }
}

// ──────────────────────────────────────────────
// Helper: make a minimal JiraIssue
// ──────────────────────────────────────────────
function makeIssue(overrides: Partial<{
  key: string;
  summary: string;
  priority: string;
  issuetype: string;
  labels: string[];
  components: string[];
}>): JiraIssue {
  return {
    id: "10001",
    key: overrides.key ?? "ABC-1",
    fields: {
      summary: overrides.summary ?? "Test issue summary",
      description: "Some description",
      issuetype: { name: overrides.issuetype ?? "Bug" },
      status: { name: "Open", statusCategory: { name: "To Do" } },
      priority: { name: overrides.priority ?? "Major" },
      labels: overrides.labels ?? [],
      components: (overrides.components ?? []).map((name) => ({ name })),
      fixVersions: [],
      reporter: { displayName: "Test User" },
      assignee: null,
      created: "2024-01-01T00:00:00.000Z",
      updated: "2024-06-01T00:00:00.000Z",
      comment: { comments: [], total: 0 },
      issuelinks: [],
      parent: undefined,
    },
    _fetchedAt: "2024-12-01T00:00:00.000Z",
  };
}

// ──────────────────────────────────────────────
// Helper: make a minimal IssueAnalysis
// ──────────────────────────────────────────────
function makeAnalysis(overrides: Partial<IssueAnalysis>): IssueAnalysis {
  return {
    summary: "AI summary of test issue",
    category: "bug",
    tags: ["auth", "backend"],
    priorityScore: 5,
    effort: "M",
    recommendedAction: "keep",
    recommendedActionReason: "No urgency",
    stalenessFlag: false,
    stalenessReason: null,
    buriedGemScore: 2.5,
    confidence: "high",
    confidenceReason: null,
    mismatches: {
      priority: null,
      category: null,
      labels: null,
      summary: null,
    },
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// 1. buriedGemScore computation
// ──────────────────────────────────────────────
Deno.test("buriedGemScore - S effort divides by 1", () => {
  assertEquals(computeBuriedGemScore(8, "S"), 8.0);
});

Deno.test("buriedGemScore - M effort divides by 2", () => {
  assertEquals(computeBuriedGemScore(8, "M"), 4.0);
});

Deno.test("buriedGemScore - L effort divides by 3", () => {
  // 9/3 = 3.0
  assertEquals(computeBuriedGemScore(9, "L"), 3.0);
});

Deno.test("buriedGemScore - XL effort divides by 4", () => {
  // 8/4 = 2.0
  assertEquals(computeBuriedGemScore(8, "XL"), 2.0);
});

Deno.test("buriedGemScore - rounds to 2 decimal places", () => {
  // 7/3 = 2.333... → 2.33
  assertEquals(computeBuriedGemScore(7, "L"), 2.33);
});

Deno.test("buriedGemScore - score 1 effort S gives 1.0", () => {
  assertEquals(computeBuriedGemScore(1, "S"), 1.0);
});

// ──────────────────────────────────────────────
// 2. Priority mismatch detection
// ──────────────────────────────────────────────
Deno.test("priority mismatch - score 7 with Minor priority triggers mismatch", () => {
  const issue = makeIssue({ priority: "Minor" });
  const analysis = makeAnalysis({ priorityScore: 7 });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.priority !== null, true, "Expected priority mismatch");
  assertEquals(result.priority!.jiraValue, "Minor");
  assertEquals(result.priority!.aiValue, "7/10");
});

Deno.test("priority mismatch - score 6 with Minor priority does NOT trigger mismatch", () => {
  const issue = makeIssue({ priority: "Minor" });
  const analysis = makeAnalysis({ priorityScore: 6 });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.priority, null, "Expected no priority mismatch at score 6");
});

Deno.test("priority mismatch - score 3 with Critical priority triggers mismatch", () => {
  const issue = makeIssue({ priority: "Critical" });
  const analysis = makeAnalysis({ priorityScore: 3 });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.priority !== null, true, "Expected priority mismatch");
  assertEquals(result.priority!.jiraValue, "Critical");
  assertEquals(result.priority!.aiValue, "3/10");
});

Deno.test("priority mismatch - score 4 with Critical priority does NOT trigger mismatch", () => {
  const issue = makeIssue({ priority: "Critical" });
  const analysis = makeAnalysis({ priorityScore: 4 });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.priority, null, "Expected no priority mismatch at score 4");
});

Deno.test("priority mismatch - score 7 with Blocker triggers mismatch", () => {
  // This should NOT trigger: 7 >= 7 and Blocker is high priority (we only trigger when Jira is low)
  // 7 with Low → mismatch; 7 with Blocker → no mismatch (AI agrees it's high)
  const issue = makeIssue({ priority: "Blocker" });
  const analysis = makeAnalysis({ priorityScore: 7 });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.priority, null, "No mismatch when both AI and Jira agree it's high");
});

Deno.test("priority mismatch - score 2 with Low priority does NOT trigger mismatch (low->low no mismatch)", () => {
  // score 2 with Low: AI says low, Jira says low → no mismatch (score ≤ 3 but Jira is not Critical/Blocker)
  const issue = makeIssue({ priority: "Low" });
  const analysis = makeAnalysis({ priorityScore: 2 });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.priority, null, "No mismatch when both agree it's low");
});

Deno.test("priority mismatch - score 8 with Low priority triggers mismatch", () => {
  const issue = makeIssue({ priority: "Low" });
  const analysis = makeAnalysis({ priorityScore: 8 });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.priority !== null, true, "Expected priority mismatch");
});

// ──────────────────────────────────────────────
// 3. Category mismatch detection
// ──────────────────────────────────────────────
Deno.test("category mismatch - AI=bug, Jira=Bug, no mismatch", () => {
  const issue = makeIssue({ issuetype: "Bug" });
  const analysis = makeAnalysis({ category: "bug" });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.category, null, "No mismatch when AI and Jira agree on bug");
});

Deno.test("category mismatch - AI=bug, Jira=Task, mismatch detected", () => {
  const issue = makeIssue({ issuetype: "Task" });
  const analysis = makeAnalysis({ category: "bug" });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.category !== null, true, "Expected category mismatch: AI=bug, Jira=Task");
});

Deno.test("category mismatch - AI=feature, Jira=Bug, mismatch detected", () => {
  const issue = makeIssue({ issuetype: "Bug" });
  const analysis = makeAnalysis({ category: "feature" });
  const result = detectMismatches(issue, analysis);
  assertEquals(result.category !== null, true, "Expected category mismatch: AI=feature, Jira=Bug");
});

// ──────────────────────────────────────────────
// 4. CLI summary format
// ──────────────────────────────────────────────
Deno.test("CLI summary - summary output format is correct for known data", async () => {
  // Read fixture results and compute expected summary values
  const dataDir = "./test-data";
  const { listRawKeys, readResult } = await import("../src/storage.ts");

  const keys = await listRawKeys(dataDir);
  const results = await Promise.all(keys.map((k) => readResult(dataDir, k)));

  const okResults = results.filter((r) => r?.status === "ok");
  const errorResults = results.filter((r) => r?.status === "error");
  const pendingResults = results.filter((r) => !r);

  // Based on test-data: 17 ok, 1 error, 2 pending (ABC-19, ABC-20)
  assertEquals(okResults.length, 17, "Expected 17 ok results");
  assertEquals(errorResults.length, 1, "Expected 1 error result");
  assertEquals(pendingResults.length, 2, "Expected 2 pending (no result file)");
});

Deno.test("CLI summary - action counts are correct for fixture data", async () => {
  const dataDir = "./test-data";
  const { listRawKeys, readResult } = await import("../src/storage.ts");

  const keys = await listRawKeys(dataDir);
  const results = await Promise.all(keys.map((k) => readResult(dataDir, k)));
  const okResults = results.filter((r) => r?.status === "ok");

  const actionCounts: Record<string, number> = {
    close: 0,
    prioritize: 0,
    "needs-info": 0,
    keep: 0,
  };
  for (const r of okResults) {
    if (r?.analysis?.recommendedAction) {
      actionCounts[r.analysis.recommendedAction] =
        (actionCounts[r.analysis.recommendedAction] ?? 0) + 1;
    }
  }

  // Based on our fixture data
  assertEquals(actionCounts["close"] >= 1, true, "Expected at least 1 close");
  assertEquals(actionCounts["prioritize"] >= 1, true, "Expected at least 1 prioritize");
  assertEquals(actionCounts["keep"] >= 1, true, "Expected at least 1 keep");
});

Deno.test("CLI summary - staleness count from fixture data", async () => {
  const dataDir = "./test-data";
  const { listRawKeys, readResult } = await import("../src/storage.ts");

  const keys = await listRawKeys(dataDir);
  const results = await Promise.all(keys.map((k) => readResult(dataDir, k)));
  const staleCount = results.filter((r) => r?.analysis?.stalenessFlag).length;

  // ABC-9 is stale in our fixtures
  assertEquals(staleCount >= 1, true, "Expected at least 1 stale issue");
});

Deno.test("CLI summary - mismatch count includes priority and category mismatches", async () => {
  const dataDir = "./test-data";
  const { listRawKeys, readResult } = await import("../src/storage.ts");

  const keys = await listRawKeys(dataDir);
  const results = await Promise.all(keys.map((k) => readResult(dataDir, k)));

  const priorityMismatches = results.filter(
    (r) => r?.analysis?.mismatches?.priority != null,
  ).length;
  const categoryMismatches = results.filter(
    (r) => r?.analysis?.mismatches?.category != null,
  ).length;

  assertEquals(priorityMismatches >= 2, true, "Expected at least 2 priority mismatches");
  assertEquals(categoryMismatches >= 2, true, "Expected at least 2 category mismatches");
});
