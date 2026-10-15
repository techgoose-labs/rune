import { assertEquals } from "#std/assert";
import { DIAGNOSTIC_IDS, renderFinding } from "./mod.ts";

Deno.test("REQ-013: renderFinding is path:line: message [id]", () => {
  assertEquals(
    renderFinding({
      id: "cse-outside-ply",
      severity: "error",
      path: "specs/a.rune",
      line: 7,
      message: "[CSE] outside [PLY] block",
    }),
    "specs/a.rune:7: [CSE] outside [PLY] block [cse-outside-ply]",
  );
  // A whole-file finding has no line.
  assertEquals(
    renderFinding({
      id: "mod-underivable",
      severity: "error",
      path: "specs/a.rune",
      line: 0,
      message: "no [MOD] directive and could not derive module name",
    }),
    "specs/a.rune: no [MOD] directive and could not derive module name [mod-underivable]",
  );
});

Deno.test("REQ-013: diagnostic ids are unique", () => {
  assertEquals(new Set(DIAGNOSTIC_IDS).size, DIAGNOSTIC_IDS.length);
});
