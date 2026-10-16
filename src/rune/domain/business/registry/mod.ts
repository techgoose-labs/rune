// The registry, loaded (REQ-025/026). `lang/keywords.json` is the single
// source for the language's tables — modifiers, transports, faults, indent,
// columns, builtins — and for the rule catalogue every finding is rendered
// from. This module validates it once at startup and hands the engine typed
// views; nothing downstream carries a copy.

import ARTIFACT from "@keywords" with { type: "json" };
import { validateArtifact } from "@rune/domain/business/artifact/validate.ts";
import type {
  Artifact,
  LintRule,
  Modifier,
  Tag,
} from "@rune/domain/business/artifact/schema.ts";

const result = validateArtifact(ARTIFACT);
if (!result.ok || !result.artifact) {
  throw new Error(
    "lang/keywords.json is not a valid artifact:\n" +
      result.errors.map((e) => `  [${e.path}] ${e.message}`).join("\n"),
  );
}
export const registry: Artifact = result.artifact;

// ---- tags ------------------------------------------------------------------

export const tagById: ReadonlyMap<string, Tag> = new Map(
  registry.tags.map((t) => [t.id, t]),
);

// ---- modifiers -------------------------------------------------------------

export interface ModifierSpec {
  id: string;
  kind: Modifier["kind"];
  base: "string" | "number" | null;
  param: "none" | "number" | "text";
  values: readonly string[] | null;
  decorator: string | null;
  call(value: string | null): string;
  eachCall(value: string | null): string;
}

function substitute(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? m : String(v);
  });
}

export const modifiers: ReadonlyMap<string, ModifierSpec> = new Map(
  registry.modifiers.map((m) => [m.id, {
    id: m.id,
    kind: m.kind,
    base: m.base,
    param: m.param,
    values: m.values ?? null,
    decorator: m.decorator ?? null,
    call: (value) => m.call ? substitute(m.call, { value }) : "",
    eachCall: (value) => m.eachCall ? substitute(m.eachCall, { value }) : "",
  }]),
);

/** The modifiers a tag accepts in its bracket slot, as written. */
export function modifiersFor(tagId: string): string[] {
  return registry.modifiers.filter((m) => m.appliesTo.includes(tagId)).map((
    m,
  ) => m.param === "none" ? m.id : `${m.id}=<${m.param === "number" ? "n" : (m.values ? m.values.join("|") : "value")}>`);
}

// ---- transports / faults / indent / columns --------------------------------

export const transports: readonly string[] = registry.transports.map((t) =>
  t.id
);

export const FAULT_MARKER = registry.faults.marker;
export const FAULT_SHAPE = new RegExp(registry.faults.shape);

/** The HTTP status of a well-known fault name (a `prefix-*` glob matches the
 * prefix itself and any `prefix-…`), or null for a custom fault. */
export function wellKnownFault(name: string): number | null {
  for (const f of registry.faults.wellKnown) {
    if (f.id.endsWith("-*")) {
      const prefix = f.id.slice(0, -2);
      if (name === prefix || name.startsWith(prefix + "-")) return f.status;
    } else if (f.id === name) return f.status;
  }
  return null;
}

export const columns = registry.columns;

// ---- the rule catalogue ----------------------------------------------------

/** The ids the engine implements as code, by hand (REQ-026). Every id here is
 * a `checker` in the registry's lint list, and every coded registry rule is
 * here — the artifact test holds both directions. The parser, the checks and
 * the manifest each declare the subset they emit (`EMITS`), and the union of
 * those must be exactly this list. */
export const SPEC_CHECKERS = new Set<string>([
  // parse
  "mod-name",
  "mod-name-shape",
  "mod-duplicate",
  "mod-underivable",
  "req-signature",
  "req-modifier",
  "req-core",
  "ent-signature",
  "ent-method",
  "ent-body-signature",
  "ent-body-modifier",
  "ws-topic-shape",
  "ws-header-signature",
  "ws-no-topics",
  "srv-shape",
  "srv-transport",
  "srv-docs-url",
  "srv-docs-duplicate",
  "srv-docs-required",
  "dto-props",
  "dto-modifier",
  "dto-prop-undefined",
  "typ-type",
  "typ-modifier-unknown",
  "typ-modifier-base",
  "typ-modifier-value",
  "typ-modifier-no-value",
  "typ-modifier-choice",
  "non-name",
  "ply-signature",
  "ply-outside-req",
  "ply-nested",
  "cse-name",
  "cse-outside-ply",
  "new-name",
  "ctr-retired",
  "ret-value",
  "boundary-signature",
  "step-outside-req",
  "fault-outside-step",
  "fault-shape",
  "fault-marker",
  "unrecognized-line",
  // manifest (cross-element, needs the project)
  "srv-outside-core",
  "core-spec-missing",
  "service-undeclared",
  "ent-delegate-required",
  "ent-delegate-undefined",
  "surface-mixed",
  "ply-cases",
  // checks (scope, references, prose rules)
  "from-path-retired",
  "class-retired",
  "fault-status",
  "req-input-dto",
  "req-output-dto",
  "boundary-types",
  "signature-consistency",
  "duplicate-req-signature",
  "missing-return-type",
  "last-step-returns-output",
  "type-not-dto",
  "noun-in-scope",
  "param-scope",
  "undefined-ref",
  "value-duplicate",
  "ret-redundant",
  "unbound-input-needs-example",
  "edit-record-endpoint",
  "reserved-verb",
]);

/** The shape-rule types the engine implements generically from `params`. */
export const SHAPE_TYPES = new Set<string>([
  "max-line-length",
  "tag-indent",
  "name-suffix",
  "required-description",
  "unique-names",
  "unused",
]);

export const lintById: ReadonlyMap<string, LintRule> = new Map(
  registry.lint.map((r) => [r.id, r]),
);

/** The registry's spec rules of one shape type (e.g. every `unused` rule). */
export function shapeRules(type: string): LintRule[] {
  return registry.lint.filter((r) =>
    r.target === "spec" && !r.checker && r.type === type
  );
}

export function isEnabled(id: string): boolean {
  return lintById.get(id)?.enabled ?? true;
}

export function severityOf(id: string): "error" | "warning" {
  const s = lintById.get(id)?.severity;
  return s === "warning" ? "warning" : "error";
}

/** The rule's message, `{var}` placeholders substituted. An unknown id is a
 * programming error — every finding the engine emits is a registry rule. */
export function message(id: string, vars: Record<string, unknown> = {}): string {
  const rule = lintById.get(id);
  if (!rule) throw new Error(`rune: no registry rule "${id}"`);
  return substitute(rule.message, { ...rule.params, ...vars });
}

/** The rule's fix hint, substituted, or undefined when the rule has none. */
export function fixFor(
  id: string,
  vars: Record<string, unknown> = {},
): string | undefined {
  const rule = lintById.get(id);
  if (!rule?.fix) return undefined;
  const fix = substitute(rule.fix, { ...rule.params, ...vars });
  return fix === "{fix}" ? undefined : fix;
}

/** The `--explain` text for a rule id, or null for an unknown id. */
export function explain(id: string): string | null {
  const rule = lintById.get(id);
  if (!rule) return null;
  const lines = [
    `${rule.id} — ${rule.severity}${rule.enabled ? "" : " (disabled)"}`,
    `  target:  ${rule.target}`,
    `  message: ${rule.message}`,
  ];
  if (rule.fix) lines.push(`  fix:     ${rule.fix}`);
  if (rule.doc) lines.push("", `  ${rule.doc}`);
  return lines.join("\n");
}
