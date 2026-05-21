import { config } from "../config.ts";
import {
  eventsCollection,
  ingestionStateCollection,
  ObjectId,
  type EventDoc,
} from "../db/mongo.ts";
import { fetchEventsSince, extractFirstException, type BugsnagEvent } from "./bugsnag.ts";
import { normalizeMessage } from "../grouping/normalize.ts";
import { runGroupingPipeline } from "../grouping/pipeline.ts";

export async function runIngest(): Promise<void> {
  const projectId = config.bugsnag.projectId;
  console.log(`[ingest] Starting ingest for project ${projectId}`);

  // Load ingestion state
  const stateCol = await ingestionStateCollection();
  let state = await stateCol.findOne({ projectId });
  const since = state?.lastIngestedAt ?? new Date(0);
  console.log(`[ingest] Fetching events since ${since.toISOString()}`);

  const events = await eventsCollection();
  const newEventIds: ObjectId[] = [];
  let totalFetched = 0;
  let totalInserted = 0;
  let latestReceivedAt = since;

  for await (const page of fetchEventsSince(projectId, since)) {
    totalFetched += page.length;
    for (const rawEvent of page) {
      // Deduplication guard
      const exists = await events.findOne({ bugsnagId: rawEvent.id });
      if (exists) continue;

      const { errorClass, errorMessage, stacktrace } = extractFirstException(rawEvent);
      const normalizedMessage = normalizeMessage(errorMessage);
      const receivedAt = new Date(rawEvent.received_at);
      const releaseStage = rawEvent.release_stage ?? rawEvent.app?.release_stage ?? "unknown";

      const doc: EventDoc = {
        _id: new ObjectId(),
        bugsnagId: rawEvent.id,
        projectId,
        receivedAt,
        ingestedAt: new Date(),
        releaseStage,
        errorClass,
        errorMessage,
        normalizedMessage,
        stacktrace,
        user: rawEvent.user?.id ? { id: rawEvent.user.id } : null,
        metadata: rawEvent.metaData ?? {},
        hasPII: null,
      };

      await events.insertOne(doc);
      newEventIds.push(doc._id);
      totalInserted++;

      if (receivedAt > latestReceivedAt) {
        latestReceivedAt = receivedAt;
      }
    }
    console.log(
      `[ingest] Fetched ${totalFetched} events, inserted ${totalInserted} so far…`,
    );
  }

  console.log(
    `[ingest] Done fetching. Inserted ${totalInserted} new events out of ${totalFetched} fetched.`,
  );

  // Update ingestion state
  const now = new Date();
  if (state) {
    await stateCol.updateOne(
      { projectId },
      {
        $set: {
          lastIngestedAt: latestReceivedAt,
          lastIngestRunAt: now,
          totalEventsIngested: (state.totalEventsIngested ?? 0) + totalInserted,
        },
      },
    );
  } else {
    await stateCol.insertOne({
      _id: new ObjectId(),
      projectId,
      lastIngestedAt: latestReceivedAt,
      lastIngestRunAt: now,
      totalEventsIngested: totalInserted,
    });
  }

  if (newEventIds.length === 0) {
    console.log("[ingest] No new events — skipping grouping pipeline.");
    return;
  }

  // Run grouping pipeline on newly ingested events
  console.log(`[ingest] Running grouping pipeline on ${newEventIds.length} new events…`);
  await runGroupingPipeline(newEventIds);
  console.log("[ingest] Grouping pipeline complete.");
}
