// All shared TypeScript types for the Jira Triage tool

export type Config = {
  jira: {
    baseUrl: string;
    email: string;
    project: string;
  };
  ai: {
    endpoint: string;
    apiKey: string;
    model: string;
  };
  data: {
    dir: string;
  };
  server: {
    port: number;
  };
  promptFile: string;
};

export type JiraIssue = {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: string | null;
    issuetype: { name: string };
    status: { name: string; statusCategory: { name: string } };
    priority: { name: string } | null;
    labels: string[];
    components: Array<{ name: string }>;
    fixVersions: Array<{ name: string }>;
    reporter: { displayName: string } | null;
    assignee: { displayName: string } | null;
    created: string;
    updated: string;
    comment: {
      comments: Array<{
        author: { displayName: string };
        body: string;
        created: string;
      }>;
      total: number;
    };
    issuelinks: Array<{
      type: { name: string; inward: string; outward: string };
      inwardIssue?: { key: string; fields: { summary: string } };
      outwardIssue?: { key: string; fields: { summary: string } };
    }>;
    parent?: { key: string; fields: { summary: string } };
  };
  _fetchedAt?: string;
};

export type MismatchDetail = {
  jiraValue: string;
  aiValue: string;
  explanation: string;
};

export type IssueAnalysis = {
  summary: string;
  category: "bug" | "feature" | "tech-debt" | "question" | "chore" | "other";
  tags: string[];
  priorityScore: number;
  effort: "S" | "M" | "L" | "XL";
  recommendedAction: "close" | "prioritize" | "needs-info" | "keep";
  recommendedActionReason: string;
  stalenessFlag: boolean;
  stalenessReason: string | null;
  buriedGemScore: number;
  confidence: "high" | "medium" | "low";
  confidenceReason: string | null;
  mismatches: {
    priority: MismatchDetail | null;
    category: MismatchDetail | null;
    labels: MismatchDetail | null;
    components: MismatchDetail | null;
    summary: MismatchDetail | null;
  };
};

export type IssueResult = {
  key: string;
  status: "ok" | "error";
  processedAt: string;
  error?: string;
  analysis?: IssueAnalysis;
};

export type ClosedIssueIndex = {
  fetchedAt: string;
  issues: Array<{
    key: string;
    summary: string;
    resolution: string;
    status: string;
    resolutionDate: string | null;
  }>;
};

export type Meta = {
  lastFetchedAt: string | null;
  lastProcessedAt: string | null;
  openIssueCount: number;
  closedIssueCount: number;
  processedCount: number;
  errorCount: number;
  pendingCount: number;
};

export type ReviewEntry = {
  dismissed: boolean;
  dismissedAt: string | null;
  note: string | null;
  noteUpdatedAt: string | null;
};

export type Reviews = {
  [issueKey: string]: ReviewEntry;
};

export type ApiIssue = {
  key: string;
  jiraSummary: string;
  jiraType: string;
  jiraPriority: string;
  jiraLabels: string[];
  jiraComponents: string[];
  jiraStatus: string;
  jiraAssignee: string | null;
  jiraCreated: string;
  jiraUpdated: string;
  jiraLink: string;
  resultStatus: "ok" | "error" | "pending";
  analysis: IssueAnalysis | null;
  error: string | null;
  processedAt: string | null;
  dismissed: boolean;
  note: string | null;
};

export type ApiData = {
  issues: ApiIssue[];
  meta: Meta;
  closedCount: number;
};
