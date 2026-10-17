// Diagnostics — the one shape every `rune check` finding takes (REQ-013).
//
// A Finding carries a stable rule id so an LLM, an editor, or a parity gate can
// act on it mechanically; the message is for a reader. `plan.errors` and the
// CLI's text output are RENDERINGS of findings (`renderFinding`), never a second
// source. The id catalogue is the registry's lint list (REQ-026): every id the
// engine emits is a `lang/keywords.json` rule, and the message, fix and
// severity come from there (see `@rune/domain/business/registry/mod.ts`).

export type Severity = "error" | "warning";

/** A registry lint id. */
export type DiagnosticId = string;

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
