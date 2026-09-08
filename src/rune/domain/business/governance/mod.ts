// Governance (WO-7 / D6 / closes G12).
//
// A locked org baseline sits under a project overlay. A project may TIGHTEN a
// rule (enable it, raise severity) but may not WEAKEN a locked rule (disable it
// or lower its severity) — "a linter you can edit to make yourself pass is not
// a linter". applyOverlay merges the overlay over the baseline, rejecting
// weakenings of locked rules and recording each rejection for the audit trail.

import type { LintRule } from "@rune/domain/business/artifact/mod.ts";

const RANK: Record<string, number> = { info: 0, warning: 1, error: 2 };

export interface OverlayResult {
  rules: LintRule[];
  /** Attempted weakenings of locked rules that were rejected (audit trail). */
  rejected: { id: string; reason: string; by?: string }[];
}

/** Would applying `next` to `base` weaken it? (disable, or lower severity) */
function weakens(base: LintRule, next: Partial<LintRule>): string | null {
  if (next.enabled === false && base.enabled) {
    return "cannot disable a locked rule";
  }
  if (next.severity && RANK[next.severity] < RANK[base.severity]) {
    return `cannot lower severity of a locked rule (${base.severity} -> ${next.severity})`;
  }
  return null;
}

/**
 * Merge a project overlay over the org baseline. Overlay entries are matched by
 * rule id. Locked rules accept tightening but reject weakening (the baseline
 * wins and the attempt is recorded). Non-locked rules take the overlay as-is.
 */
export function applyOverlay(
  baseline: LintRule[],
  overlay: Partial<LintRule>[],
  author?: string,
): OverlayResult {
  const byId = new Map(overlay.filter((o) => o.id).map((o) => [o.id!, o]));
  const rejected: OverlayResult["rejected"] = [];
  const rules = baseline.map((base) => {
    const next = byId.get(base.id);
    if (!next) return base;
    if (base.locked) {
      const reason = weakens(base, next);
      if (reason) {
        rejected.push({ id: base.id, reason, by: author });
        // keep the baseline's enabled/severity; allow non-weakening tweaks
        return {
          ...base,
          ...next,
          enabled: base.enabled,
          severity: base.severity,
          locked: true,
        };
      }
    }
    return { ...base, ...next };
  });
  return { rules, rejected };
}

/** True if the overlay leaves every locked rule at least as strict as baseline. */
export function overlayIsCompliant(
  baseline: LintRule[],
  overlay: Partial<LintRule>[],
): boolean {
  return applyOverlay(baseline, overlay).rejected.length === 0;
}
