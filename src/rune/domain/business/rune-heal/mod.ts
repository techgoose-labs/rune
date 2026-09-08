// Heal-rules scaffolding: turn the fault slugs a project's endpoints declare
// into a starter `spec/misc/heal-rules.json` for keep's cake self-healing panel.
//
// keep owns the generic heal tier (missing $input → run producer, validation →
// fix field, timeout/unauthorized → retry); the PROJECT owns the slug-specific
// rules. rune knows every endpoint's fault slugs from the spec, so it emits the
// starter content keyed on exactly the vocabulary keep matches on (the failed
// response body's `message`). That slug→suggestion shape is the cross-repo
// contract keep and rune keep in lockstep.
//
// Pure: text in → JSON value out. The sync entrypoint does the file I/O and the
// merge-don't-clobber write.

import {
  type BoundaryStepNode,
  type EntNode,
  parse,
  type PlyNode,
  type ReqNode,
  type StepLike,
  type StepNode,
} from "@rune/domain/business/rune-parse/mod.ts";

/** One client action keep's healer can offer for a slug. `kind` is one of keep's
 * existing actions (run-step / set-input / pick / remove-key / set-body-field /
 * retry / note); unknown kinds and extra fields are ignored by keep (forward
 * compat), so the scaffold marker `todo` rides along safely. */
export interface HealSuggestion {
  kind: string;
  match?: string;
  target?: string;
  fromPlural?: string;
  value?: string;
  label?: string;
  why?: string;
  retryAfter?: boolean;
  /** Scaffold marker: rune emitted this entry; a human/LLM should enrich it. */
  todo?: boolean;
}

/** The heal-rules file shape: `v: 1` + a slug→suggestions map. */
export interface HealRules {
  v: 1;
  slugs: Record<string, HealSuggestion[]>;
}

// keep recognizes a slug when it matches this regex (the `message` of a failed
// body) — or is one of the two reserved generics it heals itself.
const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

// keep's generic tier already heals these; the per-project file must not shadow
// them. A project that literally declares `timeout` (todos does) gets keep's
// retry rule, not a scaffold.
const RESERVED_GENERIC = new Set(["timeout", "unauthorized"]);

// ---- plan: specs → scaffold ------------------------------------------------

export interface HealPlan {
  /** Scaffold suggestions per NEW slug, ready to merge into the file. */
  scaffold: Record<string, HealSuggestion[]>;
  /** Every endpoint-attributed slug found (sorted) — the file's target keys. */
  slugs: string[];
  /** slug → the endpoint ids (ent actions) that can raise it (sorted, deduped). */
  raisedBy: Record<string, string[]>;
}

/**
 * Plan the heal-rules scaffold across every project spec. A slug counts only
 * when an `[ENT]` endpoint dispatches to the `[REQ]` that declares the fault —
 * a fault on a REQ no endpoint reaches never surfaces as an HTTP failure, so it
 * gets no rule. Specs with parse errors contribute nothing (sync reports them
 * elsewhere). Reserved generics (timeout/unauthorized) and non-slug fault names
 * are excluded — keep heals those generically.
 */
export function planHealRules(
  specs: { path: string; text: string }[],
): HealPlan {
  const raisedBy = new Map<string, Set<string>>();
  const allEndpoints = new Set<string>();

  for (const spec of specs) {
    const ast = parse(spec.text);
    if (ast.errors.length > 0) continue;
    const reqByKey = new Map(ast.reqs.map((r) => [`${r.noun}.${r.verb}`, r]));

    for (const ent of ast.ents) allEndpoints.add(ent.action);

    for (const ent of ast.ents) {
      const req = matchReq(ent, ast.reqs, reqByKey);
      if (!req) continue;
      for (const slug of reqSlugs(req)) {
        let set = raisedBy.get(slug);
        if (!set) raisedBy.set(slug, set = new Set());
        set.add(ent.action);
      }
    }
  }

  const endpoints = [...allEndpoints];
  const slugs = [...raisedBy.keys()].sort();
  const scaffold: Record<string, HealSuggestion[]> = {};
  const raisedByOut: Record<string, string[]> = {};
  for (const slug of slugs) {
    const raising = [...raisedBy.get(slug)!].sort();
    raisedByOut[slug] = raising;
    scaffold[slug] = scaffoldFor(slug, raising, endpoints);
  }
  return { scaffold, slugs, raisedBy: raisedByOut };
}

// The [REQ] an [ENT] dispatches to: an explicit body `[REQ]` names it exactly;
// otherwise match on the (input, output) DTO pair. Mirrors the entrypoint
// controller codegen so attribution matches the routes keep actually serves.
function matchReq(
  ent: EntNode,
  reqs: ReqNode[],
  reqByKey: Map<string, ReqNode>,
): ReqNode | null {
  if (ent.delegate) {
    return reqByKey.get(`${ent.delegate.noun}.${ent.delegate.verb}`) ?? null;
  }
  return reqs.find((r) => r.input === ent.input && r.output === ent.output) ??
    null;
}

// Every keep-recognized fault slug a [REQ] declares, walking ordinary/boundary
// steps and [PLY] case steps. Reserved generics and non-slug names are dropped.
function reqSlugs(req: ReqNode): Set<string> {
  const out = new Set<string>();
  const visit = (steps: readonly StepLike[]) => {
    for (const step of steps) {
      if (isFaultBearing(step)) {
        for (const f of step.faults) {
          if (SLUG_RE.test(f) && !RESERVED_GENERIC.has(f)) out.add(f);
        }
      }
      if (step.kind === "ply") {
        visit((step as PlyNode).cases.flatMap((c) => c.steps));
      }
    }
  };
  visit(req.steps);
  return out;
}

function isFaultBearing(
  step: StepLike,
): step is StepNode | BoundaryStepNode {
  return step.kind === "step" || step.kind === "boundary";
}

// ---- scaffold per slug -----------------------------------------------------

function scaffoldFor(
  slug: string,
  raising: string[],
  allEndpoints: string[],
): HealSuggestion[] {
  const runStep = inferRunStep(slug, raising, allEndpoints);
  if (runStep) return [runStep];
  const where = raising.length ? ` (raised by: ${raising.join(", ")})` : "";
  return [{
    kind: "note",
    label: `TODO: describe the one-click fix for "${slug}"`,
    why: `TODO: explain when "${slug}" fires and how to recover${where}`,
    todo: true,
  }];
}

// Naming-convention signal: a slug like `not-enabled` names a precondition. Strip
// the negation/absence words and, if a non-raising endpoint id matches the
// remaining stem, suggest running it first (a `run-step` keyed by a /stem/i regex
// over endpoint ids — keep's own example shape). Conservative: returns null
// unless a real endpoint matches, so the fallback note covers everything else.
function inferRunStep(
  slug: string,
  raising: string[],
  allEndpoints: string[],
): HealSuggestion | null {
  const pool = allEndpoints.filter((e) => !raising.includes(e));
  if (pool.length === 0) return null;
  // Longest stem first → the most specific match wins.
  const candidates = stems(slug).sort((a, b) => b.length - a.length);
  for (const stem of candidates) {
    if (stem.length < 4) continue; // too short → noisy substring hits
    const ep = pool.find((e) => e.toLowerCase().includes(stem));
    if (ep) {
      return {
        kind: "run-step",
        match: `/${stem}/i`,
        why:
          `"${slug}" looks like a missing precondition — an endpoint matching ` +
          `/${stem}/i (e.g. ${ep}) may need to run first; verify and refine`,
        todo: true,
      };
    }
  }
  return null;
}

// Affix words that wrap a precondition noun/verb in a fault slug.
const NEG_PREFIX = new Set([
  "not",
  "no",
  "missing",
  "un",
  "without",
  "needs",
  "need",
  "requires",
  "require",
]);
const ABSENT_SUFFIX = new Set([
  "required",
  "missing",
  "needed",
  "absent",
  "unset",
  "unconfigured",
  "disabled",
]);

// Candidate stems for the run-step match: the slug's core word(s) with negation/
// absence affixes peeled off, plus light de-conjugation (drop a trailing -ed/-d/-s)
// so `enabled` reaches the endpoint `enable`.
function stems(slug: string): string[] {
  let words = slug.split("-");
  while (words.length > 1 && NEG_PREFIX.has(words[0])) words = words.slice(1);
  while (
    words.length > 1 && ABSENT_SUFFIX.has(words[words.length - 1])
  ) words = words.slice(0, -1);
  const core = words.join("");
  const out = new Set<string>();
  if (core.length >= 3) {
    out.add(core);
    if (core.endsWith("ed")) out.add(core.slice(0, -2));
    if (core.endsWith("d")) out.add(core.slice(0, -1));
    if (core.endsWith("s")) out.add(core.slice(0, -1));
  }
  return [...out];
}

// ---- merge: never clobber human edits --------------------------------------

export interface HealMerge {
  result: HealRules;
  added: string[]; // slugs newly scaffolded this run
  stale: string[]; // existing slugs no longer declared by any endpoint
  changed: boolean; // result differs from `existing`
}

/**
 * Merge the scaffold into the existing file, per the coordination contract:
 * - add an entry for every NEW slug,
 * - keep every existing slug's suggestions byte-for-byte (human/LLM-owned),
 * - never delete: a slug the spec no longer declares is KEPT and surfaced as
 *   `stale` so a human can prune it deliberately.
 * Existing key order is preserved (minimal diffs); new slugs are appended sorted.
 */
export function mergeHealRules(
  existing: HealRules | null,
  scaffold: Record<string, HealSuggestion[]>,
): HealMerge {
  const existingSlugs = existing?.slugs ?? {};
  const result: HealRules = { v: 1, slugs: {} };

  // Preserve existing entries in their original order, untouched.
  for (const [slug, sugg] of Object.entries(existingSlugs)) {
    result.slugs[slug] = sugg;
  }
  // Append new slugs (sorted) — only those not already present.
  const added: string[] = [];
  for (const slug of Object.keys(scaffold).sort()) {
    if (slug in result.slugs) continue;
    result.slugs[slug] = scaffold[slug];
    added.push(slug);
  }
  const scaffoldSlugs = new Set(Object.keys(scaffold));
  const stale = Object.keys(existingSlugs)
    .filter((s) => !scaffoldSlugs.has(s))
    .sort();

  const changed = existing === null ||
    JSON.stringify(existing) !== JSON.stringify(result);
  return { result, added, stale, changed };
}

// ---- (de)serialization -----------------------------------------------------

/** Read a parsed JSON value as HealRules, leniently. Returns null when the value
 * isn't a heal-rules document (no `slugs` object and no `v`) so the caller can
 * leave an unrelated/hand-shaped file untouched rather than overwrite it. */
export function readHealRules(parsed: unknown): HealRules | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const hasSlugs = obj.slugs && typeof obj.slugs === "object" &&
    !Array.isArray(obj.slugs);
  if (!hasSlugs && !("v" in obj)) return null;
  const slugs = hasSlugs ? (obj.slugs as Record<string, HealSuggestion[]>) : {};
  return { v: 1, slugs };
}

/** Serialize a heal-rules document with a trailing newline (stable for the
 * byte-identical write skip). */
export function renderHealRules(rules: HealRules): string {
  return JSON.stringify(rules, null, 2) + "\n";
}

/** The slugs whose suggestions are still un-enriched scaffolds — any suggestion
 * carrying `todo: true` (sorted, deduped). The shared definition of "needs
 * enrichment" used by the sync nudge and the `rune-heal-todo` lint rule. */
export function todoSlugs(rules: HealRules): string[] {
  return Object.entries(rules.slugs)
    .filter(([, sugg]) =>
      Array.isArray(sugg) && sugg.some((s) => s && s.todo === true)
    )
    .map(([slug]) => slug)
    .sort();
}
