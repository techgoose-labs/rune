// Artifact-driven lint configuration (WO-4d / D3).
//
// The engine's 24 rules (mod-root.ts) carry the rule LOGIC; the artifact's
// type-keyed `lint` array carries the POLICY (enabled / severity / message).
// This module is the single place the two are reconciled: RULE_TYPE_MAP links
// each engine rule name to its artifact lint `type`, and resolveSettings ->
// annotateAndFilter apply the artifact's policy over rule results — so editing
// a rule's severity/enabled in the artifact changes a real `rune .`
// run with no rule-code change (L6). Rules with no artifact entry stay on
// (severity error) — their logic is unchanged, so their tests and the default
// lint output are byte-identical (L4 holds on the default path).
//
// "No rule logic in two places": the check() bodies live only in the rule
// modules; this layer is pure policy. The studio shares it in WO-5.

import type { EntryResult } from "@core/dto/types.ts";
import type { LintRule } from "@rune/domain/business/artifact/mod.ts";

export type Severity = "error" | "warning" | "info";

/** engine rule name -> artifact lint `type` (the reconciliation; see MERGE.md §D). */
export const RULE_TYPE_MAP: Record<string, string> = {
  "import-aliases": "no-relative-import",
  "external-imports": "no-external-import",
  "dto-validation": "dto-has-validation",
  "layer-restrictions": "layer-restrictions",
  "barrel-discipline": "barrel-discipline",
  "module-isolation": "module-isolation",
  "poly-isolation": "poly-isolation",
  "poly-detection": "poly-detection",
  "poly-stray": "poly-stray",
  "module-fragmentation": "module-fragmentation",
  "data-class-returns": "data-class-returns",
  "no-dto-cast": "no-dto-cast",
  "rune-signature-parity": "signature-parity",
  "rune-fault-coverage": "fault-coverage",
  "rune-extra-files": "orphan-files",
  "rune-heal-todo": "heal-todo",
  // `structure` splits into forbidden-dirs + loose-files; the presence rules
  // (rune-*-presence, rune-poly-cases, rune-dto-shape, rune-typ-shape) are
  // subsumed by codegen, and fixture-promotion has no artifact entry — all stay
  // on at error severity (no toggle), so they're omitted here intentionally.
};

export interface RuleSetting {
  enabled: boolean;
  severity: Severity;
}

/** Resolve per-engine-rule {enabled, severity} from the artifact's lint array. */
export function resolveSettings(lint: LintRule[]): Map<string, RuleSetting> {
  const byType = new Map<string, RuleSetting>();
  for (const r of lint) {
    if (!r.type) continue; // a coded spec rule has a checker, not a type
    byType.set(r.type, {
      enabled: r.enabled,
      severity: r.severity as Severity,
    });
  }
  const out = new Map<string, RuleSetting>();
  for (const [name, type] of Object.entries(RULE_TYPE_MAP)) {
    const s = byType.get(type);
    if (s) out.set(name, s);
  }
  return out;
}

export interface AnnotatedFinding {
  rule: string;
  path: string;
  severity: Severity;
  message: string;
}

/**
 * Apply the artifact policy to raw rule results: drop disabled rules, annotate
 * each finding with its severity, and return a stable, sorted list. Rules with
 * no setting default to enabled / error (unchanged behaviour).
 */
export function annotateAndFilter(
  results: EntryResult[],
  settings: Map<string, RuleSetting>,
): AnnotatedFinding[] {
  const out: AnnotatedFinding[] = [];
  for (const r of results) {
    const s = settings.get(r.rule);
    if (s && !s.enabled) continue;
    const severity = s?.severity ?? "error";
    for (const v of r.violations) {
      out.push({ rule: r.rule, path: r.path, severity, message: v });
    }
  }
  out.sort((a, b) =>
    a.rule.localeCompare(b.rule) ||
    a.path.localeCompare(b.path) ||
    a.severity.localeCompare(b.severity) ||
    a.message.localeCompare(b.message)
  );
  return out;
}
