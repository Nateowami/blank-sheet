// Audit logging: appends JSONL entries to a log file per PR or per release

import type { AuditLogEntry } from "./types.ts";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export class Logger {
  private filePath: string;

  constructor(logsDir: string, logFileName: string) {
    this.filePath = join(logsDir, logFileName);
  }

  /**
   * Format a timestamp as YYYY-MM-DDTHH-MM-SS (filesystem-safe).
   */
  static formatTimestamp(date: Date = new Date()): string {
    return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-").replace("Z", "");
  }

  /**
   * Create a log file name for a per-PR log.
   */
  static prLogFileName(prNumber: number | string, timestamp?: string): string {
    const ts = timestamp ?? Logger.formatTimestamp();
    return `pr-${prNumber}_${ts}.jsonl`;
  }

  /**
   * Create a log file name for a release log.
   */
  static releaseLogFileName(version: string, timestamp?: string): string {
    const ts = timestamp ?? Logger.formatTimestamp();
    return `release-${version}_${ts}.jsonl`;
  }

  /**
   * Append a log entry to the JSONL file. Creates the file if it doesn't exist.
   */
  async append(entry: AuditLogEntry): Promise<void> {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await Deno.writeTextFile(this.filePath, line, { append: true });
  }

  get path(): string {
    return this.filePath;
  }
}
