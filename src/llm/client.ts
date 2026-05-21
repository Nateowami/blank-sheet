import { config } from "../config.ts";

// ─── Concurrency-1 LLM Queue ───────────────────────────────────────────────────

type QueueTask<T> = () => Promise<T>;

interface QueueEntry<T> {
  task: QueueTask<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  label: string;
}

// deno-lint-ignore no-explicit-any
const queue: QueueEntry<any>[] = [];
let running = false;

async function drainQueue(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const entry = queue.shift()!;
    const start = Date.now();
    console.log(`[LLM] → ${entry.label}`);
    try {
      const result = await entry.task();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[LLM] ✓ ${entry.label} (${elapsed}s)`);
      entry.resolve(result);
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`[LLM] ✗ ${entry.label} (${elapsed}s)`, err);
      entry.reject(err);
    }
  }
  running = false;
}

function enqueue<T>(label: string, task: QueueTask<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ task, resolve, reject, label });
    drainQueue();
  });
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

async function llmPost<T>(
  path: string,
  body: unknown,
  label: string,
): Promise<T> {
  return enqueue(label, async () => {
    const url = `${config.llm.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM request failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  });
}

// ─── Embedding ─────────────────────────────────────────────────────────────────

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const resp = await llmPost<EmbeddingResponse>(
    "/embeddings",
    { model: config.llm.embeddingModel, input: text },
    `embed(${text.slice(0, 40)}…)`,
  );
  return resp.data[0].embedding;
}

// ─── Chat completion ───────────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  choices: Array<{ message: { content: string } }>;
}

export async function chatComplete(
  messages: ChatMessage[],
  label: string,
): Promise<string> {
  const resp = await llmPost<ChatResponse>(
    "/chat/completions",
    {
      model: config.llm.chatModel,
      messages,
      temperature: 0,
    },
    label,
  );
  return resp.choices[0].message.content.trim();
}

// ─── Template extraction ───────────────────────────────────────────────────────

export async function extractTemplate(
  messages: string[],
): Promise<string | null> {
  const prompt = `You are analyzing a set of error messages from the same error group to extract a template.

These are raw error messages from a production web application:
<messages>
${messages.map((m) => `- ${m}`).join("\n")}
</messages>

If these messages are all variations of the same underlying error (same code path, same type of failure, differing only in variable runtime data like user names, IDs, project names, object names, etc.), respond with a template string where each variable part is replaced with a {slot_name} placeholder. Choose descriptive slot names.

Example: "Error removing {username} from project {project_name}"

If these messages are NOT all variations of the same error, respond with exactly: null

Respond with only the template string or null. No explanation.`;

  const result = await chatComplete(
    [{ role: "user", content: prompt }],
    `extractTemplate(${messages.length} messages)`,
  );

  if (result === "null" || result.toLowerCase() === "null") return null;
  return result;
}

// ─── LLM merge arbiter ─────────────────────────────────────────────────────────

export interface MergeArbiterResult {
  should_merge: boolean;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

export async function arbiterMerge(
  groupA: {
    eventCount: number;
    firstSeenAt: Date;
    template: string | null;
    exampleMessages: string[];
    representativeStacktrace: Array<{ method: string; file: string; lineNumber: number }>;
  },
  groupB: {
    eventCount: number;
    firstSeenAt: Date;
    template: string | null;
    exampleMessages: string[];
    representativeStacktrace: Array<{ method: string; file: string; lineNumber: number }>;
  },
): Promise<MergeArbiterResult> {
  const formatGroup = (g: typeof groupA) => `
Template: ${g.template ?? "none"}
Example messages:
${g.exampleMessages.map((m) => `  - ${m}`).join("\n")}
Most common stacktrace:
${g.representativeStacktrace
  .slice(0, 10)
  .map((f) => `  at ${f.method} (${f.file}:${f.lineNumber})`)
  .join("\n")}`;

  const prompt = `You are deciding whether two error groups from a production web application represent the same underlying bug.

Group A (${groupA.eventCount} events, first seen ${groupA.firstSeenAt.toISOString()}):
${formatGroup(groupA)}

Group B (${groupB.eventCount} events, first seen ${groupB.firstSeenAt.toISOString()}):
${formatGroup(groupB)}

Should these two groups be merged into one? They should be merged if they represent the same bug — same code path, same failure mode, even if error messages differ superficially.

Respond in JSON only:
{
  "should_merge": true | false,
  "confidence": "high" | "medium" | "low",
  "reasoning": "one sentence explanation"
}`;

  const raw = await chatComplete(
    [{ role: "user", content: prompt }],
    `arbiterMerge`,
  );

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Unexpected LLM response: ${raw}`);
  return JSON.parse(jsonMatch[0]) as MergeArbiterResult;
}

// ─── PII detection ─────────────────────────────────────────────────────────────

export interface PIIResult {
  has_pii: boolean;
  reasoning: string;
}

export async function detectPII(exampleMessages: string[]): Promise<PIIResult> {
  const prompt = `You are reviewing error messages from a production web application for the presence of personally identifiable information (PII).

Example error messages from this error group:
${exampleMessages.map((m) => `- ${m}`).join("\n")}

Does any message contain PII such as real names, email addresses, phone numbers, physical addresses, government IDs, financial data, or health information?

Respond in JSON only:
{
  "has_pii": true | false,
  "reasoning": "one sentence explanation"
}`;

  const raw = await chatComplete(
    [{ role: "user", content: prompt }],
    `detectPII`,
  );

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Unexpected LLM response: ${raw}`);
  return JSON.parse(jsonMatch[0]) as PIIResult;
}
