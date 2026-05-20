// Tests for version resolution and bumping

import { assertEquals } from "./test_utils.ts";
import { parseVersion, bumpVersion, inferBumpType } from "../lib/version.ts";

Deno.test("parseVersion - valid version", () => {
  const parsed = parseVersion("SFv5.56.0");
  assertEquals(parsed, { raw: "SFv5.56.0", major: 5, minor: 56, patch: 0 });
});

Deno.test("parseVersion - version with non-zero patch", () => {
  const parsed = parseVersion("SFv1.2.3");
  assertEquals(parsed, { raw: "SFv1.2.3", major: 1, minor: 2, patch: 3 });
});

Deno.test("parseVersion - invalid pattern returns null", () => {
  assertEquals(parseVersion("v5.56.0"), null);
  assertEquals(parseVersion("SFv5.56"), null);
  assertEquals(parseVersion("5.56.0"), null);
  assertEquals(parseVersion("SFv5.56.0-alpha"), null);
  assertEquals(parseVersion(""), null);
});

Deno.test("bumpVersion - patch bump", () => {
  const v = parseVersion("SFv5.56.0")!;
  assertEquals(bumpVersion(v, "patch"), "SFv5.56.1");
});

Deno.test("bumpVersion - minor bump resets patch", () => {
  const v = parseVersion("SFv5.56.3")!;
  assertEquals(bumpVersion(v, "minor"), "SFv5.57.0");
});

Deno.test("bumpVersion - major bump resets minor and patch", () => {
  const v = parseVersion("SFv5.56.3")!;
  assertEquals(bumpVersion(v, "major"), "SFv6.0.0");
});

Deno.test("inferBumpType - all patch gives patch", () => {
  assertEquals(inferBumpType(["patch", "patch", "patch"]), "patch");
});

Deno.test("inferBumpType - any major gives major", () => {
  assertEquals(inferBumpType(["minor", "major", "patch"]), "major");
});

Deno.test("inferBumpType - mix of minor and patch gives minor", () => {
  assertEquals(inferBumpType(["patch", "minor", "patch"]), "minor");
});

Deno.test("inferBumpType - empty array defaults to patch", () => {
  assertEquals(inferBumpType([]), "patch");
});

Deno.test("inferBumpType - single minor", () => {
  assertEquals(inferBumpType(["minor"]), "minor");
});
