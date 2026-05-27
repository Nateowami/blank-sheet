import {
  eventsCollection,
  groupsCollection,
  ObjectId,
  type EventDoc,
  type GroupDoc,
  type StackFrame,
} from "../db/mongo.ts";
import { config } from "../config.ts";
import { matchesTemplate } from "./templates.ts";
import {
  getOrComputeEventEmbedding,
  computeCentroid,
  cosineSimilarity,
} from "./embeddings.ts";
import { extractTemplate, detectPII } from "../llm/client.ts";
import { generateMergeSuggestions } from "./suggestions.ts";

// ─── Group metadata helpers ────────────────────────────────────────────────────

async function buildGroupMetadata(
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

  const exampleMessages = [
    ...new Set(docs.map((d) => d.errorMessage)),
  ].slice(0, 3);

  const representativeStacktrace = mostCommonStacktrace(docs);
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
    representativeStacktrace,
  };
}

function mostCommonStacktrace(events: EventDoc[]): StackFrame[] {
  // Hash each stacktrace by its top frames
  const freq = new Map<string, { count: number; stacktrace: StackFrame[] }>();
  for (const e of events) {
    const key = e.stacktrace
      .slice(0, 5)
      .map((f) => `${f.file}:${f.lineNumber}`)
      .join("|");
    const entry = freq.get(key);
    if (entry) entry.count++;
    else freq.set(key, { count: 1, stacktrace: e.stacktrace });
  }
  let best: { count: number; stacktrace: StackFrame[] } | null = null;
  for (const v of freq.values()) {
    if (!best || v.count > best.count) best = v;
  }
  return best?.stacktrace ?? [];
}

// ─── Create new group ──────────────────────────────────────────────────────────

async function createGroup(event: EventDoc, embedding: number[]): Promise<GroupDoc> {
  const groups = await groupsCollection();
  const now = new Date();
  const meta = await buildGroupMetadata([event._id]);

  const doc: GroupDoc = {
    _id: new ObjectId(),
    createdAt: now,
    updatedAt: now,
    status: "active",
    mergedIntoGroupId: null,
    template: null,
    templateExtractedAt: null,
    templateAttemptedAt: null,
    centroidEmbedding: embedding,
    centroidUpdatedAt: now,
    mergeHistory: [],
    hasPII: null,
    ...meta,
  } as GroupDoc;

  await groups.insertOne(doc);
  return doc;
}

// ─── Add event to group ────────────────────────────────────────────────────────

async function addEventToGroup(
  groupId: ObjectId,
  event: EventDoc,
  newCentroid: number[],
): Promise<void> {
  const groups = await groupsCollection();
  const group = await groups.findOne({ _id: groupId });
  if (!group) return;

  const updatedEventIds = [...group.eventIds, event._id];
  const meta = await buildGroupMetadata(updatedEventIds);

  await groups.updateOne(
    { _id: groupId },
    {
      $set: {
        ...meta,
        centroidEmbedding: newCentroid,
        centroidUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
}

// ─── Template extraction ───────────────────────────────────────────────────────

const ONE_HOUR = 60 * 60 * 1000;

async function runTemplateExtraction(groups: GroupDoc[]): Promise<boolean> {
  const groupsCol = await groupsCollection();
  let anyNewTemplate = false;

  const { templateExtractionMinEvents } = config.grouping;
  const now = Date.now();

  const candidates = groups.filter(
    (g) =>
      g.template === null &&
      g.eventCount >= templateExtractionMinEvents &&
      (g.templateAttemptedAt === null ||
        now - g.templateAttemptedAt.getTime() > ONE_HOUR),
  );

  for (const group of candidates) {
    const events = await eventsCollection();
    const sampleDocs = await events
      .find({ _id: { $in: group.eventIds } })
      .limit(10)
      .toArray();

    const messages = sampleDocs.map((e) => e.errorMessage);
    console.log(`[pipeline] Extracting template for group ${group._id}…`);

    let template: string | null = null;
    try {
      template = await extractTemplate(messages);
    } catch (err) {
      console.error(`[pipeline] Template extraction failed:`, err);
    }

    const now2 = new Date();
    if (template) {
      await groupsCol.updateOne(
        { _id: group._id },
        {
          $set: {
            template,
            templateExtractedAt: now2,
            templateAttemptedAt: now2,
            updatedAt: now2,
          },
        },
      );
      console.log(`[pipeline] Template extracted: "${template}"`);
      anyNewTemplate = true;
    } else {
      await groupsCol.updateOne(
        { _id: group._id },
        { $set: { templateAttemptedAt: now2 } },
      );
    }
  }

  return anyNewTemplate;
}

// ─── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Full grouping pipeline for a set of newly ingested event IDs.
 */
export async function runGroupingPipeline(newEventIds: ObjectId[]): Promise<void> {
  const eventsCol = await eventsCollection();
  const groupsCol = await groupsCollection();

  const newEvents = await eventsCol
    .find({ _id: { $in: newEventIds } })
    .toArray();

  // Working set of events still needing group assignment
  let remaining = [...newEvents];

  // ── Step 1: Normalized message exact match ────────────────────────────────
  console.log("[pipeline] Step 1: Normalized message exact match…");
  const activeGroups = await groupsCol.find({ status: "active" }).toArray();

  // Build a map of normalizedMessage → group
  const normMsgToGroup = new Map<string, GroupDoc>();
  for (const g of activeGroups) {
    const memberEvents = await eventsCol
      .find({ _id: { $in: g.eventIds } })
      .project<{ normalizedMessage: string }>({ normalizedMessage: 1 })
      .toArray();
    for (const e of memberEvents) {
      if (!normMsgToGroup.has(e.normalizedMessage)) {
        normMsgToGroup.set(e.normalizedMessage, g);
      }
    }
  }

  const matched1: EventDoc[] = [];
  const groupUpdatesStep1 = new Map<string, { group: GroupDoc; events: EventDoc[] }>();

  for (const event of remaining) {
    const matchedGroup = normMsgToGroup.get(event.normalizedMessage);
    if (matchedGroup) {
      const key = matchedGroup._id.toString();
      if (!groupUpdatesStep1.has(key)) {
        groupUpdatesStep1.set(key, { group: matchedGroup, events: [] });
      }
      groupUpdatesStep1.get(key)!.events.push(event);
      matched1.push(event);
    }
  }

  for (const { group, events } of groupUpdatesStep1.values()) {
    const allIds = [...group.eventIds, ...events.map((e) => e._id)];
    const meta = await buildGroupMetadata(allIds);
    await groupsCol.updateOne(
      { _id: group._id },
      { $set: { ...meta, updatedAt: new Date() } },
    );
  }

  remaining = remaining.filter(
    (e) => !matched1.find((m) => m._id.equals(e._id)),
  );
  console.log(
    `[pipeline] Step 1: ${matched1.length} matched, ${remaining.length} remaining.`,
  );

  // ── Step 2: Template match ─────────────────────────────────────────────────
  console.log("[pipeline] Step 2: Template match…");
  const groupsWithTemplates = activeGroups.filter((g) => g.template !== null);
  const matched2: EventDoc[] = [];
  const groupUpdatesStep2 = new Map<string, { group: GroupDoc; events: EventDoc[] }>();

  for (const event of remaining) {
    for (const group of groupsWithTemplates) {
      if (matchesTemplate(group.template!, event.errorMessage)) {
        const key = group._id.toString();
        if (!groupUpdatesStep2.has(key)) {
          groupUpdatesStep2.set(key, { group, events: [] });
        }
        groupUpdatesStep2.get(key)!.events.push(event);
        matched2.push(event);
        break;
      }
    }
  }

  for (const { group, events } of groupUpdatesStep2.values()) {
    const allIds = [...group.eventIds, ...events.map((e) => e._id)];
    const meta = await buildGroupMetadata(allIds);
    await groupsCol.updateOne(
      { _id: group._id },
      { $set: { ...meta, updatedAt: new Date() } },
    );
  }

  remaining = remaining.filter(
    (e) => !matched2.find((m) => m._id.equals(e._id)),
  );
  console.log(
    `[pipeline] Step 2: ${matched2.length} matched, ${remaining.length} remaining.`,
  );

  // ── Step 3: Embedding similarity ───────────────────────────────────────────
  console.log("[pipeline] Step 3: Embedding similarity…");
  const { embeddingSimilarityAutoMergeThreshold, embeddingSimilarityLLMCandidateThreshold } =
    config.grouping;

  // Refresh active groups list after step 1 & 2 updates
  const activeGroupsStep3 = await groupsCol.find({ status: "active" }).toArray();

  const llmCandidates: Array<{
    eventGroupId: ObjectId;
    candidateGroupId: ObjectId;
    similarity: number;
  }> = [];

  const newGroups: GroupDoc[] = [];

  // One embedding cache per pipeline run: avoids calling the model more than
  // once for events that share the same normalizedMessage.
  const messageEmbeddingCache = new Map<string, number[]>();

  for (const event of remaining) {
    let embedding: number[];
    try {
      embedding = await getOrComputeEventEmbedding(event, messageEmbeddingCache);
    } catch (err) {
      console.error(`[pipeline] Embedding failed for event ${event._id}:`, err);
      continue;
    }

    let bestGroup: GroupDoc | null = null;
    let bestSimilarity = -1;

    for (const group of activeGroupsStep3) {
      if (group.centroidEmbedding.length === 0) continue;
      const sim = cosineSimilarity(embedding, group.centroidEmbedding);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestGroup = group;
      }
    }

    if (bestSimilarity >= embeddingSimilarityAutoMergeThreshold && bestGroup) {
      // Compute new centroid incrementally
      const allIds = [...bestGroup.eventIds, event._id];
      const newCentroid = await computeCentroid(allIds);
      await addEventToGroup(bestGroup._id, event, newCentroid);
      // Update in-memory group for subsequent events
      bestGroup.eventIds.push(event._id);
      bestGroup.centroidEmbedding = newCentroid;
    } else if (bestSimilarity >= embeddingSimilarityLLMCandidateThreshold && bestGroup) {
      // Event doesn't auto-merge but is similar enough to warrant LLM review.
      // Put the event in its own new group, then flag (newGroup, candidateGroup) for LLM.
      const newGroup = await createGroup(event, embedding);
      activeGroupsStep3.push(newGroup);
      newGroups.push(newGroup);

      llmCandidates.push({
        eventGroupId: newGroup._id,
        candidateGroupId: bestGroup._id,
        similarity: bestSimilarity,
      });
    } else {
      // Create a new group
      const newGroup = await createGroup(event, embedding);
      activeGroupsStep3.push(newGroup);
      newGroups.push(newGroup);
    }
  }

  console.log(
    `[pipeline] Step 3: ${llmCandidates.length} LLM candidates, ${newGroups.length} new groups created.`,
  );

  // ── Steps 4 & 5: Template extraction loop ─────────────────────────────────
  console.log("[pipeline] Steps 4-5: Template extraction loop…");
  let iteration = 0;
  let anyNewTemplates = true;

  while (anyNewTemplates) {
    iteration++;
    console.log(`[pipeline] Template extraction iteration ${iteration}…`);
    const allActiveGroups = await groupsCol.find({ status: "active" }).toArray();
    anyNewTemplates = await runTemplateExtraction(allActiveGroups);

    if (anyNewTemplates) {
      // Feedback loop: re-run template matching on untemplate-matched groups
      console.log("[pipeline] New templates produced — running feedback loop…");
      const updatedGroups = await groupsCol.find({ status: "active" }).toArray();
      const templatedGroups = updatedGroups.filter((g) => g.template !== null);
      const untemplatedGroups = updatedGroups.filter(
        (g) => g.template === null && g.eventCount === 1,
      );

      for (const group of untemplatedGroups) {
        const singletonEvent = await eventsCol.findOne({
          _id: group.eventIds[0],
        });
        if (!singletonEvent) continue;

        for (const tGroup of templatedGroups) {
          if (tGroup._id.equals(group._id)) continue;
          if (matchesTemplate(tGroup.template!, singletonEvent.errorMessage)) {
            // Absorb singleton group into template group
            const allIds = [...tGroup.eventIds, ...group.eventIds];
            const meta = await buildGroupMetadata(allIds);
            await groupsCol.updateOne(
              { _id: tGroup._id },
              { $set: { ...meta, updatedAt: new Date() } },
            );
            await groupsCol.updateOne(
              { _id: group._id },
              { $set: { status: "merged_away", mergedIntoGroupId: tGroup._id } },
            );
            break;
          }
        }
      }
    }
  }

  // ── Step 6: LLM merge suggestion queue ────────────────────────────────────
  if (llmCandidates.length > 0) {
    console.log(`[pipeline] Step 6: Generating ${llmCandidates.length} LLM merge suggestions…`);
    await generateMergeSuggestions(llmCandidates);
  }

  // ── PII detection (async, non-blocking) ───────────────────────────────────
  const groupsForPII = await groupsCol
    .find({ status: "active", hasPII: null, eventCount: { $gte: 5 } })
    .toArray();

  if (groupsForPII.length > 0) {
    console.log(`[pipeline] Running PII detection on ${groupsForPII.length} groups…`);
    // Fire and forget
    (async () => {
      for (const group of groupsForPII) {
        try {
          const result = await detectPII(group.exampleMessages);
          await groupsCol.updateOne(
            { _id: group._id },
            { $set: { hasPII: result.has_pii } },
          );
        } catch (err) {
          console.error(`[pipeline] PII detection failed for group ${group._id}:`, err);
        }
      }
    })();
  }

  console.log("[pipeline] Grouping pipeline complete.");
}
