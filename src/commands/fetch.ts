// `fetch` command: fetches all issues from Jira and saves raw data to disk
import type { Config } from "../types.ts";
import { JiraClient } from "../jira.ts";
import {
  deleteFile,
  ensureDir,
  readRawIssue,
  resultPath,
  writeClosed,
  writeMeta,
  writeRawIssue,
} from "../storage.ts";

export async function runFetch(config: Config): Promise<void> {
  const token = Deno.env.get("JIRA_ACCESS_TOKEN");
  if (!token) {
    console.error(
      "Error: JIRA_ACCESS_TOKEN environment variable is not set.",
    );
    Deno.exit(1);
  }

  const dataDir = config.data.dir;
  await ensureDir(dataDir);
  await ensureDir(`${dataDir}/raw`);
  await ensureDir(`${dataDir}/results`);

  const client = new JiraClient(config, token);

  console.log("Fetching open issues from Jira...");
  const openIssues = await client.fetchOpenIssues();

  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  const fetchedAt = new Date().toISOString();

  for (const issue of openIssues) {
    const existing = await readRawIssue(dataDir, issue.key);

    if (!existing) {
      // New issue
      await writeRawIssue(dataDir, { ...issue, _fetchedAt: fetchedAt });
      newCount++;
    } else if (existing.fields.updated !== issue.fields.updated) {
      // Updated issue — overwrite raw and delete result
      await writeRawIssue(dataDir, { ...issue, _fetchedAt: fetchedAt });
      await deleteFile(resultPath(dataDir, issue.key));
      updatedCount++;
    } else {
      // Unchanged
      console.log(`Skipped ${issue.key} (unchanged)`);
      unchangedCount++;
    }
  }

  console.log(
    `Fetched ${openIssues.length} open issues: ${newCount} new, ${updatedCount} updated, ${unchangedCount} unchanged`,
  );

  console.log("Fetching closed issues from Jira...");
  const closedIssues = await client.fetchClosedIssues();

  await writeClosed(dataDir, {
    fetchedAt,
    issues: closedIssues,
  });

  console.log(
    `Fetched ${closedIssues.length} closed issues → saved to ${dataDir}/closed.json`,
  );

  // Update meta
  await writeMeta(dataDir, {
    lastFetchedAt: fetchedAt,
    lastProcessedAt: null,
    openIssueCount: openIssues.length,
    closedIssueCount: closedIssues.length,
    processedCount: 0,
    errorCount: 0,
    pendingCount: openIssues.length,
  });
}
