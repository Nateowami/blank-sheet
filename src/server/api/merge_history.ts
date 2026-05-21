import {
  groupsCollection,
  eventsCollection,
  ObjectId,
} from "../../db/mongo.ts";
import { computeCentroid } from "../../grouping/embeddings.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── List all merge history ────────────────────────────────────────────────────

export async function handleListMergeHistory(_req: Request): Promise<Response> {
  const groups = await groupsCollection();

  const groupsWithHistory = await groups
    .find({ "mergeHistory.0": { $exists: true } })
    .toArray();

  const entries: unknown[] = [];

  for (const group of groupsWithHistory) {
    for (const record of group.mergeHistory) {
      entries.push({
        groupId: group._id,
        groupLabel: group.template ?? group.exampleMessages[0] ?? "Unknown",
        mergedAt: record.mergedAt,
        absorbedGroupId: record.absorbedGroupId,
        absorbedGroupLabel:
          // deno-lint-ignore no-explicit-any
          (record.absorbedGroupSnapshot as any).template ??
          // deno-lint-ignore no-explicit-any
          (record.absorbedGroupSnapshot as any).exampleMessages?.[0] ??
          "Unknown",
        triggeredBy: record.triggeredBy,
        llmReasoning: record.llmReasoning,
      });
    }
  }

  // Sort chronologically descending
  entries.sort(
    (a, b) =>
      new Date((b as { mergedAt: Date }).mergedAt).getTime() -
      new Date((a as { mergedAt: Date }).mergedAt).getTime(),
  );

  return json(entries);
}

// ─── Undo a merge ──────────────────────────────────────────────────────────────

export async function handleUndoMerge(
  _req: Request,
  groupId: string,
  absorbedGroupId: string,
): Promise<Response> {
  const groups = await groupsCollection();
  const events = await eventsCollection();

  let groupOid: ObjectId, absorbedOid: ObjectId;
  try {
    groupOid = new ObjectId(groupId);
    absorbedOid = new ObjectId(absorbedGroupId);
  } catch {
    return json({ error: "Invalid ID" }, 400);
  }

  const group = await groups.findOne({ _id: groupOid });
  if (!group) return json({ error: "Group not found" }, 404);

  const mergeRecord = group.mergeHistory.find((m) =>
    m.absorbedGroupId.equals(absorbedOid),
  );
  if (!mergeRecord) return json({ error: "Merge record not found" }, 404);

  const snapshot = mergeRecord.absorbedGroupSnapshot as GroupDoc;

  // Restore group B from snapshot
  await groups.replaceOne(
    { _id: absorbedOid },
    {
      ...snapshot,
      _id: absorbedOid,
      status: "active",
      mergedIntoGroupId: null,
    },
    { upsert: true },
  );

  // Remove group B's event IDs from group A
  const absorbedEventIds = (snapshot.eventIds ?? []) as ObjectId[];
  const absorbedIdSet = new Set(absorbedEventIds.map((id) => id.toString()));
  const remainingEventIds = group.eventIds.filter(
    (id) => !absorbedIdSet.has(id.toString()),
  );

  // Recalculate group A metadata
  const eventDocs = await events
    .find({ _id: { $in: remainingEventIds } })
    .toArray();

  const userIds = new Set<string>();
  let noUserId = 0;
  const stages = new Set<string>();
  let firstSeenAt: Date | null = null;
  let lastSeenAt: Date | null = null;

  for (const e of eventDocs) {
    if (e.user?.id) userIds.add(e.user.id);
    else noUserId++;
    stages.add(e.releaseStage);
    if (!firstSeenAt || e.receivedAt < firstSeenAt) firstSeenAt = e.receivedAt;
    if (!lastSeenAt || e.receivedAt > lastSeenAt) lastSeenAt = e.receivedAt;
  }

  const uniqueUserIds = [...userIds];
  const exampleMessages = [...new Set(eventDocs.map((d) => d.errorMessage))].slice(0, 3);
  const centroid = await computeCentroid(remainingEventIds);

  // deno-lint-ignore no-explicit-any
  await (groups as any).updateOne(
    { _id: groupOid },
    {
      $set: {
        eventIds: remainingEventIds,
        eventCount: remainingEventIds.length,
        uniqueUserIds,
        uniqueUserCount: uniqueUserIds.length,
        eventsWithNoUserId: noUserId,
        releaseStages: [...stages],
        firstSeenAt: firstSeenAt ?? group.firstSeenAt,
        lastSeenAt: lastSeenAt ?? group.lastSeenAt,
        exampleMessages,
        centroidEmbedding: centroid,
        centroidUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
      $pull: { mergeHistory: { absorbedGroupId: absorbedOid } },
    },
  );

  return json({ success: true });
}
