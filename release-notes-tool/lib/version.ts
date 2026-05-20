// Version resolution: find the current version tag on sf-live, compute next version

import type { GitHubClient } from "./github.ts";
import type { BumpType } from "./types.ts";

const VERSION_PATTERN = /^SFv(\d+)\.(\d+)\.(\d+)$/;

export interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(tag: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(tag);
  if (!match) return null;
  return {
    raw: tag,
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

export function bumpVersion(version: ParsedVersion, bump: BumpType): string {
  switch (bump) {
    case "major":
      return `SFv${version.major + 1}.0.0`;
    case "minor":
      return `SFv${version.major}.${version.minor + 1}.0`;
    case "patch":
      return `SFv${version.major}.${version.minor}.${version.patch + 1}`;
  }
}

/**
 * Resolve the current version on sf-live by fetching its HEAD commit and finding
 * the matching tag. Returns the version string (e.g. "SFv5.56.0") or null if
 * no matching tag is found.
 */
export async function resolveCurrentVersion(
  github: GitHubClient,
  baseBranch: string,
): Promise<string | null> {
  const headSha = await github.getBranchHead(baseBranch);
  const tags = await github.listTags();

  for (const tag of tags) {
    if (tag.commit.sha === headSha && VERSION_PATTERN.test(tag.name)) {
      return tag.name;
    }
  }
  return null;
}

/**
 * Determine the bump type from an array of significances.
 */
export function inferBumpType(significances: string[]): BumpType {
  if (significances.includes("major")) return "major";
  if (significances.every((s) => s === "patch")) return "patch";
  return "minor";
}
