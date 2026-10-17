// Meta-validator the engine runs on load (WO-3 / closes G8).
//
// Two layers: (1) structural — zod parse against ArtifactSchema; (2) semantic —
// cross-reference and consistency checks JSON Schema can't express (unknown-tag
// references, contradictory indent/follows, duplicate ids, profile gaps). Every
// finding carries a `path` (a JSON-pointer-ish locator) and a precise message,
// and the engine exits non-zero if any error is present.

import { ArtifactSchema } from "./schema.ts";
import type { Artifact } from "./schema.ts";

export interface ArtifactError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ArtifactError[];
  /** Present only when structural validation passed. */
  artifact?: Artifact;
}

function dupes<T>(items: T[], key: (t: T) => string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}

/** Semantic checks over a structurally-valid artifact. */
export function semanticErrors(a: Artifact): ArtifactError[] {
  const errors: ArtifactError[] = [];
  const tagIds = new Set(a.tags.map((t) => t.id));

  // duplicate ids
  for (const id of dupes(a.tags, (t) => t.id)) {
    errors.push({ path: "tags", message: `duplicate tag id "${id}"` });
  }
  for (const id of dupes(a.lint, (r) => r.id)) {
    errors.push({ path: "lint", message: `duplicate lint rule id "${id}"` });
  }
  for (const id of dupes(a.modifiers ?? [], (m) => m.id)) {
    errors.push({
      path: "modifiers",
      message: `duplicate modifier id "${id}"`,
    });
  }

  // duplicate tag literals: a literal must map to one tag
  const literalOwner = new Map<string, string>();
  for (const t of a.tags) {
    const prev = literalOwner.get(t.tag);
    if (prev && prev !== t.id) {
      errors.push({
        path: `tags.${t.id}`,
        message: `tag literal "${t.tag}" is already used by tag "${prev}"`,
      });
    }
    literalOwner.set(t.tag, t.id);
  }
  // every tag's shape rule is a lint of the catalogue
  const lintIds = new Set(a.lint.map((r) => r.id));
  for (const t of a.tags) {
    if (!lintIds.has(t.shapeRule)) {
      errors.push({
        path: `tags.${t.id}.shapeRule`,
        message: `tag "${t.id}" names unknown shape rule "${t.shapeRule}"`,
      });
    }
  }

  // unknown-tag references: modifiers.appliesTo and lint params.tag
  for (const m of a.modifiers ?? []) {
    for (const ref of m.appliesTo) {
      if (!tagIds.has(ref)) {
        errors.push({
          path: `modifiers.${m.id}.appliesTo`,
          message: `modifier "${m.id}" applies to unknown tag id "${ref}"`,
        });
      }
    }
  }
  for (const r of a.lint) {
    const t = r.params?.tag;
    if (typeof t === "string" && !tagIds.has(t)) {
      errors.push({
        path: `lint.${r.id}.params.tag`,
        message: `lint rule "${r.id}" references unknown tag id "${t}"`,
      });
    }
  }

  // contradictory indent/follows: a [CSE]-like tag (follows "case") must be
  // indented strictly deeper than every [PLY]-like opener (follows "poly").
  const polyIndents = a.tags.filter((t) => t.follows === "poly").map((t) =>
    t.indent
  );
  if (polyIndents.length > 0) {
    const maxPoly = Math.max(...polyIndents);
    for (const t of a.tags) {
      if (t.follows === "case" && t.indent <= maxPoly) {
        errors.push({
          path: `tags.${t.id}.indent`,
          message:
            `contradictory indent: case tag "${t.id}" (indent ${t.indent}) is not deeper than its [PLY] opener (indent ${maxPoly})`,
        });
      }
    }
  }

  // profile gaps (D7): if profiles[] exist, every profile must define the same
  // var keys — a key present in one profile but missing in another is a gap.
  const profiles = a.profiles ?? [];
  if (profiles.length > 1) {
    const allKeys = new Set<string>();
    for (const p of profiles) {
      for (const k of Object.keys(p.vars)) allKeys.add(k);
    }
    for (const p of profiles) {
      for (const k of allKeys) {
        if (!(k in p.vars)) {
          errors.push({
            path: `profiles.${p.id}.vars`,
            message:
              `profile "${p.id}" is missing var "${k}" defined by another profile (gap)`,
          });
        }
      }
    }
  }

  return errors;
}

/** Full validation: structural (zod) then semantic. */
export function validateArtifact(input: unknown): ValidationResult {
  const parsed = ArtifactSchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    }));
    return { ok: false, errors };
  }
  const errors = semanticErrors(parsed.data);
  return { ok: errors.length === 0, errors, artifact: parsed.data };
}

/**
 * Engine-on-load guard: validate, print precise diagnostics to stderr, and
 * return the parsed artifact — or null if invalid (caller exits non-zero).
 */
export function loadArtifact(
  input: unknown,
  source = "artifact",
): Artifact | null {
  const result = validateArtifact(input);
  if (result.ok && result.artifact) return result.artifact;
  console.error(`invalid ${source}:`);
  for (const e of result.errors) console.error(`  [${e.path}] ${e.message}`);
  return null;
}
