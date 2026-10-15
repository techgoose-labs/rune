// Diagnostics — the one shape every `rune check` finding takes (REQ-013).
//
// A Finding carries a stable rule id so an LLM, an editor, or a parity gate can
// act on it mechanically; the message is for a reader. `plan.errors` and the
// CLI's text output are RENDERINGS of findings (`renderFinding`), never a second
// source. The id catalogue lives here until Phase 3.2 of todos/09-one-source.md
// moves it into the registry's lint list.

export type Severity = "error" | "warning";

export const DIAGNOSTIC_IDS = [
  // ---- parse: line shape / structure ----
  "mod-name",
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
  "typ-modifier",
  "non-name",
  "ply-signature",
  "ply-outside-req",
  "ply-nested",
  "cse-name",
  "cse-outside-ply",
  "new-class",
  "ret-value",
  "boundary-signature",
  "step-outside-req",
  "unrecognized-line",
  "line-length",
  // ---- manifest: cross-element rules ----
  "srv-outside-core",
  "core-spec-missing",
  "service-undeclared",
  "ent-delegate-undefined",
  "ent-ambiguous",
  "surface-mixed",
  "ply-cases",
] as const;

export type DiagnosticId = typeof DIAGNOSTIC_IDS[number];

export interface Finding {
  id: DiagnosticId;
  severity: Severity;
  /** The spec path as given to the engine (relative to the project root). */
  path: string;
  /** 1-based line; 0 = the whole file. */
  line: number;
  message: string;
  /** What to change, when the rule can say so. */
  fix?: string;
}

/** `path:line: message [id]` — the one text rendering of a finding. */
export function renderFinding(f: Finding): string {
  const where = f.line > 0 ? `${f.path}:${f.line}` : f.path;
  return `${where}: ${f.message} [${f.id}]`;
}
