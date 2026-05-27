import { groupsCollection, eventsCollection } from "../../db/mongo.ts";
import { config } from "../../config.ts";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleTrends(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const granularity = url.searchParams.get("granularity") ?? "day";
  const releaseStage = url.searchParams.get("releaseStage") ?? null;
  const mode = url.searchParams.get("mode") ?? "absolute"; // "absolute" | "percent"
  const topN = config.grouping.trendTopNGroups;

  const groups = await groupsCollection();
  const events = await eventsCollection();

  // Time range: last 30 days
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const groupFilter: Record<string, unknown> = { status: "active" };
  if (releaseStage) groupFilter.releaseStages = releaseStage;

  // Get top N groups by event count
  const topGroups = await groups
    .find(groupFilter)
    .sort({ eventCount: -1 })
    .limit(topN)
    .toArray();

  const dateFormat = granularity === "week"
    ? "%Y-%U"
    : granularity === "month"
    ? "%Y-%m"
    : "%Y-%m-%d";

  // Build a lookup from event ID → group label for top-group events.
  const eventIdToLabel = new Map<string, string>();
  for (const group of topGroups) {
    const label = group.template ?? group.exampleMessages[0] ?? String(group._id);
    for (const eid of group.eventIds) {
      eventIdToLabel.set(eid.toString(), label);
    }
  }

  // Fetch all relevant events in a single query, then bucket in-memory.
  const matchFilter: Record<string, unknown> = {
    receivedAt: { $gte: thirtyDaysAgo },
    ...(releaseStage ? { releaseStage } : {}),
  };
  const allMatchingEvents = await events
    .find(matchFilter)
    .project<{ _id: { toString(): string }; receivedAt: Date }>({ _id: 1, receivedAt: 1 })
    .toArray();

  const seriesData: Record<string, Record<string, number>> = {};
  const otherSeries: Record<string, number> = {};
  const allDates = new Set<string>();

  for (const e of allMatchingEvents) {
    const dateBucket = formatDateBucket(e.receivedAt, dateFormat);
    allDates.add(dateBucket);
    const label = eventIdToLabel.get(e._id.toString());
    if (label) {
      if (!seriesData[label]) seriesData[label] = {};
      seriesData[label][dateBucket] = (seriesData[label][dateBucket] ?? 0) + 1;
    } else {
      otherSeries[dateBucket] = (otherSeries[dateBucket] ?? 0) + 1;
    }
  }

  // Ensure all top-group labels appear in seriesData (even if they had no events).
  for (const group of topGroups) {
    const label = group.template ?? group.exampleMessages[0] ?? String(group._id);
    if (!seriesData[label]) seriesData[label] = {};
  }

  const finalDates = [...allDates].sort();

  // Build output series
  const series: Array<{ label: string; data: number[] }> = [];

  for (const [label, dateCounts] of Object.entries(seriesData)) {
    series.push({
      label,
      data: finalDates.map((d) => dateCounts[d] ?? 0),
    });
  }

  series.push({
    label: "Other",
    data: finalDates.map((d) => otherSeries[d] ?? 0),
  });

  // Optionally convert to percentages
  if (mode === "percent") {
    const totals = finalDates.map((_, i) =>
      series.reduce((sum, s) => sum + s.data[i], 0),
    );
    for (const s of series) {
      s.data = s.data.map((v, i) => (totals[i] > 0 ? Math.round((v / totals[i]) * 100) : 0));
    }
  }

  return json({ dates: finalDates, series, granularity, mode });
}

/**
 * Format a Date into a string bucket matching the MongoDB $dateToString formats used above.
 * Supported formats: "%Y-%m-%d" (day), "%Y-%U" (week), "%Y-%m" (month).
 */
function formatDateBucket(date: Date, format: string): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  if (format === "%Y-%m") return `${y}-${m}`;
  if (format === "%Y-%U") {
    // ISO week number matching MongoDB's %U (Sunday-based, 00–53)
    const startOfYear = new Date(Date.UTC(y, 0, 1));
    const dayOfYear = Math.floor((date.getTime() - startOfYear.getTime()) / 86400000);
    const startDow = startOfYear.getUTCDay(); // 0=Sun
    const week = Math.floor((dayOfYear + startDow) / 7);
    return `${y}-${String(week).padStart(2, "0")}`;
  }
  // default: "%Y-%m-%d"
  return `${y}-${m}-${d}`;
}
