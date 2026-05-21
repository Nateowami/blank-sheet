// `process` command: runs AI analysis on all open issues that need it
import type { Config, IssueResult } from "../types.ts";
import { AiClient, detectMismatches } from "../ai.ts";
import {
  listRawKeys,
  readRawIssue,
  readResult,
  writeMeta,
  writeResult,
} from "../storage.ts";
import { readMeta } from "../storage.ts";

export async function runProcess(
  config: Config,
  retryErrors: boolean,
  singleKey: string | null,
): Promise<void> {
  const dataDir = config.data.dir;

  // Load system prompt
  let systemPrompt: string;
  try {
    systemPrompt = await Deno.readTextFile(config.promptFile);
  } catch {
    console.error(`Error: Could not read prompt file: ${config.promptFile}`);
    Deno.exit(1);
  }

  const client = new AiClient(config);

  // Determine which keys to process
  let keysToConsider: string[];
  if (singleKey) {
    keysToConsider = [singleKey];
  } else {
    keysToConsider = await listRawKeys(dataDir);
  }

  const toProcess: string[] = [];
  const skipped: string[] = [];

  for (const key of keysToConsider) {
    if (singleKey) {
      toProcess.push(key);
      continue;
    }
    const result = await readResult(dataDir, key);
    if (!result) {
      toProcess.push(key);
    } else if (result.status === "ok") {
      skipped.push(key);
    } else if (result.status === "error") {
      if (retryErrors) {
        toProcess.push(key);
      } else {
        skipped.push(key);
      }
    }
  }

  let processedCount = 0;
  let errorCount = 0;
  const processedAt = new Date().toISOString();

  for (let i = 0; i < toProcess.length; i++) {
    const key = toProcess[i];
    const issue = await readRawIssue(dataDir, key);
    if (!issue) {
      console.warn(`WARN: Raw file not found for ${key}, skipping`);
      continue;
    }

    const summary = issue.fields.summary.slice(0, 50);
    console.log(`Processing ${i + 1}/${toProcess.length}: ${key} - ${summary}...`);

    let result: IssueResult;
    try {
      const analysis = await client.analyzeIssue(systemPrompt, issue);
      // Apply mismatch detection (merges AI-provided mismatches with computed ones)
      analysis.mismatches = detectMismatches(issue, analysis);

      result = {
        key,
        status: "ok",
        processedAt,
        analysis,
      };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.warn(`WARN: Failed to process ${key} after 2 attempts: ${errorMsg}`);
      result = {
        key,
        status: "error",
        processedAt,
        error: errorMsg,
      };
      errorCount++;
    }

    await writeResult(dataDir, result);
    if (result.status === "ok") processedCount++;
  }

  // Collect summary stats
  const allKeys = await listRawKeys(dataDir);
  const allResults = await Promise.all(allKeys.map((k) => readResult(dataDir, k)));

  const okResults = allResults.filter((r) => r?.status === "ok");
  const totalErrors = allResults.filter((r) => r?.status === "error").length;
  const totalPending = allResults.filter((r) => !r).length;

  // Count recommended actions
  const actionCounts: Record<string, number> = {
    close: 0,
    prioritize: 0,
    "needs-info": 0,
    keep: 0,
  };

  // Count mismatches
  let mismatchPriority = 0;
  let mismatchCategory = 0;
  let mismatchLabels = 0;
  let staleCount = 0;
  let mismatchTotal = 0;

  for (const result of okResults) {
    if (!result?.analysis) continue;
    const a = result.analysis;
    if (a.recommendedAction in actionCounts) {
      actionCounts[a.recommendedAction]++;
    }
    if (a.stalenessFlag) staleCount++;

    const hasMismatch =
      a.mismatches.priority ||
      a.mismatches.category ||
      a.mismatches.labels ||
      a.mismatches.summary;
    if (hasMismatch) mismatchTotal++;
    if (a.mismatches.priority) mismatchPriority++;
    if (a.mismatches.category) mismatchCategory++;
    if (a.mismatches.labels) mismatchLabels++;
  }

  // Update meta
  const existingMeta = await readMeta(dataDir);
  await writeMeta(dataDir, {
    lastFetchedAt: existingMeta?.lastFetchedAt ?? null,
    lastProcessedAt: processedAt,
    openIssueCount: existingMeta?.openIssueCount ?? allKeys.length,
    closedIssueCount: existingMeta?.closedIssueCount ?? 0,
    processedCount: okResults.length,
    errorCount: totalErrors,
    pendingCount: totalPending,
  });

  // Print summary
  const line = "─".repeat(37);
  console.log(line);
  console.log("Jira Triage Processing Summary");
  console.log(line);
  console.log(`Processed:     ${processedCount.toString().padStart(3)} issues`);
  console.log(
    `Skipped:       ${skipped.length.toString().padStart(3)} issues (already processed)`,
  );
  console.log(
    `Errors:        ${totalErrors.toString().padStart(3)} issues${
      totalErrors > 0 ? " (run with --retry-errors to retry)" : ""
    }`,
  );
  console.log("");
  console.log("Recommended Actions:");
  console.log(`  Close:        ${actionCounts["close"].toString().padStart(3)}`);
  console.log(`  Prioritize:   ${actionCounts["prioritize"].toString().padStart(3)}`);
  console.log(`  Needs Info:   ${actionCounts["needs-info"].toString().padStart(3)}`);
  console.log(`  Keep:         ${actionCounts["keep"].toString().padStart(3)}`);
  console.log("");
  console.log(`Mismatches found: ${mismatchTotal} issues`);
  console.log(`  Priority:     ${mismatchPriority.toString().padStart(3)}`);
  console.log(`  Category:     ${mismatchCategory.toString().padStart(3)}`);
  console.log(`  Labels:       ${mismatchLabels.toString().padStart(3)}`);
  console.log("");
  console.log(`Stale/Inactive: ${staleCount} issues flagged`);
  console.log(line);
}
