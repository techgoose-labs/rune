import { assertEquals, assertStringIncludes } from "#std/assert";
import { formatEastern, isNewer, latestCommitUrl } from "./mod.ts";

Deno.test("latestCommitUrl — points at the release's commit.txt asset (default latest)", () => {
  assertEquals(
    latestCommitUrl(),
    "https://github.com/mrg-keystone/rune/releases/download/latest/commit.txt",
  );
});

Deno.test("latestCommitUrl — honors a pinned tag", () => {
  assertEquals(
    latestCommitUrl("v0.1.0"),
    "https://github.com/mrg-keystone/rune/releases/download/v0.1.0/commit.txt",
  );
});

Deno.test("isNewer — differing commits means a newer release is out", () => {
  assertEquals(isNewer("aaaaaaa", "bbbbbbb"), true);
});

Deno.test("isNewer — same commit is up to date", () => {
  assertEquals(isNewer("aaaaaaa", "aaaaaaa"), false);
});

Deno.test("isNewer — unknown baked commit (dev build) never nags", () => {
  assertEquals(isNewer("unknown", "bbbbbbb"), false);
  assertEquals(isNewer(undefined, "bbbbbbb"), false);
});

Deno.test("isNewer — unreachable API (no latest sha) never nags", () => {
  assertEquals(isNewer("aaaaaaa", undefined), false);
});

Deno.test("formatEastern — summer UTC instant renders in EDT (UTC-4)", () => {
  // 19:32 UTC on Jun 26 → 15:32 (3:32 PM) EDT.
  const s = formatEastern("2026-06-26T19:32:00Z");
  assertEquals(s !== null, true);
  assertStringIncludes(s!, "Jun 26, 2026");
  assertStringIncludes(s!, "3:32");
  assertStringIncludes(s!, "EDT");
});

Deno.test("formatEastern — winter UTC instant renders in EST (UTC-5)", () => {
  // 19:32 UTC on Jan 15 → 14:32 (2:32 PM) EST — the zone label tracks the season.
  const s = formatEastern("2026-01-15T19:32:00Z");
  assertEquals(s !== null, true);
  assertStringIncludes(s!, "Jan 15, 2026");
  assertStringIncludes(s!, "2:32");
  assertStringIncludes(s!, "EST");
});

Deno.test("formatEastern — missing/unparseable stamp yields null (line omitted)", () => {
  assertEquals(formatEastern("unknown"), null);
  assertEquals(formatEastern(""), null);
});

// ---- CLI-vs-library major skew ------------------------------------------
//
// The case these pin actually happened: rune 7.0.0 was published to JSR while
// the rolling `latest` release stayed on the 6.x commit. Every installed CLI
// reported itself up to date — correctly, it WAS the newest release — and then
// failed to parse `[REQ:open]` with "does not take a modifier". The commit
// check is structurally blind to it, so the library version is checked too.

import { isMajorBehind, majorOf } from "./mod.ts";

Deno.test("majorOf reads the major, and refuses anything that is not a semver", () => {
  assertEquals(majorOf("7.0.0"), 7);
  assertEquals(majorOf("6.0.3"), 6);
  assertEquals(majorOf("10.2.1"), 10);
  assertEquals(majorOf(undefined), undefined);
  assertEquals(majorOf("dev"), undefined);
  assertEquals(majorOf("unknown"), undefined);
  assertEquals(majorOf(""), undefined);
});

Deno.test("the exact skew that shipped: CLI 6.0.3, library 7.0.0", () => {
  assertEquals(isMajorBehind("6.0.3", "7.0.0"), true);
});

Deno.test("same major is not a skew, however far the patch runs ahead", () => {
  assertEquals(isMajorBehind("7.0.0", "7.9.9"), false);
  assertEquals(isMajorBehind("6.0.0", "6.0.3"), false);
});

Deno.test("a CLI AHEAD of the library does not nag", () => {
  // Normal for a dev build between publishing the CLI and the library.
  assertEquals(isMajorBehind("8.0.0", "7.0.0"), false);
});

Deno.test("unknown data on either side never nags — same rule as isNewer", () => {
  // Offline, a JSR 404, or a dev build must not produce a warning built on
  // nothing. Crying wolf here trains people to ignore the one that matters.
  assertEquals(isMajorBehind(undefined, "7.0.0"), false);
  assertEquals(isMajorBehind("6.0.3", undefined), false);
  assertEquals(isMajorBehind("dev", "7.0.0"), false);
  assertEquals(isMajorBehind(undefined, undefined), false);
});
