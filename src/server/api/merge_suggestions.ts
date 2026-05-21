import {
  groupsCollection,
  eventsCollection,
  mergeSuggestionsCollection,
  ObjectId,
  type GroupDoc,
} from "../../db/mongo.ts";
import { computeCentroid } from "../../grouping/embeddings.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── List pending suggestions ──────────────────────────────────────────────────

export async function handleListSuggestions(_req: Request): Promise<Response> {
  const suggestions = await mergeSuggestionsCollection();
  const groups = await groupsCollection();

  const pending = await suggestions.find({ status: "pending" }).sort({ createdAt: -1 }).toArray();

  const result = await Promise.all(
    pending.map(async (s) => {
      const [gA, gB] = await Promise.all([
        groups.findOne({ _id: s.groupIdA }),
        groups.findOne({ _id: s.groupIdB }),
      ]);
      return {
        _id: s._id,
        createdAt: s.createdAt,
        similarityScore: s.similarityScore,
        llmReasoning: s.llmReasoning,
        llmConfidence: s.llmConfidence,
        groupA: gA
          ? {
              _id: gA._id,
              label: gA.template ?? gA.exampleMessages[0] ?? "Unknown",
              eventCount: gA.eventCount,
            }
          : null,
        groupB: gB
          ? {
              _id: gB._id,
              label: gB.template ?? gB.exampleMessages[0] ?? "Unknown",
              eventCount: gB.eventCount,
            }
          : null,
      };
    }),
  );

  return json(result);
}

// ─── Accept suggestion ─────────────────────────────────────────────────────────

export async function handleAcceptSuggestion(
  _req: Request,
  id: string,
): Promise<Response> {
  const suggestions = await mergeSuggestionsCollection();
  const groups = await groupsCollection();

  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return json({ error: "Invalid ID" }, 400);
  }

  const suggestion = await suggestions.findOne({ _id: oid });
  if (!suggestion) return json({ error: "Not found" }, 404);
  if (suggestion.status !== "pending") {
    return json({ error: "Suggestion already resolved" }, 400);
  }

  const [groupA, groupB] = await Promise.all([
    groups.findOne({ _id: suggestion.groupIdA }),
    groups.findOne({ _id: suggestion.groupIdB }),
  ]);

  if (!groupA || !groupB) return json({ error: "Groups not found" }, 404);
  if (groupA.status !== "active" || groupB.status !== "active") {
    return json({ error: "One or both groups are no longer active" }, 400);
  }

  await executeMerge(groupA, groupB, "llm_suggestion", suggestion.llmReasoning);

  await suggestions.updateOne(
    { _id: oid },
    { $set: { status: "accepted", resolvedAt: new Date() } },
  );

  return json({ success: true });
}

// ─── Reject suggestion ─────────────────────────────────────────────────────────

export async function handleRejectSuggestion(
  _req: Request,
  id: string,
): Promise<Response> {
  const suggestions = await mergeSuggestionsCollection();
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return json({ error: "Invalid ID" }, 400);
  }

  const suggestion = await suggestions.findOne({ _id: oid });
  if (!suggestion) return json({ error: "Not found" }, 404);

  await suggestions.updateOne(
    { _id: oid },
    { $set: { status: "rejected", resolvedAt: new Date() } },
  );

  return json({ success: true });
}

// ─── Merge execution ───────────────────────────────────────────────────────────

async function buildGroupMetadataFromDocs(
  eventIds: ObjectId[],
): Promise<Partial<GroupDoc>> {
  const events = await eventsCollection();
  const docs = await events.find({ _id: { $in: eventIds } }).toArray();

  const userIds = new Set<string>();
  let noUserId = 0;
  const stages = new Set<string>();
  let firstSeenAt: Date | null = null;
  let lastSeenAt: Date | null = null;

  for (const e of docs) {
    if (e.user?.id) userIds.add(e.user.id);
    else noUserId++;
    stages.add(e.releaseStage);
    if (!firstSeenAt || e.receivedAt < firstSeenAt) firstSeenAt = e.receivedAt;
    if (!lastSeenAt || e.receivedAt > lastSeenAt) lastSeenAt = e.receivedAt;
  }

  const exampleMessages = [...new Set(docs.map((d) => d.errorMessage))].slice(0, 3);
  const uniqueUserIds = [...userIds];

  return {
    eventIds,
    eventCount: eventIds.length,
    uniqueUserIds,
    uniqueUserCount: uniqueUserIds.length,
    eventsWithNoUserId: noUserId,
    releaseStages: [...stages],
    firstSeenAt: firstSeenAt ?? new Date(),
    lastSeenAt: lastSeenAt ?? new Date(),
    exampleMessages,
  };
}

export async function executeMerge(
  groupA: GroupDoc,
  groupB: GroupDoc,
  triggeredBy: "llm_suggestion" | "human",
  llmReasoning: string | null,
): Promise<void> {
  const groups = await groupsCollection();

  // Snapshot of groupB before merge
  // deno-lint-ignore no-explicit-any
  const snapshot = { ...groupB } as any;

  const mergeRecord: MergeRecord = {
    mergedAt: new Date(),
    absorbedGroupId: groupB._id,
    absorbedGroupSnapshot: snapshot,
    triggeredBy,
    llmReasoning,
    acceptedBy: "human",
  };

  const allEventIds = [...groupA.eventIds, ...groupB.eventIds];
  const meta = await buildGroupMetadataFromDocs(allEventIds);
  const centroid = await computeCentroid(allEventIds);

  // deno-lint-ignore no-explicit-any
  await (groups as any).updateOne(
    { _id: groupA._id },
    {
      $set: {
        ...meta,
        centroidEmbedding: centroid,
        centroidUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
      $push: { mergeHistory: mergeRecord },
    },
  );

  await groups.updateOne(
    { _id: groupB._id },
    {
      $set: {
        status: "merged_away",
        mergedIntoGroupId: groupA._id,
        updatedAt: new Date(),
      },
    },
  );
}
