import { assert, assertEquals } from "#std/assert";
import { annotateAndFilter, resolveSettings } from "./mod.ts";
import type { LintRule } from "@rune/domain/business/artifact/mod.ts";
import type { EntryResult } from "@core/dto/types.ts";

const lint = (over: Partial<LintRule> & { type: string }): LintRule => ({
  id: over.type,
  target: "generated",
  severity: "error",
  enabled: true,
  message: "x",
  ...over,
});

const artifactLint: LintRule[] = [
  lint({ type: "no-relative-import", severity: "warning" }),
  lint({ type: "module-isolation", severity: "error" }),
];

const results: EntryResult[] = [
  {
    rule: "import-aliases",
    path: "a.ts",
    target: "ts",
    violations: ["uses ../"],
  },
  {
    rule: "module-isolation",
    path: "b.ts",
    target: "ts",
    violations: ["cross-module"],
  },
];

Deno.test("maps engine rule names to artifact severity", () => {
  const s = resolveSettings(artifactLint);
  assertEquals(s.get("import-aliases")?.severity, "warning");
  assertEquals(s.get("module-isolation")?.severity, "error");
});

Deno.test("annotates findings with severity", () => {
  const out = annotateAndFilter(results, resolveSettings(artifactLint));
  assertEquals(
    out.find((f) => f.rule === "import-aliases")?.severity,
    "warning",
  );
  assertEquals(
    out.find((f) => f.rule === "module-isolation")?.severity,
    "error",
  );
});

Deno.test("disabled rule is filtered out", () => {
  const disabled = artifactLint.map((r) =>
    r.type === "no-relative-import" ? { ...r, enabled: false } : r
  );
  const out = annotateAndFilter(results, resolveSettings(disabled));
  assert(!out.some((f) => f.rule === "import-aliases"));
  assert(out.some((f) => f.rule === "module-isolation"));
});

Deno.test("unmapped rule defaults to enabled/error", () => {
  const out = annotateAndFilter(
    [{
      rule: "fixture-promotion",
      path: "c.ts",
      target: "ts",
      violations: ["x"],
    }],
    resolveSettings(artifactLint),
  );
  assertEquals(out[0].severity, "error");
});
