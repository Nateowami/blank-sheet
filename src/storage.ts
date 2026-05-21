// File I/O helpers for the Jira Triage tool
import type { ClosedIssueIndex, IssueResult, JiraIssue, Meta, Reviews } from "./types.ts";

export async function ensureDir(dir: string): Promise<void> {
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await Deno.readTextFile(path);
    return JSON.parse(text) as T;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
}

export async function deleteFile(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) files.push(entry.name);
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  return files;
}

export function rawPath(dataDir: string, key: string): string {
  return `${dataDir}/raw/${key}.json`;
}

export function resultPath(dataDir: string, key: string): string {
  return `${dataDir}/results/${key}.json`;
}

export function closedPath(dataDir: string): string {
  return `${dataDir}/closed.json`;
}

export function metaPath(dataDir: string): string {
  return `${dataDir}/meta.json`;
}

export function reviewsPath(dataDir: string): string {
  return `${dataDir}/reviews.json`;
}

export async function readRawIssue(dataDir: string, key: string): Promise<JiraIssue | null> {
  return readJson<JiraIssue>(rawPath(dataDir, key));
}

export async function writeRawIssue(dataDir: string, issue: JiraIssue): Promise<void> {
  await ensureDir(`${dataDir}/raw`);
  await writeJson(rawPath(dataDir, issue.key), issue);
}

export async function readResult(dataDir: string, key: string): Promise<IssueResult | null> {
  return readJson<IssueResult>(resultPath(dataDir, key));
}

export async function writeResult(dataDir: string, result: IssueResult): Promise<void> {
  await ensureDir(`${dataDir}/results`);
  await writeJson(resultPath(dataDir, result.key), result);
}

export async function readClosed(dataDir: string): Promise<ClosedIssueIndex | null> {
  return readJson<ClosedIssueIndex>(closedPath(dataDir));
}

export async function writeClosed(dataDir: string, index: ClosedIssueIndex): Promise<void> {
  await ensureDir(dataDir);
  await writeJson(closedPath(dataDir), index);
}

export async function readMeta(dataDir: string): Promise<Meta | null> {
  return readJson<Meta>(metaPath(dataDir));
}

export async function writeMeta(dataDir: string, meta: Meta): Promise<void> {
  await ensureDir(dataDir);
  await writeJson(metaPath(dataDir), meta);
}

export async function readReviews(dataDir: string): Promise<Reviews> {
  return (await readJson<Reviews>(reviewsPath(dataDir))) ?? {};
}

export async function writeReviews(dataDir: string, reviews: Reviews): Promise<void> {
  await ensureDir(dataDir);
  await writeJson(reviewsPath(dataDir), reviews);
}

export async function listRawKeys(dataDir: string): Promise<string[]> {
  const files = await listFiles(`${dataDir}/raw`);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

export async function listResultKeys(dataDir: string): Promise<string[]> {
  const files = await listFiles(`${dataDir}/results`);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}
