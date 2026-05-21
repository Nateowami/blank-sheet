import { env, config } from "../config.ts";
import type { StackFrame } from "../db/mongo.ts";

// ─── Bugsnag API types ─────────────────────────────────────────────────────────

interface BugsnagException {
  error_class: string;
  message: string;
  stacktrace: Array<{
    file: string;
    line_number: number;
    column_number: number;
    method: string;
    in_project: boolean;
    code?: Record<string, string> | null;
  }>;
}

interface BugsnagUser {
  id?: string;
}

export interface BugsnagEvent {
  id: string;
  project_id: string;
  received_at: string; // ISO-8601
  release_stage: string;
  exceptions: BugsnagException[];
  user: BugsnagUser | null;
  metaData: Record<string, unknown>;
  app?: { release_stage?: string };
}

// ─── API client ────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.bugsnag.com";

async function apiFetch<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${env.bugsnagApiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (res.status === 429) {
      console.warn("[bugsnag] Rate limited (429) — waiting 60 s before retrying…");
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bugsnag API ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}

/**
 * Fetch all events from Bugsnag for a project, yielding pages.
 * Stops when events older than `since` are encountered (they arrive newest-first).
 */
export async function* fetchEventsSince(
  projectId: string,
  since: Date,
): AsyncGenerator<BugsnagEvent[]> {
  const perPage = config.bugsnag.pageSize;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      per_page: String(perPage),
      "page[offset]": String(offset),
      sort: "timestamp",
      direction: "desc",
    });

    const events = await apiFetch<BugsnagEvent[]>(
      `/projects/${projectId}/events?${params}`,
    );

    if (!events || events.length === 0) break;

    // Filter to only events newer than since
    const newEvents = events.filter(
      (e) => new Date(e.received_at) > since,
    );

    if (newEvents.length > 0) {
      yield newEvents;
    }

    // If the last event in this page is older than since, stop paginating.
    // Do NOT stop just because we received fewer items than perPage — the API
    // may impose its own per-page cap that is smaller than our requested size.
    const oldest = new Date(events[events.length - 1].received_at);
    if (oldest <= since) {
      hasMore = false;
    } else {
      offset += events.length;
    }
  }
}

// ─── Conversion helpers ────────────────────────────────────────────────────────

export function extractFirstException(
  event: BugsnagEvent,
): { errorClass: string; errorMessage: string; stacktrace: StackFrame[] } {
  const ex = event.exceptions?.[0];
  if (!ex) {
    return { errorClass: "Unknown", errorMessage: "Unknown error", stacktrace: [] };
  }
  return {
    errorClass: ex.error_class ?? "Unknown",
    errorMessage: ex.message ?? "",
    stacktrace: (ex.stacktrace ?? []).map((f) => ({
      file: f.file ?? "",
      lineNumber: f.line_number ?? 0,
      columnNumber: f.column_number ?? 0,
      method: f.method ?? "",
      inProject: f.in_project ?? false,
      code: f.code ?? null,
    })),
  };
}
