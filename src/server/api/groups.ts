import {
  groupsCollection,
  eventsCollection,
  ObjectId,
} from "../../db/mongo.ts";
import { generateMarkdownSummary } from "../../summary/markdown.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return json({ error: "Not found" }, 404);
}

// ─── List groups ───────────────────────────────────────────────────────────────

export async function handleListGroups(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sortBy = url.searchParams.get("sortBy") ?? "eventCount";
  const direction = url.searchParams.get("direction") === "asc" ? 1 : -1;
  const releaseStage = url.searchParams.get("releaseStage");
  const hasPII = url.searchParams.get("hasPII");
  const hasTemplate = url.searchParams.get("hasTemplate");
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));
  const limit = 50;

  const groups = await groupsCollection();

  const filter: Record<string, unknown> = { status: "active" };
  if (releaseStage) filter.releaseStages = releaseStage;
  if (hasPII === "true") filter.hasPII = true;
  if (hasPII === "false") filter.hasPII = false;
  if (hasTemplate === "true") filter.template = { $ne: null };
  if (hasTemplate === "false") filter.template = null;

  const validSortFields: Record<string, string> = {
    eventCount: "eventCount",
    lastSeenAt: "lastSeenAt",
    firstSeenAt: "firstSeenAt",
    userCount: "uniqueUserCount",
  };
  const sortField = validSortFields[sortBy] ?? "eventCount";

  // When filtering by release stage, stored aggregates (eventCount, uniqueUserCount)
  // cover all stages, so we must compute counts from raw events and sort in memory.
  if (releaseStage) {
    // Fetch all matching groups — only the fields we need for display + eventIds for counting.
    const allDocs = await groups
      .find(filter)
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

    // Compute per-group event/user counts for this stage in one batch query.
    const eventsCol = await eventsCollection();
    const allEventIds = allDocs.flatMap((g) => g.eventIds);
    const eventToGroup = new Map<string, string>();
    for (const g of allDocs) {
      for (const eid of g.eventIds) {
        eventToGroup.set(eid.toString(), g._id.toString());
      }
    }
    const matchingEvents = await eventsCol
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

    // Sort in memory using the stage-accurate values.
    const sorted = [...allDocs].sort((a, b) => {
      let aVal: number, bVal: number;
      if (sortBy === "eventCount") {
        aVal = stageCounts.get(a._id.toString())?.count ?? 0;
        bVal = stageCounts.get(b._id.toString())?.count ?? 0;
      } else if (sortBy === "userCount") {
        aVal = stageCounts.get(a._id.toString())?.users.size ?? 0;
        bVal = stageCounts.get(b._id.toString())?.users.size ?? 0;
      } else if (sortBy === "lastSeenAt") {
        aVal = a.lastSeenAt.getTime();
        bVal = b.lastSeenAt.getTime();
      } else {
        aVal = a.firstSeenAt.getTime();
        bVal = b.firstSeenAt.getTime();
      }
      return direction === 1 ? aVal - bVal : bVal - aVal;
    });

    const total = sorted.length;
    const pageDocs = sorted.slice((page - 1) * limit, page * limit);

    return json({
      total,
      page,
      limit,
      groups: pageDocs.map((g) => {
        const sc = stageCounts.get(g._id.toString());
        return {
          _id: g._id,
          label: g.template ?? g.exampleMessages[0] ?? "Unknown",
          template: g.template,
          firstSeenAt: g.firstSeenAt,
          lastSeenAt: g.lastSeenAt,
          eventCount: sc?.count ?? 0,
          uniqueUserCount: sc?.users.size ?? 0,
          releaseStages: g.releaseStages,
          hasPII: g.hasPII,
        };
      }),
    });
  }

  // No stage filter — use MongoDB sort and pagination directly.
  const total = await groups.countDocuments(filter);
  const docs = await groups
    .find(filter)
    .sort({ [sortField]: direction })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return json({
    total,
    page,
    limit,
    groups: docs.map((g) => ({
      _id: g._id,
      label: g.template ?? g.exampleMessages[0] ?? "Unknown",
      template: g.template,
      firstSeenAt: g.firstSeenAt,
      lastSeenAt: g.lastSeenAt,
      eventCount: g.eventCount,
      uniqueUserCount: g.uniqueUserCount,
      releaseStages: g.releaseStages,
      hasPII: g.hasPII,
    })),
  });
}

// ─── Get group detail ──────────────────────────────────────────────────────────

export async function handleGetGroup(
  _req: Request,
  id: string,
): Promise<Response> {
  const groups = await groupsCollection();
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return notFound();
  }
  const group = await groups.findOne({ _id: oid });
  if (!group) return notFound();

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const events = await eventsCollection();
  const lastSevenCount = await events.countDocuments({
    _id: { $in: group.eventIds },
    receivedAt: { $gte: sevenDaysAgo },
  });
  const priorSevenCount = await events.countDocuments({
    _id: { $in: group.eventIds },
    receivedAt: { $gte: fourteenDaysAgo, $lt: sevenDaysAgo },
  });

  let trend: string;
  if (lastSevenCount > priorSevenCount * 1.1) trend = "↑ Increasing";
  else if (lastSevenCount < priorSevenCount * 0.9) trend = "↓ Decreasing";
  else trend = "→ Stable";

  // Filter stacktrace for display
  const displayStacktrace = group.representativeStacktrace
    .filter((f) => !f.file.includes("node_modules"))
    .slice(0, 10);

  return json({
    ...group,
    trend,
    lastSevenDayCount: lastSevenCount,
    priorSevenDayCount: priorSevenCount,
    displayStacktrace,
  });
}

// ─── Get group events (paginated) ─────────────────────────────────────────────

export async function handleGetGroupEvents(
  req: Request,
  id: string,
): Promise<Response> {
  const groups = await groupsCollection();
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return notFound();
  }
  const group = await groups.findOne({ _id: oid }, { projection: { eventIds: 1 } });
  if (!group) return notFound();

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20")));

  const events = await eventsCollection();
  const total = group.eventIds.length;
  const skip = (page - 1) * limit;

  // Fetch the slice of event IDs for this page, then look them up
  const pageIds = group.eventIds.slice(skip, skip + limit);
  const docs = await events
    .find({ _id: { $in: pageIds } })
    .sort({ receivedAt: -1 })
    .toArray();

  return json({
    total,
    page,
    limit,
    events: docs.map((e) => ({
      _id: e._id,
      errorMessage: e.errorMessage,
      receivedAt: e.receivedAt,
      releaseStage: e.releaseStage,
      userId: e.user?.id ?? null,
    })),
  });
}

// ─── Get distinct release stages ───────────────────────────────────────────────

export async function handleGetReleaseStages(_req: Request): Promise<Response> {
  const groups = await groupsCollection();
  const stages = await groups.distinct("releaseStages", { status: "active" });
  return json((stages as string[]).sort());
}

// ─── Get group markdown summary ────────────────────────────────────────────────

export async function handleGroupSummary(
  _req: Request,
  id: string,
): Promise<Response> {
  const groups = await groupsCollection();
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return notFound();
  }
  const group = await groups.findOne({ _id: oid });
  if (!group) return notFound();

  const events = await eventsCollection();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const lastSevenCount = await events.countDocuments({
    _id: { $in: group.eventIds },
    receivedAt: { $gte: sevenDaysAgo },
  });
  const priorSevenCount = await events.countDocuments({
    _id: { $in: group.eventIds },
    receivedAt: { $gte: fourteenDaysAgo, $lt: sevenDaysAgo },
  });

  const md = generateMarkdownSummary(group, lastSevenCount, priorSevenCount);
  return new Response(md, { headers: { "Content-Type": "text/plain" } });
}
