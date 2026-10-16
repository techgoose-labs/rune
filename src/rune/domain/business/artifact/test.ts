import { assert, assertEquals } from "#std/assert";
import { validateArtifact } from "./validate.ts";
import type { Artifact } from "./schema.ts";

const base = (): Artifact => ({
  name: "Test",
  schemaVersion: "2.0.0",
  tags: [
    { id: "dto", tag: "[DTO]", label: "DTO", indent: 0, follows: "dtodef", shapeRule: "r1" },
    { id: "ply", tag: "[PLY]", label: "Poly", indent: 4, follows: "poly", shapeRule: "r1" },
    { id: "cse", tag: "[CSE]", label: "Case", indent: 8, follows: "case", shapeRule: "r1" },
  ],
  modifiers: [{
    id: "core",
    token: ":core",
    appliesTo: ["dto"],
    kind: "routing",
    base: null,
    param: "none",
  }],
  transports: [{ id: "HTTP", summary: "http" }],
  faults: {
    marker: "!",
    syntax: "! name",
    shape: "^[a-z][a-z0-9-]*$",
    summary: "faults",
    wellKnown: [{ id: "not-found", status: 404, summary: "missing" }],
  },
  indent: {
    unit: 4,
    step: 4,
    fault: 6,
    case: 8,
    caseStep: 8,
    caseFault: 10,
    description: 4,
    body: 4,
    faultOffset: 2,
  },
  columns: { max: 80 },
  builtins: ["string"],
  tokens: {},
  lint: [
    {
      id: "r1",
      type: "name-suffix",
      target: "spec",
      severity: "error",
      enabled: true,
      params: { tag: "dto" },
      message: "x",
    },
  ],
});

Deno.test("accepts a structurally + semantically valid artifact", () => {
  const r = validateArtifact(base());
  assert(r.ok, r.errors.map((e) => e.message).join("; "));
});

Deno.test("rejects a duplicate tag id", () => {
  const a = base();
  a.tags.push({
    id: "dto",
    tag: "[DTX]",
    label: "Dup",
    indent: 0,
    follows: "dtodef",
    shapeRule: "r1",
  });
  const r = validateArtifact(a);
  assert(!r.ok);
  assert(r.errors.some((e) => e.message.includes("duplicate tag id")));
});

Deno.test("rejects an unknown modifier target", () => {
  const a = base();
  a.modifiers![0].appliesTo = ["ghost"];
  const r = validateArtifact(a);
  assert(!r.ok);
  assert(r.errors.some((e) => e.message.includes("applies to unknown tag id")));
});

Deno.test("rejects contradictory indent (case not deeper than poly)", () => {
  const a = base();
  a.tags[2].indent = 2;
  const r = validateArtifact(a);
  assert(!r.ok);
  assert(r.errors.some((e) => e.message.includes("contradictory indent")));
});

Deno.test("rejects a bad schemaVersion structurally", () => {
  // deno-lint-ignore no-explicit-any
  const a = { ...base(), schemaVersion: "v1" } as any;
  const r = validateArtifact(a);
  assert(!r.ok);
  assertEquals(r.errors.some((e) => e.path.includes("schemaVersion")), true);
});

Deno.test("flags a profile gap (inconsistent var keys)", () => {
  const a = base();
  a.profiles = [
    { id: "deno", vars: { runtime: "deno", ext: "ts" } },
    { id: "node", vars: { runtime: "node" } },
  ];
  const r = validateArtifact(a);
  assert(!r.ok);
  assert(r.errors.some((e) => e.message.includes("gap")));
});

Deno.test("accepts constraint modifiers with kind/decorator/param", () => {
  const a = base();
  a.modifiers!.push(
    {
      id: "uuid",
      token: ":uuid",
      appliesTo: ["dto"],
      kind: "constraint",
      base: "string",
      decorator: "IsUUID",
      param: "none",
    },
    {
      id: "min",
      token: ":min",
      appliesTo: ["dto"],
      kind: "constraint",
      base: "number",
      decorator: "Min",
      param: "number",
    },
  );
  const r = validateArtifact(a);
  assert(r.ok, r.errors.map((e) => e.message).join("; "));
  // the optional fields must survive the parse (zod strips unknown keys)
  const uuid = r.artifact!.modifiers!.find((m) => m.id === "uuid")!;
  assertEquals(uuid.decorator, "IsUUID");
  assertEquals(uuid.kind, "constraint");
  assertEquals(uuid.param, "none");
});

// ---- canonical layout folded into the artifact (single source of truth) ----

Deno.test("canonicalPaths is sourced from the keywords.json artifact", async () => {
  const { canonicalPaths } = await import("./canonical-paths.ts");
  // the structure rule depends on these top-level keys + the module node
  assert(canonicalPaths, "canonicalPaths present in the artifact");
  assert(
    Array.isArray(canonicalPaths["$rootFiles"]),
    "$rootFiles list present",
  );
  assert(
    "<module-name>/" in canonicalPaths["src/"],
    "module node present under src/",
  );
  // and it must match what the artifact actually carries (no drift)
  const kw = JSON.parse(
    await Deno.readTextFile(
      new URL("../../../../../lang/keywords.json", import.meta.url),
    ),
  );
  assertEquals(canonicalPaths, kw.canonicalPaths);
});

// ---- REQ-025/026/027 — the registry is the single source (Phase 3) ----
import {
  FAULT_MARKER,
  lintById,
  modifiers,
  registry,
  SHAPE_TYPES,
  SPEC_CHECKERS,
  transports,
  wellKnownFault,
} from "@rune/domain/business/registry/mod.ts";
import { EMITS as PARSE_EMITS } from "@rune/domain/business/rune-parse/mod.ts";
import { EMITS as CHECK_EMITS } from "@rune/domain/business/rune-checks/mod.ts";
import { EMITS as MANIFEST_EMITS } from "@rune/domain/business/rune-manifest/mod.ts";
// The shape rules the checks emit generically (by registry type, not by checker).
const SHAPE_RULE_IDS = new Set(
  registry.lint.filter((r) => r.target === "spec" && !r.checker).map((r) => r.id),
);

Deno.test("REQ-025: the engine's modifier, transport, fault and indent tables are the registry's", () => {
  for (const m of registry.modifiers) {
    const spec = modifiers.get(m.id);
    assert(spec, `modifier ${m.id} missing from the engine table`);
    assertEquals(spec.base, m.base);
    assertEquals(spec.param, m.param);
    assertEquals(spec.decorator ?? null, m.decorator ?? null);
  }
  assertEquals(modifiers.get("min")!.call("0"), "@Min(0)");
  assertEquals(modifiers.get("min")!.eachCall("0"), "@Min(0, { each: true })");
  assertEquals(modifiers.get("uuid")!.call(null), "@IsUUID()");
  assertEquals(modifiers.get("from")!.values, ["query", "header"]);
  assertEquals(transports, registry.transports.map((t) => t.id));
  assertEquals(wellKnownFault("not-found"), 404);
  assertEquals(wellKnownFault("invalid-id"), 422);
  assertEquals(wellKnownFault("invalid"), 422);
  assertEquals(wellKnownFault("card-expired"), null);
  assertEquals(FAULT_MARKER, registry.faults.marker);
  assertEquals(registry.indent.step, 4);
  assertEquals(registry.indent.faultOffset, 2);
  assertEquals(registry.columns.max, 80);
  assertEquals(registry.builtins.includes("Class"), false);
});

Deno.test("REQ-026: every spec lint names a checker the engine implements and every engine checker is a registry lint", () => {
  const specRules = registry.lint.filter((r) => r.target === "spec");
  for (const r of specRules) {
    if (r.checker) {
      assert(SPEC_CHECKERS.has(r.checker), `lint ${r.id}: checker ${r.checker} is not implemented`);
      assertEquals(r.checker, r.id, `lint ${r.id}: a coded rule's checker is its id`);
    } else {
      assert(SHAPE_TYPES.has(r.type ?? ""), `lint ${r.id}: shape type ${r.type} has no generic implementation`);
    }
    assert(r.doc && r.doc.length > 0, `lint ${r.id} has no doc for --explain`);
  }
  const declared = new Set(specRules.map((r) => r.id));
  for (const id of SPEC_CHECKERS) {
    assert(declared.has(id), `engine checker ${id} is not a registry lint`);
  }
  // Both directions, by implementation: the ids the parser, the checks and the
  // manifest actually emit are exactly the engine's declared checkers.
  const emitted = new Set<string>([...PARSE_EMITS, ...CHECK_EMITS, ...MANIFEST_EMITS]);
  for (const id of emitted) {
    assert(SHAPE_RULE_IDS.has(id) || SPEC_CHECKERS.has(id), `emitted id ${id} is neither a checker nor a shape rule`);
  }
  assertEquals([...emitted].filter((id) => !SHAPE_RULE_IDS.has(id)).sort(), [...SPEC_CHECKERS].sort());
  for (const id of SHAPE_RULE_IDS) assert(emitted.has(id), `shape rule ${id} is emitted by nothing`);
  for (const type of SHAPE_TYPES) {
    assert(specRules.some((r) => !r.checker && r.type === type), `shape type ${type} is declared by no lint`);
  }
  for (const t of registry.tags) {
    assertEquals("rules" in t, false, `tag ${t.id} still carries prose rules`);
    assert(t.shapeRule && lintById.has(t.shapeRule), `tag ${t.id} shape rule unknown`);
  }
});

Deno.test("REQ-027: the registry carries no boundary prefixes and no new/generate.mjs reference, and neither do the generated grammar headers", async () => {
  assertEquals("boundaries" in registry, false);
  assertEquals((registry.description ?? "").includes("new/generate.mjs"), false);
  const root = new URL("../../../../../", import.meta.url);
  for (const f of ["lang/grammar/grammar.js", "lang/queries/highlights.scm", "lang/grammar/src/scanner-config.h"]) {
    const text = await Deno.readTextFile(new URL(f, root));
    assertEquals(text.includes("new/generate.mjs"), false, `${f} names new/generate.mjs`);
    assertEquals(text.includes("new/keywords.json"), false, `${f} names new/keywords.json`);
  }
  const grammar = await Deno.readTextFile(new URL("lang/grammar/grammar.js", root));
  assertEquals(grammar.includes("[CTR]"), false, "the grammar still accepts [CTR]");
});
