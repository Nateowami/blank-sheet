// `serve` command: starts the local web server
import type { ApiData, ApiIssue, Config, JiraIssue, Meta, ReviewEntry, Reviews } from "../types.ts";
import {
  listRawKeys,
  readClosed,
  readJson,
  readMeta,
  readRawIssue,
  readResult,
  readReviews,
  reviewsPath,
  writeReviews,
} from "../storage.ts";

const HTML_PATH = new URL("../web/index.html", import.meta.url).pathname;

async function loadData(dataDir: string, baseUrl: string): Promise<ApiData> {
  const rawKeys = await listRawKeys(dataDir);
  const meta: Meta = (await readMeta(dataDir)) ?? {
    lastFetchedAt: null,
    lastProcessedAt: null,
    openIssueCount: 0,
    closedIssueCount: 0,
    processedCount: 0,
    errorCount: 0,
    pendingCount: 0,
  };

  const reviews = await readReviews(dataDir);
  const closed = await readClosed(dataDir);

  const issues: ApiIssue[] = [];

  for (const key of rawKeys) {
    const raw = await readRawIssue(dataDir, key);
    if (!raw) continue;
    const result = await readResult(dataDir, key);
    const review = reviews[key];

    const f = raw.fields;

    let resultStatus: "ok" | "error" | "pending" = "pending";
    if (result?.status === "ok") resultStatus = "ok";
    else if (result?.status === "error") resultStatus = "error";

    issues.push({
      key,
      jiraSummary: f.summary,
      jiraType: f.issuetype?.name ?? "Unknown",
      jiraPriority: f.priority?.name ?? "None",
      jiraLabels: f.labels ?? [],
      jiraComponents: (f.components ?? []).map((c) => c.name),
      jiraStatus: f.status?.name ?? "Unknown",
      jiraAssignee: f.assignee?.displayName ?? null,
      jiraCreated: f.created,
      jiraUpdated: f.updated,
      jiraLink: `${baseUrl}/browse/${key}`,
      resultStatus,
      analysis: result?.analysis ?? null,
      error: result?.error ?? null,
      processedAt: result?.processedAt ?? null,
      dismissed: review?.dismissed ?? false,
      note: review?.note ?? null,
    });
  }

  return {
    issues,
    meta,
    closedCount: closed?.issues.length ?? 0,
  };
}

export async function runServe(
  config: Config,
  useTestData: boolean,
): Promise<void> {
  const dataDir = useTestData ? "./test-data" : config.data.dir;
  const port = config.server.port;
  const baseUrl = config.jira.baseUrl;

  let html: string;
  try {
    html = await Deno.readTextFile(HTML_PATH);
  } catch {
    console.error(`Error: Could not read web UI at ${HTML_PATH}`);
    Deno.exit(1);
  }

  // Load initial data
  let data = await loadData(dataDir, baseUrl);

  const processedCount = data.issues.filter((i) => i.resultStatus === "ok").length;
  const errorCount = data.issues.filter((i) => i.resultStatus === "error").length;
  const pendingCount = data.issues.filter((i) => i.resultStatus === "pending").length;

  console.log(`Jira Triage running at http://localhost:${port}`);
  console.log(
    `Loaded ${processedCount} processed issues, ${errorCount} errors, ${pendingCount} pending`,
  );

  Deno.serve({ port }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "GET" && path === "/api/data") {
      // Reload fresh on each request
      data = await loadData(dataDir, baseUrl);
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST" && path.startsWith("/api/reviews/")) {
      const key = path.slice("/api/reviews/".length);
      if (!key) {
        return new Response("Bad Request", { status: 400 });
      }

      let body: { dismissed?: boolean; note?: string | null };
      try {
        body = await req.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      const reviews = await readReviews(dataDir);
      const existing: ReviewEntry = reviews[key] ?? {
        dismissed: false,
        dismissedAt: null,
        note: null,
        noteUpdatedAt: null,
      };

      if (body.dismissed !== undefined) {
        existing.dismissed = body.dismissed;
        existing.dismissedAt = body.dismissed ? new Date().toISOString() : null;
      }
      if (body.note !== undefined) {
        existing.note = body.note;
        existing.noteUpdatedAt = new Date().toISOString();
      }

      reviews[key] = existing;
      await writeReviews(dataDir, reviews);

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  });
}
