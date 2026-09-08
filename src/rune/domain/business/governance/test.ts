import { assert, assertEquals } from "#std/assert";
import { applyOverlay, overlayIsCompliant } from "./mod.ts";
import type { LintRule } from "@rune/domain/business/artifact/mod.ts";

const rule = (over: Partial<LintRule> & { id: string }): LintRule => ({
  type: over.id,
  target: "generated",
  severity: "error",
  enabled: true,
  message: "x",
  ...over,
});

const baseline: LintRule[] = [
  rule({ id: "layer-restrictions", locked: true, severity: "error" }),
  rule({ id: "module-fragmentation", locked: false, severity: "warning" }),
];

Deno.test("a spec author cannot disable a locked rule", () => {
  const { rules, rejected } = applyOverlay(baseline, [{
    id: "layer-restrictions",
    enabled: false,
  }], "dev@team");
  assertEquals(rules.find((r) => r.id === "layer-restrictions")?.enabled, true);
  assertEquals(rejected.length, 1);
  assert(rejected[0].reason.includes("disable"));
  assertEquals(rejected[0].by, "dev@team");
});

Deno.test("a spec author cannot downgrade a locked rule's severity", () => {
  const { rules, rejected } = applyOverlay(baseline, [{
    id: "layer-restrictions",
    severity: "warning",
  }]);
  assertEquals(
    rules.find((r) => r.id === "layer-restrictions")?.severity,
    "error",
  );
  assertEquals(rejected.length, 1);
});

Deno.test("tightening a locked rule is allowed", () => {
  const base = [rule({ id: "x", locked: true, severity: "warning" })];
  const { rules, rejected } = applyOverlay(base, [{
    id: "x",
    severity: "error",
  }]);
  assertEquals(rules[0].severity, "error");
  assertEquals(rejected.length, 0);
});

Deno.test("non-locked rules take the overlay as-is", () => {
  const { rules } = applyOverlay(baseline, [{
    id: "module-fragmentation",
    enabled: false,
  }]);
  assertEquals(
    rules.find((r) => r.id === "module-fragmentation")?.enabled,
    false,
  );
});

Deno.test("overlayIsCompliant flags a weakening overlay", () => {
  assert(
    !overlayIsCompliant(baseline, [{
      id: "layer-restrictions",
      enabled: false,
    }]),
  );
  assert(
    overlayIsCompliant(baseline, [{
      id: "module-fragmentation",
      enabled: false,
    }]),
  );
});
