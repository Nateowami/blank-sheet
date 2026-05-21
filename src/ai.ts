// OpenAI-compatible AI API client
import type { Config, IssueAnalysis, JiraIssue, MismatchDetail } from "./types.ts";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ChatResponse = {
  choices: Array<{
    message: { content: string };
  }>;
};

export class AiClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private async callApi(messages: ChatMessage[]): Promise<string> {
    const res = await fetch(`${this.config.ai.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.ai.model,
        messages,
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`AI API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI API returned empty content");
    return content;
  }

  async analyzeIssue(
    systemPrompt: string,
    issue: JiraIssue,
  ): Promise<IssueAnalysis> {
    const userPrompt = buildIssuePrompt(issue);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      try {
        const content = await this.callApi([
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ]);

        const analysis = parseAnalysis(content);
        analysis.buriedGemScore = computeBuriedGemScore(
          analysis.priorityScore,
          analysis.effort,
        );
        return analysis;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }

    throw lastError!;
  }
}

function buildIssuePrompt(issue: JiraIssue): string {
  const f = issue.fields;
  const lines: string[] = [];

  lines.push(`Issue Key: ${issue.key}`);
  lines.push(`Issue Type: ${f.issuetype?.name ?? "Unknown"}`);
  lines.push(`Priority: ${f.priority?.name ?? "None"}`);

  const labels = f.labels?.length ? f.labels.join(", ") : "(none)";
  lines.push(`Labels: ${labels}`);
  const components = f.components?.length ? f.components.map((c) => c.name).join(", ") : "(none)";
  lines.push(`Components: ${components}`);
  lines.push(`Summary: ${f.summary}`);
  lines.push("");
  lines.push("Description:");
  lines.push(f.description?.trim() || "(no description)");
  lines.push("");

  const comments = f.comment?.comments ?? [];
  const recent = comments.slice(-5);
  if (recent.length > 0) {
    lines.push(`Comments (most recent ${recent.length}, truncated to 500 chars each):`);
    recent.forEach((c, i) => {
      const body = c.body.length > 500 ? c.body.slice(0, 500) + "..." : c.body;
      const date = c.created.slice(0, 10);
      lines.push(`[${i + 1}] ${c.author.displayName} (${date}): ${body}`);
    });
    lines.push("");
  }

  const links = f.issuelinks ?? [];
  if (links.length > 0) {
    lines.push("Linked Issues:");
    for (const link of links) {
      if (link.outwardIssue) {
        lines.push(`- ${link.type.outward}: ${link.outwardIssue.key}`);
      } else if (link.inwardIssue) {
        lines.push(`- ${link.type.inward}: ${link.inwardIssue.key}`);
      }
    }
    lines.push("");
  }

  lines.push(`Created: ${f.created?.slice(0, 10) ?? "unknown"}`);
  lines.push(`Last Updated: ${f.updated?.slice(0, 10) ?? "unknown"}`);

  return lines.join("\n");
}

function parseAnalysis(content: string): IssueAnalysis {
  // Strip markdown fences if model adds them
  const cleaned = content
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  const raw = JSON.parse(cleaned);

  // Validate required fields
  const required = [
    "summary",
    "category",
    "tags",
    "priorityScore",
    "effort",
    "recommendedAction",
    "recommendedActionReason",
    "stalenessFlag",
    "confidence",
    "mismatches",
  ];
  for (const field of required) {
    if (raw[field] === undefined) {
      throw new Error(`AI response missing required field: ${field}`);
    }
  }

  return {
    summary: String(raw.summary),
    category: raw.category,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    priorityScore: Number(raw.priorityScore),
    effort: raw.effort,
    recommendedAction: raw.recommendedAction,
    recommendedActionReason: String(raw.recommendedActionReason),
    stalenessFlag: Boolean(raw.stalenessFlag),
    stalenessReason: raw.stalenessReason ?? null,
    buriedGemScore: 0, // computed after
    confidence: raw.confidence,
    confidenceReason: raw.confidenceReason ?? null,
    mismatches: {
      priority: raw.mismatches?.priority ?? null,
      category: raw.mismatches?.category ?? null,
      labels: raw.mismatches?.labels ?? null,
      components: raw.mismatches?.components ?? null,
      summary: raw.mismatches?.summary ?? null,
    },
  };
}

export function computeBuriedGemScore(
  priorityScore: number,
  effort: "S" | "M" | "L" | "XL",
): number {
  const effortMap: Record<string, number> = { S: 1, M: 2, L: 3, XL: 4 };
  const effortNumeric = effortMap[effort] ?? 2;
  return Math.round((priorityScore / effortNumeric) * 100) / 100;
}

export function detectMismatches(
  issue: JiraIssue,
  analysis: IssueAnalysis,
): IssueAnalysis["mismatches"] {
  const f = issue.fields;

  // Priority mismatch
  let priorityMismatch: MismatchDetail | null = null;
  const jiraPriority = f.priority?.name ?? "";
  const highJiraPriorities = ["critical", "blocker"];
  const lowJiraPriorities = ["minor", "low", "trivial"];
  const jiraPriorityLower = jiraPriority.toLowerCase();

  if (
    analysis.priorityScore >= 7 &&
    lowJiraPriorities.some((p) => jiraPriorityLower.includes(p))
  ) {
    priorityMismatch = {
      jiraValue: jiraPriority,
      aiValue: `${analysis.priorityScore}/10`,
      explanation: `AI assessed priority score ${analysis.priorityScore}/10 but Jira marks it as ${jiraPriority}.`,
    };
  } else if (
    analysis.priorityScore <= 3 &&
    highJiraPriorities.some((p) => jiraPriorityLower.includes(p))
  ) {
    priorityMismatch = {
      jiraValue: jiraPriority,
      aiValue: `${analysis.priorityScore}/10`,
      explanation: `AI assessed priority score ${analysis.priorityScore}/10 but Jira marks it as ${jiraPriority}.`,
    };
  }

  // Category mismatch
  let categoryMismatch: MismatchDetail | null = null;
  const jiraType = f.issuetype?.name?.toLowerCase() ?? "";
  const aiCategory = analysis.category;
  const categoryMap: Record<string, string[]> = {
    bug: ["bug", "defect", "error"],
    feature: ["story", "feature", "epic", "improvement", "new feature"],
    "tech-debt": ["tech debt", "technical debt", "refactor", "chore"],
    question: ["question", "support", "task"],
    chore: ["task", "sub-task", "chore"],
  };

  const expectedTypes = categoryMap[aiCategory] ?? [];
  const isMatch = expectedTypes.some((t) => jiraType.includes(t));
  if (!isMatch && analysis.mismatches?.category === null) {
    const jiraTypeRaw = f.issuetype?.name ?? "Unknown";
    if (
      (aiCategory === "bug" && !jiraType.includes("bug")) ||
      (aiCategory === "feature" &&
        jiraType.includes("bug")) ||
      (jiraType.includes("bug") && aiCategory !== "bug")
    ) {
      categoryMismatch = {
        jiraValue: jiraTypeRaw,
        aiValue: aiCategory,
        explanation: `AI categorized as "${aiCategory}" but Jira issue type is "${jiraTypeRaw}".`,
      };
    }
  }

  // Labels mismatch - check if AI tags contain topics absent from Jira labels
  let labelsMismatch: MismatchDetail | null = null;
  const jiraLabels = (f.labels ?? []).map((l) => l.toLowerCase());
  const missingFromLabels = analysis.tags.filter(
    (tag) =>
      !jiraLabels.some(
        (l) => l.includes(tag.toLowerCase()) || tag.toLowerCase().includes(l),
      ),
  );
  if (missingFromLabels.length >= 2 && jiraLabels.length > 0) {
    labelsMismatch = {
      jiraValue: jiraLabels.join(", ") || "(none)",
      aiValue: analysis.tags.join(", "),
      explanation:
        `AI identified topics [${missingFromLabels.join(", ")}] not present in Jira labels.`,
    };
  }

  // Components mismatch - check if AI tags contain topics absent from Jira components
  let componentsMismatch: MismatchDetail | null = null;
  const jiraComponents = (f.components ?? []).map((c) => c.name.toLowerCase());
  const missingFromComponents = analysis.tags.filter(
    (tag) =>
      !jiraComponents.some(
        (c) => c.includes(tag.toLowerCase()) || tag.toLowerCase().includes(c),
      ),
  );
  if (missingFromComponents.length >= 2 && jiraComponents.length > 0) {
    componentsMismatch = {
      jiraValue: jiraComponents.join(", "),
      aiValue: analysis.tags.join(", "),
      explanation:
        `AI identified topics [${missingFromComponents.slice(0, 3).join(", ")}] not reflected in Jira components.`,
    };
  }

  // Summary mismatch - cosine-similarity-like: fewer than 3 shared content words
  let summaryMismatch: MismatchDetail | null = null;
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "and",
    "or",
    "with",
    "not",
    "be",
    "are",
    "was",
    "were",
    "has",
    "have",
    "does",
    "do",
    "it",
    "its",
    "this",
    "that",
    "from",
  ]);
  const jiraSumWords = new Set(
    f.summary
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2 && !stopWords.has(w)),
  );
  const aiSumWords = analysis.summary
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
  const sharedWords = aiSumWords.filter((w) => jiraSumWords.has(w));

  if (sharedWords.length < 3 && analysis.summary.length > 20) {
    summaryMismatch = {
      jiraValue: f.summary,
      aiValue: analysis.summary,
      explanation: `AI summary shares few content words with the Jira summary (${sharedWords.length} shared words).`,
    };
  }

  return {
    priority: analysis.mismatches?.priority ?? priorityMismatch,
    category: analysis.mismatches?.category ?? categoryMismatch,
    labels: analysis.mismatches?.labels ?? labelsMismatch,
    components: analysis.mismatches?.components ?? componentsMismatch,
    summary: analysis.mismatches?.summary ?? summaryMismatch,
  };
}
