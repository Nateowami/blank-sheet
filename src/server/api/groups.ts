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
