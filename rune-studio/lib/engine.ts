// The studio's one door into the engine (REQ-035; closes gaps.md G6/G9 for
// parse and lint). The studio carries no parser, linter or codegen of its own:
// it calls the same modules `rune` runs — the grammar wasm parses, the checks
// judge, the manifest generates, the generated-code rules lint — so the preview
// is the engine's output by construction, not by approximation. Server-side
// only (the wasm loads from disk); the island talks to /api/check and
// /api/generate.

import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import { planManifest } from "@rune/domain/business/rune-manifest/mod.ts";
import { rules } from "@rune/mod-root.ts";
import {
  annotateAndFilter,
  resolveSettings,
} from "@rune/domain/business/lint-config/mod.ts";
import type { Finding } from "@rune/domain/business/diagnostics/mod.ts";
import type { EntryResult, PipelineContext } from "@core/dto/types.ts";
import { registry as BUNDLED } from "@rune/domain/business/registry/mod.ts";

// deno-lint-ignore no-explicit-any
type Registry = any;

/** A `specs/` path so the engine derives a module even when the spec omits
 * [MOD] (the studio editor's default). A real [MOD] in the spec still wins. */
const STUDIO_RUNE_PATH = "specs/spec.rune";

function options(registry?: Registry) {
  return registry
    ? {
      bindings: registry.bindings,
      codegen: registry.codegen?.templates,
      policies: registry.codegen?.policies,
    }
    : {};
}

/**
 * Generate the file tree for a .rune spec — the exact files the engine emits.
 * When a registry (the edited artifact) is passed, its bindings + codegen
 * templates drive the output, so editing the language in the UI changes real
 * generation with no engine recompile (WO-7 / L6 end-to-end).
 */
export function generate(source: string, registry?: Registry): { path: string; content: string }[] {
  const plan = planManifest(STUDIO_RUNE_PATH, source, new Set(), options(registry));
  if (plan.errors.length > 0) {
    throw new Error("parse/generate error:\n" + plan.errors.join("\n"));
  }
  return [...plan.toCreate, ...plan.toRegenerate].sort((a, b) => a.path.localeCompare(b.path));
}

/** A studio diagnostic: the engine's finding in the shape the editor paints
 * (1-based line; `ruleId` is the registry id). */
export interface Diagnostic {
  line: number;
  col: number;
  len: number;
  severity: string;
  message: string;
  ruleId: string;
  fix?: string;
}

const toDiagnostic = (f: Finding): Diagnostic => ({
  line: f.line,
  col: 0,
  len: 0,
  severity: f.severity,
  message: f.message,
  ruleId: f.id,
  ...(f.fix ? { fix: f.fix } : {}),
});

/** Every spec finding `rune check` would report for the source (parse + checks). */
export function check(source: string, registry?: Registry): Diagnostic[] {
  return planManifest(STUDIO_RUNE_PATH, source, new Set(), options(registry))
    .findings.map(toDiagnostic);
}

/** How many [REQ]s the spec declares (the studio's status line). */
export function reqCount(source: string): number {
  return parse(source).reqs.length;
}

/** The generated-code rule types the registry can toggle (the rule editor's menu). */
export function ruleTypes(registry: Registry = BUNDLED): string[] {
  return [
    ...new Set(
      (registry.lint as { target: string; type?: string }[])
        .filter((r) => r.target === "generated" && r.type)
        .map((r) => r.type as string),
    ),
  ];
}

// The import specifiers a source file names — the same regex the engine's
// filesystem context uses for its import graph.
function importsOf(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of content.matchAll(/import\s+["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

/**
 * Lint a set of files IN MEMORY with the engine's generated-code rules — the
 * studio's preview of its own generated tree, or a real directory the
 * filesystem bridge read. Spec files ride along (`.rune`) so the spec-backed
 * rules (presence, parity, orphans) see them. The registry's lint policy
 * (enabled / severity) applies exactly as in `rune lint`.
 */
export async function lintGenerated(
  files: { path: string; content: string }[],
  registry: Registry = BUNDLED,
): Promise<Diagnostic[]> {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const ctx: PipelineContext = {
    targetDir: "/studio",
    files: [...byPath.keys()],
    dirs: [...dirs],
    getFileContent: (rel) => Promise.resolve(byPath.get(rel) ?? ""),
    getImports: (rel) => Promise.resolve(importsOf(byPath.get(rel) ?? "")),
    lsp: null,
  };
  const entries = [
    ...ctx.dirs.map((p) => ({ path: p, target: "folder" as const })),
    ...ctx.files.map((p) => ({ path: p, target: p.split(".").pop() ?? "" })),
  ];
  const results: EntryResult[] = [];
  for (const rule of rules) {
    for (const e of entries) {
      let violations: string[] | null = null;
      try {
        violations = await rule.check(e.path, e.target, ctx);
      } catch {
        violations = null; // a rule that needs a real disk/LSP sits this out
      }
      if (violations && violations.length) {
        results.push({ path: e.path, target: e.target, rule: rule.name, violations });
      }
    }
  }
  return annotateAndFilter(results, resolveSettings(registry.lint)).map((f) => ({
    line: Number(f.message.match(/(?:^|\b)(?:line|L)\s*(\d+)/i)?.[1] ?? 0),
    col: 0,
    len: 0,
    severity: f.severity,
    message: `${f.path}: ${f.message}`,
    ruleId: f.rule,
  }));
}
