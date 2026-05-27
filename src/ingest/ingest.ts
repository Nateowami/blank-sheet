import { config } from "../config.ts";
import {
  eventsCollection,
  rawEventsCollection,
  groupsCollection,
  ingestionStateCollection,
  ObjectId,
  type EventDoc,
  type RawEventDoc,
} from "../db/mongo.ts";
import { fetchEventsSince, extractFirstException } from "./bugsnag.ts";
import { normalizeMessage } from "../grouping/normalize.ts";
import { runGroupingPipeline } from "../grouping/pipeline.ts";

export async function runIngest(): Promise<void> {
  const projectId = config.bugsnag.projectId;
  console.log(`[ingest] Starting ingest for project ${projectId}`);

  // Load ingestion state
  const stateCol = await ingestionStateCollection();
  let state = await stateCol.findOne({ projectId });

  // If a previous run was interrupted, resume from the same `since` so we
  // re-fetch (and dedup) already-stored pages and then continue where we left
  // off. Otherwise start from the last completed cursor (or epoch for a fresh
  // install).
  const since = state?.inProgressSince ?? state?.lastIngestedAt ?? new Date(0);
  console.log(`[ingest] Fetching events since ${since.toISOString()}`);

  // Mark this run as in-progress before fetching anything.
  const runStartedAt = new Date();
  if (state) {
    if (!state.inProgressSince) {
      await stateCol.updateOne(
        { projectId },
        { $set: { inProgressSince: since, lastIngestRunAt: runStartedAt } },
      );
    }
  } else {
    await stateCol.insertOne({
      _id: new ObjectId(),
      projectId,
      lastIngestedAt: since,
      lastIngestRunAt: runStartedAt,
      totalEventsIngested: 0,
      inProgressSince: since,
    });
    state = await stateCol.findOne({ projectId });
  }

  const rawEvents = await rawEventsCollection();
  const events = await eventsCollection();
  const newEventIds: ObjectId[] = [];
  let totalFetched = 0;
  let totalInserted = 0;
  // Track the newest receivedAt seen across ALL events (including already-stored
  // ones) so that latestReceivedAt is correct even when early pages are fully
  // deduped during a resumed run.
  let latestReceivedAt = since;

  for await (const page of fetchEventsSince(projectId, since)) {
    totalFetched += page.length;
    let insertedThisPage = 0;
    for (const rawEvent of page) {
      const receivedAt = new Date(rawEvent.received_at);

      // Update the newest-seen cursor regardless of whether we insert this event.
      if (receivedAt > latestReceivedAt) {
        latestReceivedAt = receivedAt;
      }

      // Deduplication guard — check raw events collection by Bugsnag's own ID.
      const exists = await rawEvents.findOne({ id: rawEvent.id });
      if (exists) continue;

      // Use the same ObjectId for both the raw event and its derived metadata so
      // that the grouping pipeline's eventId references work across collections.
      const oid = new ObjectId();

      // 1. Store the raw Bugsnag event verbatim.
      await rawEvents.insertOne({
        _id: oid,
        ingestedAt: new Date(),
        ...(rawEvent as Record<string, unknown>),
      } as RawEventDoc);

      // 2. Store derived metadata for the grouping pipeline.
      const { errorClass, errorMessage, stacktrace } = extractFirstException(rawEvent);
      const normalizedMessage = normalizeMessage(errorMessage);
      const releaseStage = rawEvent.app?.releaseStage ?? rawEvent.release_stage ?? "unknown";

      const doc: EventDoc = {
        _id: oid,
        bugsnagId: rawEvent.id,
        projectId,
        receivedAt,
        releaseStage,
        errorClass,
        errorMessage,
        normalizedMessage,
        stacktrace,
        user: rawEvent.user?.id ? { id: rawEvent.user.id } : null,
        hasPII: null,
      };

      await events.insertOne(doc);
      newEventIds.push(oid);
      totalInserted++;
      insertedThisPage++;
    }

    // Persist the insertion count after each page so progress is visible even
    // during long runs. We intentionally do NOT update lastIngestedAt here —
    // that cursor is only advanced once the full run completes so that a
    // crashed/resumed run can always restart from the correct point.
    if (insertedThisPage > 0) {
      await stateCol.updateOne(
        { projectId },
        { $inc: { totalEventsIngested: insertedThisPage } },
      );
    }

    console.log(
      `[ingest] Fetched ${totalFetched} events, inserted ${totalInserted} so far…`,
    );
  }

  console.log(
    `[ingest] Done fetching. Inserted ${totalInserted} new events out of ${totalFetched} fetched.`,
  );

  // Mark run complete: advance the cursor and clear the in-progress marker.
  await stateCol.updateOne(
    { projectId },
    {
      $set: { lastIngestedAt: latestReceivedAt, lastIngestRunAt: new Date() },
      $unset: { inProgressSince: "" },
    },
  );

  if (newEventIds.length === 0) {
    // No new events this run. Check if any previously ingested events were never
    // processed by the grouping pipeline (e.g. because a prior run failed).
    console.log("[ingest] No new events — checking for ungrouped events…");

    const groupsCol = await groupsCollection();
    const allGroups = await groupsCol.find({}, { projection: { eventIds: 1 } }).toArray();
    const groupedIdSet = new Set<string>(
      allGroups.flatMap((g) => g.eventIds.map((id) => id.toString())),
    );

    const allEvents = await events.find({}, { projection: { _id: 1 } }).toArray();
    const ungroupedIds = allEvents
      .filter((e) => !groupedIdSet.has(e._id.toString()))
      .map((e) => e._id);

    if (ungroupedIds.length === 0) {
      console.log("[ingest] All events already grouped — nothing to do.");
      return;
    }

    console.log(`[ingest] Found ${ungroupedIds.length} ungrouped events — running grouping pipeline…`);
    await runGroupingPipeline(ungroupedIds);
    console.log("[ingest] Grouping pipeline complete.");
    return;
  }

  // Run grouping pipeline on newly ingested events
  console.log(`[ingest] Running grouping pipeline on ${newEventIds.length} new events…`);
  await runGroupingPipeline(newEventIds);
  console.log("[ingest] Grouping pipeline complete.");
}
