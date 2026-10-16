// Artifact migrations (WO-7 / D5 / closes the versioning half of G8).
//
// When the language schema bumps, existing artifacts must keep working. Each
// migration upgrades one schemaVersion to the next; migrate() runs the chain
// from whatever version an artifact carries up to CURRENT, so an N-1 artifact
// still validates and still generates under N (L7). Generated output is
// stamped with the version that produced it (see rune-manifest HEADER + this
// version).

import { bindings as DEFAULT_BINDINGS } from "@rune/domain/business/rune-bindings/mod.ts";
import { DEFAULT_TEMPLATES } from "@rune/domain/business/rune-manifest/mod.ts";
import { registry, SHAPE_TYPES } from "@rune/domain/business/registry/mod.ts";

const CURRENT_SCHEMA_VERSION = "2.0.0";

// deno-lint-ignore no-explicit-any
type Artifact = Record<string, any>;

export interface MigrationResult {
  artifact: Artifact;
  from: string;
  to: string;
  applied: string[];
}

/** Upgrade a pre-1.0.0 artifact to 1.0.0: stamp the version and fill the codegen
 * sections the engine now expects (bindings + templates) from the defaults. */
function to_1_0_0(a: Artifact, applied: string[]): Artifact {
  const out = { ...a };
  if (!out.schemaVersion) {
    out.schemaVersion = "1.0.0";
    applied.push("stamp schemaVersion 1.0.0");
  }
  if (!out.bindings) {
    out.bindings = structuredClone(DEFAULT_BINDINGS);
    applied.push("seed codegen bindings from engine defaults");
  }
  if (!out.codegen) {
    out.codegen = { templates: { ...DEFAULT_TEMPLATES } };
    applied.push("seed codegen.templates from engine defaults");
  }
  return out;
}

/** Upgrade a 1.x artifact to 2.0.0 (REQ-025/026/027): the language tables the
 * engine now reads from the artifact (modifiers with their full spec,
 * transports, faults, indent, columns), the hardened rule catalogue (every spec
 * rule a checker or a shape type), tag shape rules, and the retired content
 * gone — boundary prefixes, the [CTR] synonym, the Class builtin, prose rules. */
function to_2_0_0(a: Artifact, applied: string[]): Artifact {
  const out: Artifact = { ...a, schemaVersion: "2.0.0" };
  applied.push("stamp schemaVersion 2.0.0");
  if (out.boundaries) {
    delete out.boundaries;
    applied.push("drop boundaries.prefixes (services are declared by [SRV])");
  }
  if (Array.isArray(out.builtins) && out.builtins.includes("Class")) {
    out.builtins = out.builtins.filter((b: string) => b !== "Class");
    applied.push("drop the Class builtin (a noun is a [NON])");
  }
  const liveTag = new Map(registry.tags.map((t) => [t.id, t]));
  out.tags = (out.tags ?? []).map((t: Artifact) => {
    const { rules, synonyms, ...rest } = t;
    const live = liveTag.get(t.id);
    if (synonyms) applied.push(`drop synonyms of ${t.tag}`);
    if (Array.isArray(rules) && rules.length) {
      rest.summary = [rest.summary, ...rules].filter(Boolean).join(" ");
      applied.push(`fold the prose rules of ${t.tag} into its summary`);
    }
    rest.shapeRule ??= live?.shapeRule ?? "unrecognized-line";
    return rest;
  });
  for (const key of ["transports", "faults", "indent", "columns"] as const) {
    if (!out[key]) {
      out[key] = structuredClone(registry[key]);
      applied.push(`seed ${key} from the registry`);
    }
  }
  const liveMod = new Map(registry.modifiers.map((m) => [m.id, m]));
  out.modifiers = (out.modifiers ?? []).map((m: Artifact) => {
    const id = m.id === "open-req" ? "open" : m.id;
    const live = liveMod.get(id);
    return live ? { ...structuredClone(live), appliesTo: m.appliesTo ?? live.appliesTo } : {
      kind: "routing",
      base: null,
      param: "none",
      ...m,
      id,
    };
  });
  applied.push("expand modifiers to their full spec");
  // The rule catalogue: the live spec rules replace the 1.x spec entries (a
  // 1.x id that no longer exists was a prose-only policy); generated-code
  // rules are kept, merged by id over the live ones.
  const oldGenerated = (out.lint ?? []).filter((r: Artifact) => r.target === "generated");
  const liveGenerated = new Map(
    registry.lint.filter((r) => r.target === "generated").map((r) => [r.id, r]),
  );
  for (const r of oldGenerated) liveGenerated.set(r.id, { ...liveGenerated.get(r.id), ...r });
  out.lint = [
    ...registry.lint.filter((r) => r.target === "spec" && (r.checker || SHAPE_TYPES.has(r.type ?? ""))).map((r) => structuredClone(r)),
    ...liveGenerated.values(),
  ];
  applied.push("rebuild the rule catalogue: every spec rule names a checker or a shape type");
  return out;
}

/** Run the migration chain from the artifact's version up to CURRENT. */
export function migrate(input: Artifact): MigrationResult {
  const from = String(input.schemaVersion ?? "0.0.0");
  const applied: string[] = [];
  let artifact = input;

  // 0.x -> 1.0.0
  if (major(from) < 1) {
    artifact = to_1_0_0(artifact, applied);
  }
  // 1.x -> 2.0.0
  if (major(from) < 2) {
    artifact = to_2_0_0(artifact, applied);
  }
  artifact = { ...artifact, schemaVersion: CURRENT_SCHEMA_VERSION };

  return { artifact, from, to: CURRENT_SCHEMA_VERSION, applied };
}

function major(v: string): number {
  return Number(v.split(".")[0]) || 0;
}
