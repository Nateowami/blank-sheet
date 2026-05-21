import { getEmbedding } from "../llm/client.ts";
import {
  eventEmbeddingsCollection,
  groupsCollection,
  type EventDoc,
  type GroupDoc,
  ObjectId,
} from "../db/mongo.ts";

// ─── Cosine similarity ─────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Event embedding storage ───────────────────────────────────────────────────

/**
 * Get (or compute and store) the embedding for a single event.
 */
export async function getOrComputeEventEmbedding(
  event: EventDoc,
): Promise<number[]> {
  const col = await eventEmbeddingsCollection();
  const existing = await col.findOne({ eventId: event._id });
  if (existing) return existing.embedding;

  const embedding = await getEmbedding(event.normalizedMessage);
  await col.insertOne({
    _id: new ObjectId(),
    eventId: event._id,
    embedding,
    computedAt: new Date(),
  });
  return embedding;
}

// ─── Centroid computation ──────────────────────────────────────────────────────

/**
 * Compute the centroid (mean) embedding for all events in a group.
 */
export async function computeCentroid(eventIds: ObjectId[]): Promise<number[]> {
  if (eventIds.length === 0) return [];

  const col = await eventEmbeddingsCollection();
  const docs = await col
    .find({ eventId: { $in: eventIds } })
    .toArray();

  if (docs.length === 0) return [];

  const dim = docs[0].embedding.length;
  const sum = new Array<number>(dim).fill(0);
  for (const doc of docs) {
    for (let i = 0; i < dim; i++) {
      sum[i] += doc.embedding[i];
    }
  }
  return sum.map((v) => v / docs.length);
}

// ─── Update group centroid in DB ───────────────────────────────────────────────

export async function updateGroupCentroid(groupId: ObjectId): Promise<void> {
  const groups = await groupsCollection();
  const group = await groups.findOne({ _id: groupId });
  if (!group) return;

  const centroid = await computeCentroid(group.eventIds);
  if (centroid.length === 0) return;

  await groups.updateOne(
    { _id: groupId },
    { $set: { centroidEmbedding: centroid, centroidUpdatedAt: new Date() } },
  );
}
