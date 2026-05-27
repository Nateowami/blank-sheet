import { eventsCollection, groupsCollection, mergeSuggestionsCollection, ObjectId } from "../../db/mongo.ts";

export async function handleDashboard(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const releaseStage = url.searchParams.get("releaseStage") ?? null;

  const events = await eventsCollection();
  const groups = await groupsCollection();

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

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

  // Top 5 most active groups - stage-accurate when a filter is applied.
  let top5Groups;
  if (releaseStage) {
    // Fetch all groups with this stage so we can rank by stage-specific event count.
    const candidates = await groups
      .find(groupStageFilter)
      .project<{
        _id: ObjectId;
        eventIds: ObjectId[];
        template: string | null;
        exampleMessages: string[];
        lastSeenAt: Date;
        firstSeenAt: Date;
        releaseStages: string[];
        hasPII: boolean | null;
      }>({
        _id: 1, eventIds: 1, template: 1, exampleMessages: 1,
        lastSeenAt: 1, firstSeenAt: 1, releaseStages: 1, hasPII: 1,
      })
      .toArray();

    const allEventIds = candidates.flatMap((g) => g.eventIds);
    const eventToGroup = new Map<string, string>();
    for (const g of candidates) {
      for (const eid of g.eventIds) {
        eventToGroup.set(eid.toString(), g._id.toString());
      }
    }
    const matchingEvents = await events
      .find({ _id: { $in: allEventIds }, releaseStage })
      .project<{ _id: ObjectId; user: { id: string } | null }>({ _id: 1, user: 1 })
      .toArray();

    const stageCounts = new Map<string, { count: number; users: Set<string> }>();
    for (const e of matchingEvents) {
      const gid = eventToGroup.get(e._id.toString());
      if (!gid) continue;
      if (!stageCounts.has(gid)) stageCounts.set(gid, { count: 0, users: new Set() });
      const entry = stageCounts.get(gid)!;
      entry.count++;
      if (e.user?.id) entry.users.add(e.user.id);
    }

    top5Groups = [...candidates]
      .sort((a, b) => (stageCounts.get(b._id.toString())?.count ?? 0) - (stageCounts.get(a._id.toString())?.count ?? 0))
      .slice(0, 5)
      .map((g) => ({
        _id: g._id,
        label: g.template ?? g.exampleMessages[0] ?? "Unknown",
        eventCount: stageCounts.get(g._id.toString())?.count ?? 0,
        uniqueUserCount: stageCounts.get(g._id.toString())?.users.size ?? 0,
        lastSeenAt: g.lastSeenAt,
        firstSeenAt: g.firstSeenAt,
        releaseStages: g.releaseStages,
        hasPII: g.hasPII,
      }));
  } else {
    top5Groups = (await groups
      .find(groupStageFilter)
      .sort({ eventCount: -1 })
      .limit(5)
      .toArray()).map(summarizeGroup);
  }

  // Pending merge suggestions count
  const suggestionsCol = await mergeSuggestionsCollection();
  const pendingSuggestions = await suggestionsCol.countDocuments({ status: "pending" });

  return json({
    totalEvents,
    events30d,
    totalActiveGroups,
    uniqueUsersLast30d,
    eventsPerDay,
    top5Groups,
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
