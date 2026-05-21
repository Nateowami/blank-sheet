import { type GroupDoc, type StackFrame } from "../db/mongo.ts";

function formatTrend(
  lastSevenDayCount: number,
  priorSevenDayCount: number,
): string {
  if (lastSevenDayCount > priorSevenDayCount * 1.1) return "↑ Increasing";
  if (lastSevenDayCount < priorSevenDayCount * 0.9) return "↓ Decreasing";
  return "→ Stable";
}

function formatStackFrame(f: StackFrame): string {
  return `at ${f.method} (${f.file}:${f.lineNumber})`;
}

export function generateMarkdownSummary(
  group: GroupDoc,
  lastSevenDayCount: number,
  priorSevenDayCount: number,
): string {
  const title = group.template ?? group.exampleMessages[0] ?? "Unknown error";
  const trend = formatTrend(lastSevenDayCount, priorSevenDayCount);
  const piiPercent = group.eventCount > 0
    ? Math.round((group.eventsWithNoUserId / group.eventCount) * 100)
    : 0;

  const projectFrames = group.representativeStacktrace
    .filter((f) => !f.file.includes("node_modules"))
    .slice(0, 10);

  const mergeHistoryLines =
    group.mergeHistory.length > 0
      ? group.mergeHistory
          .map((m) => {
            const date = m.mergedAt.toISOString().split("T")[0];
            const reason = m.llmReasoning ? ` (${m.llmReasoning})` : "";
            return `- Merged with group \`${m.absorbedGroupId}\` on ${date}${reason}`;
          })
          .join("\n")
      : "- No merges";

  const piiWarning = group.hasPII
    ? `⚠️ **PII detected**\n\n`
    : "";

  const piiNote = group.hasPII
    ? `\n⚠️ This error group contains PII — sanitize before sharing.`
    : "";

  return `# Error Report: ${title}

**Group ID:** ${group._id}
**First seen:** ${group.firstSeenAt.toISOString()}
**Last seen:** ${group.lastSeenAt.toISOString()}
**Trend:** ${trend} over last 7 days
**Release stages:** ${group.releaseStages.join(", ")}
${piiWarning}
## Impact
- **${group.eventCount}** total events
- **${group.uniqueUserCount}** unique users affected
- **${group.eventsWithNoUserId}** events with no associated user (${piiPercent}%)

## Error Template
${group.template ?? "No template extracted yet"}

## Example Messages
${group.exampleMessages.map((m) => `> ${m}`).join("\n")}

## Most Common Stack Trace
\`\`\`
${projectFrames.map(formatStackFrame).join("\n")}
\`\`\`

## Merge History
${mergeHistoryLines}

## Notes for Investigation
${group.hasPII ? "⚠️ This error group contains PII — sanitize before sharing." : ""}${piiNote ? "" : "_No special notes._"}
`;
}
