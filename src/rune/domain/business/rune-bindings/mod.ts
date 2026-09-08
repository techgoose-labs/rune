// Maps canonical-paths.json placeholders (like "<feature>") to the rune element
// that fills them. Used by the scaffolder (manifest) and the rune-derived rules.
//
// Convention by placeholder name — no annotations on canonical-paths.json. The
// placeholder names are semantically meaningful, the binding map is small and
// stable. New placeholder = update both the JSON and this file.

export type RuneElementSource =
  | "MOD" // [MOD] directive
  | "REQ" // [REQ] coordinator (process = `${noun}-${verb}`)
  | "STEP" // untagged step noun
  | "PLY" // polymorphic [PLY] noun
  | "CSE" // case name inside [PLY]
  | "BOUNDARY" // boundary tag's noun (db:noun.x → noun)
  | "DTO" // [DTO] (or [DTO:core])
  | "TYP" // [TYP] (or [TYP:core])
  | "ENT"; // [ENT] surface

export type CaseStyle = "kebab" | "camel" | "pascal" | "lower";

export interface Binding {
  // Which rune element types fill this placeholder. Multiple sources mean any of
  // them can produce a name for this slot.
  from: readonly RuneElementSource[];
  // How to transform the rune name into a path segment.
  caseStyle: CaseStyle;
  // Optional suffix to strip before transforming (e.g., "Dto" off "GetRecordingDto").
  stripSuffix?: string;
  // Whether this slot is in core/ (true) or in <module>/ (false). Some placeholders
  // can appear in both — the rune element's own :core modifier decides at runtime.
  // null means "depends on caller".
  coreOnly: boolean | null;
}

export const bindings: Record<string, Binding> = {
  "<module-name>": {
    from: ["MOD"],
    caseStyle: "kebab",
    coreOnly: false,
  },
  "<process>": {
    from: ["REQ"],
    caseStyle: "kebab",
    coreOnly: false,
  },
  "<feature>": {
    from: ["STEP", "PLY"],
    caseStyle: "kebab",
    coreOnly: null,
  },
  "<variant-name>": {
    from: ["CSE"],
    caseStyle: "kebab",
    coreOnly: null,
  },
  "<service>": {
    from: ["BOUNDARY"],
    caseStyle: "kebab",
    coreOnly: null,
  },
  "<name>": {
    from: ["DTO", "TYP", "ENT"],
    caseStyle: "kebab",
    stripSuffix: "Dto",
    coreOnly: null,
  },
};

export function applyCase(name: string, style: CaseStyle): string {
  switch (style) {
    case "lower":
      return name.toLowerCase();
    case "camel":
      return name[0].toLowerCase() + name.slice(1);
    case "pascal":
      return name[0].toUpperCase() + name.slice(1);
    case "kebab":
      return toKebab(name);
  }
}

function toKebab(name: string): string {
  // Insert a hyphen before each uppercase letter (except the first), then lowercase.
  // "GetRecordingDto" → "get-recording-dto"
  // "fiveNine" → "five-nine"
  // "metadata" → "metadata"
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    const isUpper = ch >= "A" && ch <= "Z";
    if (isUpper && i > 0) out += "-";
    out += ch.toLowerCase();
  }
  return out;
}

export function transformName(rawName: string, binding: Binding): string {
  let name = rawName;
  if (binding.stripSuffix && name.endsWith(binding.stripSuffix)) {
    name = name.slice(0, -binding.stripSuffix.length);
  }
  return applyCase(name, binding.caseStyle);
}

/** The `dto/` basename for a [TYP]. A [TYP] kebabs to `<name>`; a [DTO] strips
 * its `Dto` suffix and kebabs (transformName), so `[TYP] principal` and
 * `[DTO] PrincipalDto` both want `dto/principal.ts`. When they collide in the
 * SAME dir, the [DTO] keeps the clean name (it is the contract imported by name
 * across the project) and the [TYP] takes a `-type` suffix, so both files exist
 * instead of one silently clobbering the other. `dtoNamesSameDir` is the raw
 * [DTO] names sharing this [TYP]'s dir (same `isCore`). Pure: the generator and
 * the rune-typ-shape rule call it so disk layout and the lint expectation agree. */
export function typFileName(
  typName: string,
  dtoNamesSameDir: string[],
  binding: Binding,
): string {
  const base = applyCase(typName, "kebab");
  const claimed = new Set(
    dtoNamesSameDir.map((n) => transformName(n, binding)),
  );
  return claimed.has(base) ? `${base}-type` : base;
}

// Compose a process name from a [REQ]'s noun and verb.
//   recording.set        → "recording-set"
//   register/recording   → "recording-register" (camelCase form: noun-verb)
export function processName(noun: string, verb: string): string {
  return `${toKebab(noun)}-${toKebab(verb)}`;
}

// The canonical shared-service spec, relative to the project root. `[SRV]` may
// only be declared in a core spec; every other spec resolves its boundary
// services against it (declare-once, visible everywhere). No import syntax — the
// convention is the path. Shared by the loader (spec-root) and the lint rules.
export const CORE_SPEC_REL = "src/core/core.rune";

// Dedicated spec-folder layouts: a folder of authored `.rune` specs that
// generate into the project's `src/` (the specs stay put — they are the source).
// The canonical staging dir is `spec/runes/` (the `rune init` default), which
// sits beside its sibling `spec/misc/` (data design + cake artifacts) and
// `spec/ui/` (the sprig prototype + design system). The flat `spec/` and the
// plural `specs/` / `specs/runes/` names also resolve, so older projects keep
// working. ORDER MATTERS: the more specific `…/runes/` prefixes must come first
// so `moduleFromSpecPath` strips `spec/runes/` (not just `spec/`) — otherwise a
// `spec/runes/orders.rune` would derive the module "runes/orders".
const SPEC_DIRS = ["spec/runes/", "specs/runes/", "spec/", "specs/"];

// The core spec under any layout: src/core/core.rune (canonical), the
// `spec/runes/` staging dir (`spec/runes/core.rune`), or the flat
// `spec/core.rune` / `specs/core.rune` legacy spec-folder layouts. The
// `.in-prog.rune` draft variants count too — core is shared infrastructure that
// must keep supplying services (and accept `[SRV]`) even while it is a draft,
// unlike a module draft which is excluded from auto-discovery entirely.
const CORE_SPEC_PATHS = [
  CORE_SPEC_REL,
  "spec/runes/core.rune",
  "specs/runes/core.rune",
  "spec/core.rune",
  "specs/core.rune",
  "src/core/core.in-prog.rune",
  "spec/runes/core.in-prog.rune",
  "specs/runes/core.in-prog.rune",
  "spec/core.in-prog.rune",
  "specs/core.in-prog.rune",
];

/** Is this (root-relative) path the project's shared-service spec? Normalizes a
 * leading `../` first so the shared `<git>/spec/runes/core.rune` — a sibling of
 * the `server/` codegen root — is recognized as core (else its `[SRV]` set would
 * be rejected as a module-declared service). */
export function isCoreSpec(path: string): boolean {
  return CORE_SPEC_PATHS.includes(stripLeadingParent(path));
}

// The draft suffix: a spec named `<name>.in-prog.rune` is a work in progress.
// Drafts are EXCLUDED from every auto-discovery scan (the `rune dev` watch, the
// composed-app run-all, ghost-stub planning, and the lint rules) so a half-built
// spec can never break the running app — `isProjectSpec` returns false for them.
// You still iterate freely: `rune check` validates a draft, and an explicit
// `rune sync spec/<name>.in-prog.rune` scaffolds src/<name>/ (moduleFromSpecPath
// strips the tag). Finalize by renaming to `<name>.rune` — then it is picked up.
const IN_PROG_SUFFIX = ".in-prog.rune";

/** Is this (root-relative) path a work-in-progress draft spec? */
export function isInProgSpec(path: string): boolean {
  return path.endsWith(IN_PROG_SUFFIX);
}

// Drop a leading `../` run from a codegen-root-relative spec path. The shared
// authoring `spec/` sits at the GIT ROOT, a SIBLING of the `server/` codegen
// root, so a staging spec's path relative to that root is `../spec/runes/<m>.rune`.
// Recognition (isProjectSpec/moduleFromSpecPath) keys off the `spec/runes/` etc.
// prefixes, so normalize the parent hops away first — the only source of a leading
// `../` is exactly this sibling-staging case (a path UNDER the root never has one).
const stripLeadingParent = (path: string): string =>
  path.replace(/^(?:\.\.\/)+/, "");

/** Strip the `.in-prog` draft tag, leaving the canonical `<name>.rune` path. */
export function canonicalSpecPath(path: string): string {
  return isInProgSpec(path)
    ? path.slice(0, -IN_PROG_SUFFIX.length) + ".rune"
    : path;
}

// A rune file counts as a project spec only at one of these paths:
//   spec/runes/<name>.rune  |  specs/runes/<name>.rune   (canonical staging dir)
//   spec/<name>.rune        |  specs/<name>.rune         (legacy flat layout)
//   src/<module>/spec.rune
//   src/<module>/<module>.rune
// Note the sibling `spec/misc/` (data design + cake artifacts) and `spec/ui/`
// (sprig prototype) are NOT spec dirs — their files have a slash after `spec/`
// and aren't `<name>.rune` directly under a recognized staging dir, so they fall
// through here (and a stray `.rune` nested deeper than one level is skipped).
// Documentation, vendored, in-progress drafts (`.in-prog.rune`), and arbitrary
// rune files are skipped by rune rules.
export function isProjectSpec(rawPath: string): boolean {
  const path = stripLeadingParent(rawPath); // sibling `../spec/runes/…` staging → `spec/runes/…`
  if (isInProgSpec(path)) return false; // drafts: excluded from auto-discovery
  for (const dir of SPEC_DIRS) {
    if (path.startsWith(dir) && !path.slice(dir.length).includes("/")) {
      return true;
    }
  }
  if (path.startsWith("src/")) {
    const rest = path.slice("src/".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return false;
    const module = rest.slice(0, slash);
    const tail = rest.slice(slash + 1);
    return tail === "spec.rune" || tail === `${module}.rune`;
  }
  return false;
}

// Derive the module name from a project-spec path. Drafts derive from their
// CANONICAL name (the `.in-prog` tag stripped), so an explicit sync of a draft
// still resolves the right module.
//   spec/runes/recording.rune          → "recording"
//   spec/runes/recording.in-prog.rune  → "recording"
//   spec/recording.rune                → "recording"  (legacy flat)
//   specs/recording.rune               → "recording"
//   src/orders/spec.rune               → "orders"
//   src/orders/orders.rune             → "orders"
export function moduleFromSpecPath(rawPath: string): string | null {
  const canonical = stripLeadingParent(canonicalSpecPath(rawPath));
  if (!isProjectSpec(canonical)) return null;
  for (const dir of SPEC_DIRS) {
    if (canonical.startsWith(dir)) {
      return canonical.slice(dir.length, -".rune".length);
    }
  }
  // src/<module>/...
  return canonical.slice("src/".length).split("/")[0];
}
