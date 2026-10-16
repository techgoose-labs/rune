// The artifact contract (WO-3 / P2 / closes G8; hardened by REQ-026).
//
// This zod schema is the SINGLE SOURCE for the artifact's shape: TS types come
// from `z.infer` (one definition for engine + Studio), runtime structural
// validation comes from `.safeParse`, and the published `artifact.schema.json`
// is emitted from it (scripts/gen-artifact-schema.ts). Semantic checks that
// JSON Schema can't express (cross-references, gaps) live in ./validate.ts.
//
// The schema is intentionally lenient about unknown keys (zod strips them) so
// it accepts the current registry as it grows; the required core is what every
// consumer (parser, codegen, lint, docs, grammar) depends on. Sections are
// grouped to mirror the separable concerns of ADR 0008 (D7): language vs lint
// vs codegen profiles.

import * as z from "#zod";

const semver = z.string().regex(
  /^\d+\.\d+\.\d+$/,
  "must be semver MAJOR.MINOR.PATCH",
);

/** The kinds of line a tag's `follows` can declare (see generate-core.mjs). */
export const FOLLOWS = [
  "signature",
  "poly",
  "typedef",
  "dtodef",
  "identifier",
  "case",
  "value",
  "service",
  "none",
] as const;

// ---- language section (target-independent) --------------------------------

export const CodegenTemplateSchema = z.object({
  path: z.string(),
  body: z.string(),
});

export const TagSchema = z.object({
  id: z.string().min(1),
  tag: z.string().regex(
    /^\[[A-Z]+(:[a-z]+)?\]$/,
    "tag must look like [REQ] or [DTO:core]",
  ),
  label: z.string(),
  indent: z.number().int().nonnegative(),
  follows: z.enum(FOLLOWS),
  allowFunctionName: z.boolean().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  // documentation fields (folded in from the old catalog.ts)
  group: z.string().optional(),
  syntax: z.string().optional(),
  summary: z.string().optional(),
  /** The lint id reported when a line of this tag is malformed (REQ-034). */
  shapeRule: z.string().min(1),
});

/** A modifier's full spec (REQ-025): what it applies to, its base primitive,
 * its parameter kind, and the decorator it emits — the one table the parser,
 * the codegen, the docs and the editor read. */
export const ModifierSchema = z.object({
  id: z.string().min(1),
  token: z.string().regex(/^:[a-z]+$/, "modifier token must look like :core"),
  label: z.string().optional(),
  appliesTo: z.array(z.string()),
  kind: z.enum(["routing", "source", "constraint", "doc", "binding"]),
  /** The declared [TYP] primitive a constraint requires; null = any. */
  base: z.enum(["string", "number"]).nullable(),
  param: z.enum(["none", "number", "text"]),
  /** For a text parameter, the closed set of accepted values. */
  values: z.array(z.string()).optional(),
  /** class-validator import name, when the modifier emits a decorator. */
  decorator: z.string().optional(),
  /** Decorator call for a scalar field, `{value}` substituted. */
  call: z.string().optional(),
  /** Decorator call for an `(s)` array field (each-form). */
  eachCall: z.string().optional(),
  syntax: z.string().optional(),
  description: z.string().optional(),
});

export const TransportSchema = z.object({
  id: z.string().regex(/^[A-Z]+$/),
  summary: z.string(),
});

export const FaultsSchema = z.object({
  marker: z.string().min(1),
  syntax: z.string(),
  /** The fault-name shape, as a regex source. */
  shape: z.string(),
  summary: z.string(),
  wellKnown: z.array(z.object({
    /** A name, or a `prefix-*` glob. */
    id: z.string().min(1),
    status: z.number().int().min(100).max(599),
    summary: z.string(),
  })).min(1),
});

export const IndentSchema = z.object({
  unit: z.number().int().positive(),
  step: z.number().int().nonnegative(),
  fault: z.number().int().nonnegative(),
  case: z.number().int().nonnegative(),
  caseStep: z.number().int().nonnegative(),
  caseFault: z.number().int().nonnegative(),
  description: z.number().int().nonnegative(),
  body: z.number().int().nonnegative(),
  faultOffset: z.number().int().positive(),
  summary: z.string().optional(),
});

// ---- lint section ----------------------------------------------------------

export const LintRuleSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).optional(),
  target: z.enum(["spec", "generated"]),
  severity: z.enum(["error", "warning", "info"]),
  enabled: z.boolean(),
  params: z.record(z.string(), z.unknown()).optional(),
  /** The finding's message, `{var}` placeholders substituted by the engine. */
  message: z.string(),
  /** What to change, when the rule can say so (`{var}` placeholders). */
  fix: z.string().optional(),
  /** The rule's explanation (`rune check --explain <id>`, the language card). */
  doc: z.string().optional(),
  /** A coded rule names the engine checker that emits it (REQ-026). A rule
   * with no checker is a shape rule, fully specified by `type` + `params`. */
  checker: z.string().min(1).optional(),
  // governance (D6): org-locked rules cannot be weakened by a project overlay.
  locked: z.boolean().optional(),
  owner: z.string().optional(),
});

// ---- codegen profiles (D7) -------------------------------------------------

export const ProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  vars: z.record(z.string(), z.unknown()),
});

// ---- bindings: canonical-path placeholder -> rune element (WO-4a) ----------

export const RUNE_ELEMENT_SOURCES = [
  "MOD",
  "REQ",
  "STEP",
  "PLY",
  "CSE",
  "BOUNDARY",
  "DTO",
  "TYP",
  "ENT",
] as const;
export const CASE_STYLES = ["kebab", "camel", "pascal", "lower"] as const;

export const BindingSchema = z.object({
  from: z.array(z.enum(RUNE_ELEMENT_SOURCES)).min(1),
  caseStyle: z.enum(CASE_STYLES),
  stripSuffix: z.string().optional(),
  coreOnly: z.boolean().nullable(),
});

// ---- engine codegen templates (WO-4b) --------------------------------------

// Per-role lifecycle/prune policy (WO-8). Keyed by the same role names the
// engine emits (template keys + "business-sig"/"adapter-sig"). Partial: any
// field/role omitted falls back to the engine's DEFAULT_POLICIES.
export const TemplatePolicySchema = z.object({
  lifecycle: z.enum(["regenerate", "create-once"]).optional(),
  prunable: z.boolean().optional(),
});

export const CodegenSchema = z.object({
  // body templates keyed by name (see rune-manifest DEFAULT_TEMPLATES); the
  // engine merges these over its defaults, so a partial map is allowed.
  templates: z.record(z.string(), z.string()),
  // per-role lifecycle/prune policy; merged over the engine defaults.
  policies: z.record(z.string(), TemplatePolicySchema).optional(),
});

// ---- the artifact ----------------------------------------------------------

export const ArtifactSchema = z.object({
  name: z.string(),
  schemaVersion: semver,
  description: z.string().optional(),
  palette: z.record(z.string(), z.unknown()).optional(),
  // language (target-independent)
  tags: z.array(TagSchema).min(1),
  modifiers: z.array(ModifierSchema),
  transports: z.array(TransportSchema).min(1),
  faults: FaultsSchema,
  indent: IndentSchema,
  columns: z.object({ max: z.number().int().positive() }),
  builtins: z.array(z.string()),
  tokens: z.record(z.string(), z.unknown()),
  architecture: z.unknown().optional(),
  // lint
  lint: z.array(LintRuleSchema),
  // codegen: layout bindings (placeholder -> rune element) + engine templates
  bindings: z.record(z.string(), BindingSchema).optional(),
  codegen: CodegenSchema.optional(),
  // canonical folder layout (the `structure` rule's spec); folded in from the
  // former assets/canonical-paths.json so the artifact is the one source.
  canonicalPaths: z.record(z.string(), z.unknown()).optional(),
  // codegen profiles (optional today; an artifact that DOES declare them must
  // keep them gap-free — see semanticErrors. zod would otherwise strip the key
  // and the L1 profile-gap fixture would silently validate).
  profiles: z.array(ProfileSchema).optional(),
});

export type CodegenTemplate = z.infer<typeof CodegenTemplateSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type Modifier = z.infer<typeof ModifierSchema>;
export type Transport = z.infer<typeof TransportSchema>;
export type Faults = z.infer<typeof FaultsSchema>;
export type Indent = z.infer<typeof IndentSchema>;
export type LintRule = z.infer<typeof LintRuleSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Binding = z.infer<typeof BindingSchema>;
export type TemplatePolicy = z.infer<typeof TemplatePolicySchema>;
export type Codegen = z.infer<typeof CodegenSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
