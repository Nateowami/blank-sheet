// GitHub REST API client

import type {
  GithubCommit,
  GithubComment,
  GithubPR,
  GithubPRFile,
  GithubReview,
  GithubTag,
} from "./types.ts";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubClient {
  private readonly headers: Record<string, string>;
  private readonly baseUrl = "https://api.github.com";
  private readonly repo: string;
  private readonly fetchFn: FetchFn;

  constructor(repo: string, token: string | undefined, fetchFn: FetchFn = fetch) {
    this.repo = repo;
    this.fetchFn = fetchFn;
    this.headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async get<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchFn(url, {
      headers: { ...this.headers, ...extraHeaders },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let hint = "";
      if (res.status === 403 && !this.headers["Authorization"]) {
        hint = " Consider providing a GITHUB_TOKEN to avoid rate limiting.";
      }
      throw new Error(
        `GitHub API error ${res.status} for ${url}: ${body}${hint}`,
      );
    }
    return res.json() as Promise<T>;
  }

  /** Get all commits in base..head range (up to 250 per page, auto-paginated). */
  async getCommitsInRange(base: string, head: string): Promise<GithubCommit[]> {
    const commits: GithubCommit[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const data = await this.get<{ commits: GithubCommit[]; status: string }>(
        `/repos/${this.repo}/compare/${base}...${head}?page=${page}&per_page=${perPage}`,
      );
      commits.push(...data.commits);
      if (data.commits.length < perPage) break;
      page++;
    }
    return commits;
  }

  /** Get all PRs associated with a commit. */
  async getCommitPRs(sha: string): Promise<GithubPR[]> {
    return this.get<GithubPR[]>(
      `/repos/${this.repo}/commits/${sha}/pulls`,
      { Accept: "application/vnd.github.groot-preview+json" },
    );
  }

  /** Get PR details. */
  async getPR(prNumber: number): Promise<GithubPR> {
    return this.get<GithubPR>(`/repos/${this.repo}/pulls/${prNumber}`);
  }

  /** Get files changed in a PR (auto-paginated). */
  async getPRFiles(prNumber: number): Promise<GithubPRFile[]> {
    const files: GithubPRFile[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const batch = await this.get<GithubPRFile[]>(
        `/repos/${this.repo}/pulls/${prNumber}/files?page=${page}&per_page=${perPage}`,
      );
      files.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return files;
  }

  /** Get commits in a PR. */
  async getPRCommits(prNumber: number): Promise<GithubCommit[]> {
    const commits: GithubCommit[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const batch = await this.get<GithubCommit[]>(
        `/repos/${this.repo}/pulls/${prNumber}/commits?page=${page}&per_page=${perPage}`,
      );
      commits.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return commits;
  }

  /** Get general (issue-level) comments on a PR. */
  async getPRComments(prNumber: number): Promise<GithubComment[]> {
    const comments: GithubComment[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const batch = await this.get<GithubComment[]>(
        `/repos/${this.repo}/issues/${prNumber}/comments?page=${page}&per_page=${perPage}`,
      );
      comments.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return comments;
  }

  /** Get inline review comments on a PR. */
  async getPRReviewComments(prNumber: number): Promise<GithubComment[]> {
    const comments: GithubComment[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const batch = await this.get<GithubComment[]>(
        `/repos/${this.repo}/pulls/${prNumber}/comments?page=${page}&per_page=${perPage}`,
      );
      comments.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return comments;
  }

  /** Get reviews on a PR. */
  async getPRReviews(prNumber: number): Promise<GithubReview[]> {
    const reviews: GithubReview[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const batch = await this.get<GithubReview[]>(
        `/repos/${this.repo}/pulls/${prNumber}/reviews?page=${page}&per_page=${perPage}`,
      );
      reviews.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return reviews;
  }

  /** Get the latest commit SHA on a branch. */
  async getBranchHead(branch: string): Promise<string> {
    const data = await this.get<{ object: { sha: string } }>(
      `/repos/${this.repo}/git/refs/heads/${branch}`,
    );
    return data.object.sha;
  }

  /** List all tags in the repository (auto-paginated). */
  async listTags(): Promise<GithubTag[]> {
    const tags: GithubTag[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const batch = await this.get<GithubTag[]>(
        `/repos/${this.repo}/tags?page=${page}&per_page=${perPage}`,
      );
      tags.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return tags;
  }
}
