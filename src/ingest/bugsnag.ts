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
  app?: { releaseStage?: string };
}

// ─── API client ────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.bugsnag.com";

/**
 * Parse the Link response header and return the URL for rel="next", or null.
 * Bugsnag uses Link-header cursor pagination; offset-based pagination is not
 * supported by the Events endpoint.
 */
function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const urlMatch = part.match(/<([^>]+)>/);
    const relMatch = part.match(/rel="([^"]+)"/);
    if (urlMatch && relMatch && relMatch[1] === "next") {
      return urlMatch[1];
    }
  }
  return null;
}

async function apiFetch<T>(url: string): Promise<{ data: T; nextUrl: string | null }> {
  // deno-lint-ignore no-constant-condition
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
    const data = await res.json() as T;
    const nextUrl = parseLinkNext(res.headers.get("Link"));
    return { data, nextUrl };
  }
}

/**
 * Fetch all events from Bugsnag for a project, yielding pages.
 * Stops when events older than `since` are encountered (they arrive newest-first).
 *
 * Note: Bugsnag's Events endpoint caps pages at 30 events regardless of the
 * per_page parameter. Pagination follows the Link header returned with each
 * response (cursor-based), not offset arithmetic.
 */
export async function* fetchEventsSince(
  projectId: string,
  since: Date,
): AsyncGenerator<BugsnagEvent[]> {
  const perPage = config.bugsnag.pageSize;
  const initialParams = new URLSearchParams({
    per_page: String(perPage),
    sort: "timestamp",
    direction: "desc",
  });
  let currentUrl: string | null =
    `${BASE_URL}/projects/${projectId}/events?${initialParams}`;

  while (currentUrl) {
    const { data: events, nextUrl } = await apiFetch<BugsnagEvent[]>(currentUrl);

    if (!events || events.length === 0) break;

    // Filter to only events newer than since
    const newEvents = events.filter(
      (e) => new Date(e.received_at) > since,
    );

    if (newEvents.length > 0) {
      yield newEvents;
    }

    // If the oldest event on this page is at or before our cursor, stop —
    // everything from here onward is already accounted for.
    const oldest = new Date(events[events.length - 1].received_at);
    if (oldest <= since) break;

    currentUrl = nextUrl;
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
