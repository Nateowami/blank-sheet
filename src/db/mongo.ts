import { MongoClient, Collection, ObjectId, Db } from "mongodb";
import { config, env } from "../config.ts";

// ─── Shared types ─────────────────────────────────────────────────────────────

export type { ObjectId };

export interface StackFrame {
  file: string;
  lineNumber: number;
  columnNumber: number;
  method: string;
  inProject: boolean;
  code: Record<string, string> | null;
}

// ─── Collection documents ─────────────────────────────────────────────────────

export interface EventDoc {
  _id: ObjectId;
  bugsnagId: string;
  projectId: string;
  receivedAt: Date;
  ingestedAt: Date;
  releaseStage: string;
  errorClass: string;
  errorMessage: string;
  normalizedMessage: string;
  stacktrace: StackFrame[];
  user: { id: string } | null;
  metadata: Record<string, unknown>;
  hasPII: boolean | null;
}

export interface MergeRecord {
  mergedAt: Date;
  absorbedGroupId: ObjectId;
  absorbedGroupSnapshot: Record<string, unknown>;
  triggeredBy: "llm_suggestion" | "human";
  llmReasoning: string | null;
  acceptedBy: "human";
}

export interface GroupDoc {
  _id: ObjectId;
  createdAt: Date;
  updatedAt: Date;
  status: "active" | "merged_away";
  mergedIntoGroupId: ObjectId | null;
  template: string | null;
  templateExtractedAt: Date | null;
  templateAttemptedAt: Date | null; // last attempt (for backoff)
  centroidEmbedding: number[];
  centroidUpdatedAt: Date;
  eventIds: ObjectId[];
  eventCount: number;
  uniqueUserIds: string[];
  uniqueUserCount: number;
  eventsWithNoUserId: number;
  representativeStacktrace: StackFrame[];
  exampleMessages: string[];
  releaseStages: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  hasPII: boolean | null;
  mergeHistory: MergeRecord[];
}

export interface MergeSuggestionDoc {
  _id: ObjectId;
  createdAt: Date;
  status: "pending" | "accepted" | "rejected";
  resolvedAt: Date | null;
  groupIdA: ObjectId;
  groupIdB: ObjectId;
  similarityScore: number;
  llmReasoning: string;
  llmConfidence: "high" | "medium" | "low";
}

export interface IngestionStateDoc {
  _id: ObjectId;
  projectId: string;
  lastIngestedAt: Date;
  lastIngestRunAt: Date;
  totalEventsIngested: number;
}

export interface EventEmbeddingDoc {
  _id: ObjectId;
  eventId: ObjectId;
  embedding: number[];
  computedAt: Date;
}

// ─── Connection singleton ──────────────────────────────────────────────────────

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (!_db) {
    _client = new MongoClient(env.mongoUri);
    await _client.connect();
    _db = _client.db(config.mongo.database);
    await createIndexes(_db);
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
  }
}

async function createIndexes(db: Db): Promise<void> {
  const events = db.collection("events");
  await events.createIndex({ bugsnagId: 1 }, { unique: true });
  await events.createIndex({ projectId: 1, receivedAt: -1 });
  await events.createIndex({ normalizedMessage: 1 });

  const groups = db.collection("groups");
  await groups.createIndex({ status: 1 });
  await groups.createIndex({ eventCount: -1 });
  await groups.createIndex({ lastSeenAt: -1 });

  const suggestions = db.collection("merge_suggestions");
  await suggestions.createIndex({ status: 1 });
  await suggestions.createIndex({ groupIdA: 1, groupIdB: 1 });

  const ingestionState = db.collection("ingestion_state");
  await ingestionState.createIndex({ projectId: 1 }, { unique: true });

  const embeddings = db.collection("event_embeddings");
  await embeddings.createIndex({ eventId: 1 }, { unique: true });
}

// ─── Collection accessors ─────────────────────────────────────────────────────

export async function eventsCollection(): Promise<Collection<EventDoc>> {
  const db = await getDb();
  return db.collection<EventDoc>("events");
}

export async function groupsCollection(): Promise<Collection<GroupDoc>> {
  const db = await getDb();
  return db.collection<GroupDoc>("groups");
}

export async function mergeSuggestionsCollection(): Promise<
  Collection<MergeSuggestionDoc>
> {
  const db = await getDb();
  return db.collection<MergeSuggestionDoc>("merge_suggestions");
}

export async function ingestionStateCollection(): Promise<
  Collection<IngestionStateDoc>
> {
  const db = await getDb();
  return db.collection<IngestionStateDoc>("ingestion_state");
}

export async function eventEmbeddingsCollection(): Promise<
  Collection<EventEmbeddingDoc>
> {
  const db = await getDb();
  return db.collection<EventEmbeddingDoc>("event_embeddings");
}
