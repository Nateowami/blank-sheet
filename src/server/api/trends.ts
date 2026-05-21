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

  // For each top group, get event counts over time
  const seriesData: Record<string, Record<string, number>> = {};

  for (const group of topGroups) {
    const label = group.template ?? group.exampleMessages[0] ?? String(group._id);
    const agg = await events
      .aggregate([
        {
          $match: {
            _id: { $in: group.eventIds },
            receivedAt: { $gte: thirtyDaysAgo },
            ...(releaseStage ? { releaseStage } : {}),
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: dateFormat, date: "$receivedAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    seriesData[label] = {};
    for (const bucket of agg) {
      seriesData[label][bucket._id as string] = bucket.count as number;
    }
  }

  // Build sorted list of all date buckets
  const allDates = new Set<string>();
  for (const series of Object.values(seriesData)) {
    for (const date of Object.keys(series)) allDates.add(date);
  }
  const sortedDates = [...allDates].sort();

  // Build "Other" series
  const otherAgg = await events
    .aggregate([
      {
        $match: {
          _id: { $nin: topGroups.flatMap((g) => g.eventIds) },
          receivedAt: { $gte: thirtyDaysAgo },
          ...(releaseStage ? { releaseStage } : {}),
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: "$receivedAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  const otherSeries: Record<string, number> = {};
  for (const bucket of otherAgg) {
    otherSeries[bucket._id as string] = bucket.count as number;
    allDates.add(bucket._id as string);
  }

  const finalDates = [...new Set([...sortedDates, ...Object.keys(otherSeries)])].sort();

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
