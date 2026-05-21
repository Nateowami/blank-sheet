// Jira API client
import type { Config, JiraIssue } from "./types.ts";

type JiraSearchResponse = {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
};

type ClosedJiraIssue = {
  key: string;
  fields: {
    summary: string;
    resolution: { name: string } | null;
    status: { name: string };
    resolutiondate: string | null;
  };
};

type ClosedSearchResponse = {
  startAt: number;
  maxResults: number;
  total: number;
  issues: ClosedJiraIssue[];
};

const OPEN_FIELDS =
  "summary,description,issuetype,status,priority,labels,components,fixVersions,reporter,assignee,created,updated,comment,issuelinks,parent";

const CLOSED_FIELDS = "summary,resolution,status,resolutiondate";

export class JiraClient {
  private baseUrl: string;
  private token: string;
  private project: string;

  constructor(config: Config, token: string) {
    this.baseUrl = config.jira.baseUrl.replace(/\/$/, "");
    this.token = token;
    this.project = config.jira.project;
  }

  private get headers(): HeadersInit {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };
  }

  private apiUrl(path: string): string {
    return `${this.baseUrl}/rest/api/2${path}`;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira API error ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async paginatedFetch<T, I>(
    buildUrl: (startAt: number) => string,
    extractIssues: (response: T) => I[],
    extractTotal: (response: T) => number,
  ): Promise<I[]> {
    const allIssues: I[] = [];
    let startAt = 0;

    while (true) {
      const response = await this.fetchJson<T>(buildUrl(startAt));
      const issues = extractIssues(response);
      allIssues.push(...issues);
      const total = extractTotal(response);
      if (allIssues.length >= total || issues.length === 0) break;
      startAt += issues.length;
    }

    return allIssues;
  }

  async fetchOpenIssues(): Promise<JiraIssue[]> {
    const jql = encodeURIComponent(
      `project=${this.project} AND statusCategory != Done`,
    );
    const fields = encodeURIComponent(OPEN_FIELDS);

    return this.paginatedFetch<JiraSearchResponse, JiraIssue>(
      (startAt) =>
        this.apiUrl(
          `/search?jql=${jql}&maxResults=100&startAt=${startAt}&fields=${fields}`,
        ),
      (r) => r.issues,
      (r) => r.total,
    );
  }

  async fetchClosedIssues(): Promise<
    Array<{
      key: string;
      summary: string;
      resolution: string;
      status: string;
      resolutionDate: string | null;
    }>
  > {
    const jql = encodeURIComponent(
      `project=${this.project} AND statusCategory = Done`,
    );
    const fields = encodeURIComponent(CLOSED_FIELDS);

    const raw = await this.paginatedFetch<ClosedSearchResponse, ClosedJiraIssue>(
      (startAt) =>
        this.apiUrl(
          `/search?jql=${jql}&maxResults=100&startAt=${startAt}&fields=${fields}`,
        ),
      (r) => r.issues,
      (r) => r.total,
    );

    return raw.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      resolution: issue.fields.resolution?.name ?? "Unresolved",
      status: issue.fields.status.name,
      resolutionDate: issue.fields.resolutiondate ?? null,
    }));
  }
}
