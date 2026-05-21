import { eventsCollection, groupsCollection, mergeSuggestionsCollection } from "../../db/mongo.ts";

export async function handleDashboard(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const releaseStage = url.searchParams.get("releaseStage") ?? null;

  const events = await eventsCollection();
  const groups = await groupsCollection();

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const stageFilter = releaseStage ? { releaseStage } : {};

  // Total events all time
  const totalEvents = await events.countDocuments(stageFilter);

  // Events last 30 days
  const events30d = await events.countDocuments({
    ...stageFilter,
    receivedAt: { $gte: thirtyDaysAgo },
  });

  // Active groups
  const groupStageFilter = releaseStage
    ? { status: "active", releaseStages: releaseStage }
    : { status: "active" };
  const totalActiveGroups = await groups.countDocuments(groupStageFilter);

  // Unique users last 30 days (approximate via groups)
  const activeGroupDocs = await groups
    .find(groupStageFilter)
    .project<{ uniqueUserIds: string[] }>({ uniqueUserIds: 1 })
    .toArray();
  const allUserIds = new Set<string>();
  for (const g of activeGroupDocs) {
    for (const uid of g.uniqueUserIds) allUserIds.add(uid);
  }
  const uniqueUsersLast30d = allUserIds.size;

  // Events per day (last 30 days)
  const eventsPerDayRaw = await events
    .aggregate([
      {
        $match: {
          ...stageFilter,
          receivedAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$receivedAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  const eventsPerDay = eventsPerDayRaw.map((d) => ({
    date: d._id as string,
    count: d.count as number,
  }));

  // Top 5 most active groups last 7 days
  const top5Groups = await groups
    .find(groupStageFilter)
    .sort({ eventCount: -1 })
    .limit(5)
    .toArray();

  // Pending merge suggestions count
  const suggestionsCol = await mergeSuggestionsCollection();
  const pendingSuggestions = await suggestionsCol.countDocuments({ status: "pending" });

  return json({
    totalEvents,
    events30d,
    totalActiveGroups,
    uniqueUsersLast30d,
    eventsPerDay,
    top5Groups: top5Groups.map(summarizeGroup),
    pendingSuggestions,
  });
}

function summarizeGroup(g: {
  _id: unknown;
  template: string | null;
  exampleMessages: string[];
  eventCount: number;
  uniqueUserCount: number;
  lastSeenAt: Date;
  firstSeenAt: Date;
  releaseStages: string[];
  hasPII: boolean | null;
}) {
  return {
    _id: g._id,
    label: g.template ?? g.exampleMessages[0] ?? "Unknown",
    eventCount: g.eventCount,
    uniqueUserCount: g.uniqueUserCount,
    lastSeenAt: g.lastSeenAt,
    firstSeenAt: g.firstSeenAt,
    releaseStages: g.releaseStages,
    hasPII: g.hasPII,
  };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}
