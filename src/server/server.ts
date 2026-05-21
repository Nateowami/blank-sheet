import { config } from "../config.ts";
import { handleDashboard } from "./api/dashboard.ts";
import { handleListGroups, handleGetGroup, handleGroupSummary } from "./api/groups.ts";
import {
  handleListSuggestions,
  handleAcceptSuggestion,
  handleRejectSuggestion,
} from "./api/merge_suggestions.ts";
import { handleListMergeHistory, handleUndoMerge } from "./api/merge_history.ts";
import { handleTrends } from "./api/trends.ts";

const UI_DIR = new URL("./ui", import.meta.url).pathname;

async function serveStatic(pathname: string): Promise<Response> {
  const filePath = pathname === "/" ? `${UI_DIR}/index.html` : `${UI_DIR}${pathname}`;
  try {
    const content = await Deno.readFile(filePath);
    const ext = filePath.split(".").pop() ?? "";
    const contentTypes: Record<string, string> = {
      html: "text/html; charset=utf-8",
      css: "text/css",
      js: "text/javascript",
      json: "application/json",
      ico: "image/x-icon",
    };
    return new Response(content, {
      headers: {
        "Content-Type": contentTypes[ext] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // CORS for development
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let response: Response;

    if (path === "/api/dashboard" && method === "GET") {
      response = await handleDashboard(req);
    } else if (path === "/api/groups" && method === "GET") {
      response = await handleListGroups(req);
    } else if (path.match(/^\/api\/groups\/([^/]+)$/) && method === "GET") {
      const id = path.split("/")[3];
      response = await handleGetGroup(req, id);
    } else if (path.match(/^\/api\/groups\/([^/]+)\/summary$/) && method === "GET") {
      const id = path.split("/")[3];
      response = await handleGroupSummary(req, id);
    } else if (path === "/api/merge-suggestions" && method === "GET") {
      response = await handleListSuggestions(req);
    } else if (path.match(/^\/api\/merge-suggestions\/([^/]+)\/accept$/) && method === "POST") {
      const id = path.split("/")[3];
      response = await handleAcceptSuggestion(req, id);
    } else if (path.match(/^\/api\/merge-suggestions\/([^/]+)\/reject$/) && method === "POST") {
      const id = path.split("/")[3];
      response = await handleRejectSuggestion(req, id);
    } else if (path === "/api/merge-history" && method === "GET") {
      response = await handleListMergeHistory(req);
    } else if (
      path.match(/^\/api\/merge-history\/([^/]+)\/undo\/([^/]+)$/) &&
      method === "POST"
    ) {
      const parts = path.split("/");
      response = await handleUndoMerge(req, parts[3], parts[5]);
    } else if (path === "/api/trends" && method === "GET") {
      response = await handleTrends(req);
    } else if (path.startsWith("/api/")) {
      response = new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    } else {
      // Serve static files
      response = await serveStatic(path);
    }

    // Add CORS headers
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders)) {
      headers.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch (err) {
    console.error("[server] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: String(err) }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  }
}

export async function startServer(): Promise<void> {
  const port = config.ui.port;
  console.log(`[server] Starting on http://localhost:${port}`);
  Deno.serve({ port }, handleRequest);
  // Keep running
  await new Promise<never>(() => {});
}
