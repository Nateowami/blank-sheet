#!/usr/bin/env -S deno run --allow-net --allow-env
// PR Review Tool
// Usage: deno run --allow-net --allow-env review-pr.ts <github-pr-url>
//
// Environment variables:
//   GITHUB_TOKEN   - GitHub personal access token (optional, avoids rate limiting)
//   JIRA_BASE_URL  - Base URL of your Jira instance (e.g. https://jira.example.com)
//   JIRA_TOKEN     - Jira personal access token (required when Jira issues are found)
//   LLM_BASE_URL   - Base URL of an OpenAI-compatible LLM API (required)
//   LLM_MODEL      - Model name to use (required)
//   LLM_API_KEY    - API key for the LLM (optional)

// ─── GitHub client ────────────────────────────────────────────────────────────

interface GithubPR {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  html_url: string;
  user: { login: string } | null;
}

interface GithubPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GithubCommit {
  sha: string;
  commit: { message: string };
}

interface GithubComment {
  user: { login: string } | null;
  body: string;
}

interface GithubReview {
  user: { login: string } | null;
  state: string;
  body: string | null;
}

class GitHubClient {
  private readonly headers: Record<string, string>;
  private readonly baseUrl = "https://api.github.com";

  constructor(private readonly repo: string, token: string | undefined) {
    this.headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let hint = "";
      if (res.status === 403 && !this.headers["Authorization"]) {
        hint = " Consider setting GITHUB_TOKEN to avoid rate limiting.";
      }
      throw new Error(`GitHub API error ${res.status} for ${url}: ${body}${hint}`);
    }
    return res.json() as Promise<T>;
  }

  private async paginated<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.get<T[]>(`${path}${sep}page=${page}&per_page=${perPage}`);
      items.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return items;
  }

  async getPR(prNumber: number): Promise<GithubPR> {
    return this.get<GithubPR>(`/repos/${this.repo}/pulls/${prNumber}`);
  }

  async getPRFiles(prNumber: number): Promise<GithubPRFile[]> {
    return this.paginated<GithubPRFile>(`/repos/${this.repo}/pulls/${prNumber}/files`);
  }

  async getPRCommits(prNumber: number): Promise<GithubCommit[]> {
    return this.paginated<GithubCommit>(`/repos/${this.repo}/pulls/${prNumber}/commits`);
  }

  async getPRComments(prNumber: number): Promise<GithubComment[]> {
    return this.paginated<GithubComment>(`/repos/${this.repo}/issues/${prNumber}/comments`);
  }

  async getPRReviewComments(prNumber: number): Promise<GithubComment[]> {
    return this.paginated<GithubComment>(`/repos/${this.repo}/pulls/${prNumber}/comments`);
  }

  async getPRReviews(prNumber: number): Promise<GithubReview[]> {
    return this.paginated<GithubReview>(`/repos/${this.repo}/pulls/${prNumber}/reviews`);
  }
}

// ─── Jira client ─────────────────────────────────────────────────────────────

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    issuetype: { name: string };
    status: { name: string };
    priority: { name: string } | null;
    assignee: { displayName: string } | null;
    reporter: { displayName: string } | null;
    created: string;
    updated: string;
    comment: {
      comments: Array<{
        author: { displayName: string };
        body: string;
        created: string;
      }>;
    };
  };
}

class JiraClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  async fetchIssue(key: string): Promise<JiraIssue> {
    const fields =
      "summary,description,issuetype,status,priority,assignee,reporter,created,updated,comment";
    const url = `${this.baseUrl}/rest/api/2/issue/${key}?fields=${encodeURIComponent(fields)}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jira API error ${res.status} for ${key}: ${body}`);
    }
    return res.json() as Promise<JiraIssue>;
  }
}

// ─── LLM client ───────────────────────────────────────────────────────────────

interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callLlm(
  messages: LlmMessage[],
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string | null } }>;
  };
  return data.choices[0]?.message?.content ?? "";
}

// ─── URL parsing ─────────────────────────────────────────────────────────────

function parsePRUrl(url: string): { repo: string; prNumber: number } {
  // e.g. https://github.com/owner/repo/pull/123
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(
      `Invalid GitHub PR URL: "${url}". Expected format: https://github.com/owner/repo/pull/123`,
    );
  }
  return { repo: match[1], prNumber: parseInt(match[2], 10) };
}

function extractJiraKeys(text: string): string[] {
  const matches = text.match(/\b[A-Z]+-\d+\b/g) ?? [];
  return [...new Set(matches)];
}

// ─── Context builders ─────────────────────────────────────────────────────────

function formatJiraIssue(issue: JiraIssue): string {
  const f = issue.fields;
  const lines: string[] = [
    `## Jira Issue ${issue.key}: ${f.summary}`,
    `- **Type**: ${f.issuetype.name}`,
    `- **Status**: ${f.status.name}`,
    `- **Priority**: ${f.priority?.name ?? "None"}`,
    `- **Assignee**: ${f.assignee?.displayName ?? "Unassigned"}`,
    `- **Reporter**: ${f.reporter?.displayName ?? "Unknown"}`,
    `- **Created**: ${f.created}`,
    `- **Updated**: ${f.updated}`,
  ];

  if (f.description?.trim()) {
    lines.push(`\n### Description\n\n${f.description}`);
  }

  const comments = f.comment?.comments ?? [];
  if (comments.length > 0) {
    lines.push("\n### Comments");
    for (const c of comments) {
      lines.push(`\n**${c.author.displayName}** (${c.created}):\n${c.body}`);
    }
  }

  return lines.join("\n");
}

const MAX_PATCH_LINES = 200;

function formatPRContext(
  pr: GithubPR,
  files: GithubPRFile[],
  commits: GithubCommit[],
  comments: GithubComment[],
  reviewComments: GithubComment[],
  reviews: GithubReview[],
): string {
  const sections: string[] = [];

  sections.push(`## PR #${pr.number}: ${pr.title}`);
  sections.push(`- **URL**: ${pr.html_url}`);
  sections.push(`- **Author**: ${pr.user?.login ?? "unknown"}`);
  sections.push(`- **Merged at**: ${pr.merged_at ?? "not merged"}`);

  if (pr.body?.trim()) {
    sections.push(`\n### PR Description\n\n${pr.body}`);
  } else {
    sections.push(`\n### PR Description\n\n*(no description provided)*`);
  }

  if (commits.length > 0) {
    const msgs = commits.map((c) => `- ${c.commit.message.split("\n")[0]}`).join("\n");
    sections.push(`\n### Commit Messages\n\n${msgs}`);
  }

  if (comments.length > 0) {
    const formatted = comments
      .map((c) => `**${c.user?.login ?? "unknown"}**: ${c.body}`)
      .join("\n\n---\n\n");
    sections.push(`\n### PR Comments\n\n${formatted}`);
  }

  if (reviewComments.length > 0) {
    const formatted = reviewComments
      .map((c) => `**${c.user?.login ?? "unknown"}**: ${c.body}`)
      .join("\n\n---\n\n");
    sections.push(`\n### Review Comments\n\n${formatted}`);
  }

  const meaningfulReviews = reviews.filter((r) => r.body?.trim());
  if (meaningfulReviews.length > 0) {
    const formatted = meaningfulReviews
      .map((r) => `**${r.user?.login ?? "unknown"}** (${r.state}): ${r.body}`)
      .join("\n\n---\n\n");
    sections.push(`\n### Reviews\n\n${formatted}`);
  }

  if (files.length > 0) {
    sections.push("\n### Changed Files\n");
    for (const f of files) {
      sections.push(`#### ${f.filename} (+${f.additions}/-${f.deletions}, ${f.status})`);
      if (f.patch) {
        const lines = f.patch.split("\n");
        const truncated = lines.length > MAX_PATCH_LINES;
        const shown = truncated ? lines.slice(0, MAX_PATCH_LINES) : lines;
        sections.push("```diff\n" + shown.join("\n") + "\n```");
        if (truncated) {
          sections.push(`*(truncated — showing first ${MAX_PATCH_LINES} of ${lines.length} lines)*`);
        }
      }
    }
  }

  return sections.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const prUrl = Deno.args[0];
  if (!prUrl) {
    console.error("Usage: deno run --allow-net --allow-env review-pr.ts <github-pr-url>");
    Deno.exit(1);
  }

  const llmBaseUrl = Deno.env.get("LLM_BASE_URL");
  const llmModel = Deno.env.get("LLM_MODEL");
  if (!llmBaseUrl || !llmModel) {
    console.error("Error: LLM_BASE_URL and LLM_MODEL environment variables are required.");
    Deno.exit(1);
  }
  const llmApiKey = Deno.env.get("LLM_API_KEY");

  const githubToken = Deno.env.get("GITHUB_TOKEN");
  if (!githubToken) {
    console.error(
      "Warning: GITHUB_TOKEN is not set. Unauthenticated requests are limited to 60 per hour.",
    );
  }

  const jiraBaseUrl = Deno.env.get("JIRA_BASE_URL");
  const jiraToken = Deno.env.get("JIRA_TOKEN");

  // Parse the PR URL
  let repo: string;
  let prNumber: number;
  try {
    ({ repo, prNumber } = parsePRUrl(prUrl));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }

  console.error(`Fetching PR #${prNumber} from ${repo}...`);

  const github = new GitHubClient(repo, githubToken);

  // Fetch all PR data in parallel
  let pr: GithubPR;
  let files: GithubPRFile[];
  let commits: GithubCommit[];
  let comments: GithubComment[];
  let reviewComments: GithubComment[];
  let reviews: GithubReview[];

  try {
    [pr, files, commits, comments, reviewComments, reviews] = await Promise.all([
      github.getPR(prNumber),
      github.getPRFiles(prNumber),
      github.getPRCommits(prNumber),
      github.getPRComments(prNumber),
      github.getPRReviewComments(prNumber),
      github.getPRReviews(prNumber),
    ]);
  } catch (err) {
    console.error(`Error fetching PR data: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }

  // Extract Jira issue keys from the PR title
  const jiraKeys = extractJiraKeys(pr.title);
  const jiraContextParts: string[] = [];

  if (jiraKeys.length > 0) {
    if (!jiraBaseUrl || !jiraToken) {
      console.error(
        `Warning: PR title contains Jira keys (${jiraKeys.join(", ")}) but JIRA_BASE_URL and/or JIRA_TOKEN are not set. Skipping Jira fetch.`,
      );
    } else {
      const jira = new JiraClient(jiraBaseUrl, jiraToken);
      console.error(`Fetching Jira issues: ${jiraKeys.join(", ")}...`);
      for (const key of jiraKeys) {
        try {
          const issue = await jira.fetchIssue(key);
          jiraContextParts.push(formatJiraIssue(issue));
        } catch (err) {
          console.error(
            `Warning: Could not fetch Jira issue ${key}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }

  const prContext = formatPRContext(pr, files, commits, comments, reviewComments, reviews);

  // Build the LLM prompt
  const systemPrompt = `You are a senior software engineer performing a thorough code review. You will be given context about a GitHub pull request and, where available, the Jira issue(s) it is supposed to address. Your job is to review the PR and report your findings.`;

  const jiraSection = jiraContextParts.length > 0
    ? `# Jira Issue Context\n\n${jiraContextParts.join("\n\n---\n\n")}\n\n`
    : "# Jira Issue Context\n\n*(No Jira issues were found or fetched for this PR.)*\n\n";

  const userPrompt = `${jiraSection}# GitHub Pull Request\n\n${prContext}

---

Please review this pull request and provide your findings on the following points:

1. **Jira Coverage**: Does the PR actually implement everything described in the Jira issue(s)? Are there requirements, acceptance criteria, or described behaviors in the Jira issue that are missing from the implementation?

2. **Title Accuracy**: Does the PR title accurately describe what the PR actually does? Note any discrepancies between the title and the actual changes.

3. **Omissions**: Are there any omissions — things the Jira issue(s) or PR title suggest would be accomplished, but that aren't actually present in the code changes?

4. **Other Issues**: Are there any other problems you noticed during the review (e.g., potential bugs, security concerns, code quality issues visible in the diff)? You do not need to search exhaustively — just document issues you notice.

Be specific and reference the relevant parts of the code, Jira issue, or PR description where applicable.`;

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  console.error("Calling LLM for review...");

  let findings: string;
  try {
    findings = await callLlm(messages, llmBaseUrl, llmModel, llmApiKey);
  } catch (err) {
    console.error(`Error calling LLM: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }

  console.log(findings);
}

await main();
