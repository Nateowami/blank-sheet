import {
  groupsCollection,
  mergeSuggestionsCollection,
  ObjectId,
} from "../db/mongo.ts";
import { arbiterMerge } from "../llm/client.ts";

/**
 * For each (event, group) LLM candidate pair, generate merge suggestions.
 * Deduplicates to (group A id, group B id) pairs before querying LLM.
 */
export async function generateMergeSuggestions(
  candidates: Array<{ eventGroupId: ObjectId; candidateGroupId: ObjectId; similarity: number }>,
): Promise<void> {
  if (candidates.length === 0) return;

  const groups = await groupsCollection();
  const suggestions = await mergeSuggestionsCollection();

  // Deduplicate to unique (groupA, groupB) pairs, keep highest similarity
  const pairMap = new Map<string, { a: ObjectId; b: ObjectId; similarity: number }>();
  for (const c of candidates) {
    const [a, b] = [c.eventGroupId.toString(), c.candidateGroupId.toString()].sort();
    const key = `${a}:${b}`;
    const existing = pairMap.get(key);
    if (!existing || c.similarity > existing.similarity) {
      pairMap.set(key, {
        a: new ObjectId(a),
        b: new ObjectId(b),
        similarity: c.similarity,
      });
    }
  }

  for (const { a, b, similarity } of pairMap.values()) {
    // Skip if suggestion already exists between these groups
    const existing = await suggestions.findOne({
      $or: [
        { groupIdA: a, groupIdB: b },
        { groupIdA: b, groupIdB: a },
      ],
    });
    if (existing) continue;

    const [groupA, groupB] = await Promise.all([
      groups.findOne({ _id: a }),
      groups.findOne({ _id: b }),
    ]);
    if (!groupA || !groupB) continue;
    if (groupA.status !== "active" || groupB.status !== "active") continue;

    let result;
    try {
      result = await arbiterMerge(groupA, groupB);
    } catch (err) {
      console.error(`[suggestions] LLM arbiter failed for ${a} / ${b}:`, err);
      continue;
    }

    await suggestions.insertOne({
      _id: new ObjectId(),
      createdAt: new Date(),
      status: "pending",
      resolvedAt: null,
      groupIdA: a,
      groupIdB: b,
      similarityScore: similarity,
      llmReasoning: result.reasoning,
      llmConfidence: result.confidence,
    });

    console.log(
      `[suggestions] Suggestion created: merge=${result.should_merge}, confidence=${result.confidence}`,
    );
  }
}
