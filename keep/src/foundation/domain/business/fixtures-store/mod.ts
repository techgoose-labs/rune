/**
 * The cake's persistent configuration artifact — `spec/misc/cake.json`.
 *
 * The cake (process emulator) keeps its working session in `localStorage`, which is browser-local
 * and ephemeral. This module is the durable, shareable, version-controllable counterpart: the
 * deliberate configuration a user builds — per-module **setup steps** (calls that put the system
 * in a known state before the process runs) and the **environment variables they marked
 * `persist`** — written to one JSON file the cake reads back on load.
 *
 * Pure merge (`mergeFixtures`) is separated from file IO (`readFixtures`/`writeFixtures`) so the
 * shape contract is unit-testable without touching disk. The localhost-only `/docs/_fixtures`
 * routes in bootstrap-server are the only network door to it.
 */

import { specRootOf } from "@mrg-keystone/bedrock/artifact";

/** One pre-run call: an endpoint id plus the request snapshot to send (body text + path/query params). */
export interface SetupStep {
  /** Bare endpoint id (handler method name) within `module` (or the slice's owning module). */
  id: string;
  /**
   * The endpoint's owning module when it is NOT the slice's own — setup can call any composed
   * module's endpoint to put the whole app in a known state. Absent ⇒ the slice's module.
   */
  module?: string;
  /** The request body text to send, verbatim — may still hold `{{refs}}`, resolved at send time. */
  body?: string;
  /** Path/query param values by name. */
  params?: Record<string, string>;
}

/** One body expectation: a dot path into the response, an operator, and an expected value. */
export interface AssertCheck {
  path: string;
  /** "==" | "!=" | "contains" | "exists" — unknown ops are kept (forward compat) but fail closed. */
  op: string;
  /** Expected value as text; may hold `{{refs}}` resolved by the cake at evaluation time. */
  value?: string;
}

/** Per-endpoint expected outcome: an exact HTTP status (optional) plus body checks. */
export interface AssertSpec {
  /** Exact expected status as text ("200"); empty/absent ⇒ any 2xx passes. */
  status?: string;
  checks: AssertCheck[];
}

/** One module's persisted config slice. */
export interface ModuleFixtures {
  setup: SetupStep[];
  /** Pinned expectations by endpoint id — the committable contract-test layer. */
  asserts?: Record<string, AssertSpec>;
}

/** The whole `spec/misc/cake.json` artifact. */
export interface CakeFixtures {
  v: 1;
  /** Environment variables the user marked `persist`, by name. Shared across every module. */
  variables: Record<string, unknown>;
  /** Per-module setup, keyed by module name (the docs path segment, e.g. "orders"). */
  modules: Record<string, ModuleFixtures>;
  /** Epoch ms of the last write (stamped by {@linkcode writeFixtures}). */
  savedAt?: number;
}

/** The POST patch a cake page sends: its own module's slice plus the full persisted-variable set. */
export interface FixturesPatch {
  module?: string;
  setup?: SetupStep[];
  asserts?: Record<string, AssertSpec>;
  variables?: Record<string, unknown>;
}

/** A valid, empty artifact. */
export function emptyFixtures(): CakeFixtures {
  return { v: 1, variables: {}, modules: {} };
}

/**
 * Coerce arbitrary parsed JSON into a well-formed {@linkcode CakeFixtures}. A hand-edited or
 * corrupt file never throws here — unknown shapes degrade to the empty artifact's fields.
 */
export function normalizeFixtures(value: unknown): CakeFixtures {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyFixtures();
  }
  const v = value as Record<string, unknown>;
  const variables = (v.variables && typeof v.variables === "object" &&
      !Array.isArray(v.variables))
    ? (v.variables as Record<string, unknown>)
    : {};
  const modules: Record<string, ModuleFixtures> = {};
  if (v.modules && typeof v.modules === "object" && !Array.isArray(v.modules)) {
    for (const [name, slice] of Object.entries(v.modules)) {
      const setup = (slice && typeof slice === "object" &&
          Array.isArray((slice as { setup?: unknown }).setup))
        ? ((slice as { setup: unknown[] }).setup.filter(
          (s): s is SetupStep =>
            !!s && typeof s === "object" &&
            typeof (s as SetupStep).id === "string",
        ))
        : [];
      modules[name] = { setup };
      const asserts = normalizeAssertMap(
        (slice as { asserts?: unknown })?.asserts,
      );
      if (asserts) modules[name].asserts = asserts;
    }
  }
  const out: CakeFixtures = { v: 1, variables, modules };
  if (typeof v.savedAt === "number") out.savedAt = v.savedAt;
  return out;
}

/** Coerce an asserts map; undefined when nothing valid survives (the slice key stays absent). */
function normalizeAssertMap(
  value: unknown,
): Record<string, AssertSpec> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, AssertSpec> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") continue;
    const spec = raw as { status?: unknown; checks?: unknown };
    const checks = Array.isArray(spec.checks)
      ? spec.checks.filter((c): c is AssertCheck =>
        !!c && typeof c === "object" &&
        typeof (c as AssertCheck).path === "string" &&
        typeof (c as AssertCheck).op === "string"
      )
      : [];
    const status = typeof spec.status === "string" && spec.status !== ""
      ? spec.status
      : undefined;
    if (!checks.length && status === undefined) continue;
    out[id] = status !== undefined ? { status, checks } : { checks };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Fold a cake page's patch into the existing artifact. Pure — no clock, no disk.
 *
 * - `variables` is replaced wholesale when present: every cake page shares the same persisted-
 *   variable set (the cake's globals scope), so the patch always carries the complete picture.
 * - `modules[patch.module]` is replaced with the patch's setup; other modules' slices are kept.
 */
export function mergeFixtures(
  existing: unknown,
  patch: FixturesPatch,
): CakeFixtures {
  const base = normalizeFixtures(existing);
  const variables = (patch.variables && typeof patch.variables === "object" &&
      !Array.isArray(patch.variables))
    ? patch.variables
    : base.variables;
  const modules = { ...base.modules };
  if (typeof patch.module === "string" && patch.module !== "") {
    const slice: ModuleFixtures = {
      setup: Array.isArray(patch.setup) ? patch.setup : [],
    };
    const asserts = normalizeAssertMap(patch.asserts);
    if (asserts) slice.asserts = asserts;
    modules[patch.module] = slice;
  }
  return { v: 1, variables, modules };
}

/**
 * The directory holding `cake.json` (and `scenarios/`, `heal-rules.json`). `spec/` is the shared
 * product contract and lives at the **git root** (a sibling of `.git`), so in a monorepo a backend
 * launched from a package SUBDIR still reads/writes the ONE `<gitRoot>/spec/misc` — beside
 * `spec/runes/` (the authored specs) and `spec/ui/` (the UI prototype). We find it by walking up
 * to the nearest `.git`; when that root has a `spec/`, it wins. Otherwise we fall back to the
 * cwd-local `<cwd>/spec/misc` (a standalone project run from its own root resolves here
 * identically — there, the git root IS the cwd), then to the legacy `<cwd>/fixtures` for projects
 * with no `spec/` at all, so the default stays non-breaking. `KEEP_FIXTURES_DIR` overrides
 * everything (used by tests to redirect writes to a temp dir, and by consumers who keep fixtures
 * elsewhere).
 */
export function fixturesDir(): string {
  const override = (() => {
    try {
      return Deno.env.get("KEEP_FIXTURES_DIR");
    } catch {
      return undefined; // env access not granted — fall back to cwd
    }
  })();
  if (override && override !== "") return override;
  let cwd: string;
  try {
    cwd = Deno.cwd();
  } catch {
    return "fixtures"; // no cwd/perms — best-effort relative legacy path
  }
  return resolveFixturesDir(cwd);
}

/** Pure resolution of the fixtures dir from a working directory (no env / no `Deno.cwd()` read),
 * so the monorepo / standalone / legacy branches are unit-testable. Prefers the shared
 * `<gitRoot>/spec/misc`, else the cwd's own `spec/misc`, else the legacy `<cwd>/fixtures`. */
export function resolveFixturesDir(cwd: string): string {
  // The ONE spec-root walk (D-9), imported rather than re-derived: this file
  // used to carry its own copy, and a copy that drifts splits a monorepo's
  // halves onto two different `spec/` dirs.
  const gitRoot = specRootOf(cwd);
  if (gitRoot !== cwd) {
    try {
      if (Deno.statSync(`${gitRoot}/spec`).isDirectory) {
        return `${gitRoot}/spec/misc`;
      }
    } catch {
      // the git root has no spec/ — a non-rune monorepo, or specs kept per-package; fall through
    }
  }
  try {
    if (Deno.statSync(`${cwd}/spec`).isDirectory) return `${cwd}/spec/misc`;
  } catch {
    // no spec/ dir (or stat not permitted) — fall through to the legacy default
  }
  return `${cwd}/fixtures`;
}

function fixturesFile(dir: string): string {
  return `${dir.replace(/[\/]+$/, "")}/cake.json`;
}

/** Read + normalize the artifact. A missing or unreadable/corrupt file yields the empty artifact. */
export async function readFixtures(dir = fixturesDir()): Promise<CakeFixtures> {
  try {
    return normalizeFixtures(
      JSON.parse(await Deno.readTextFile(fixturesFile(dir))),
    );
  } catch {
    return emptyFixtures();
  }
}

/**
 * Write the artifact (creating the directory if needed), stamping `savedAt`. Returns the exact
 * object written. Permission/IO errors propagate — the route turns them into a clear 500.
 */
export async function writeFixtures(
  data: CakeFixtures,
  dir = fixturesDir(),
  now: number = Date.now(),
): Promise<CakeFixtures> {
  await Deno.mkdir(dir, { recursive: true });
  const stamped: CakeFixtures = { ...data, savedAt: now };
  await Deno.writeTextFile(
    fixturesFile(dir),
    JSON.stringify(stamped, null, 2) + "\n",
  );
  return stamped;
}

// ── project heal rules (spec/misc/heal-rules.json) ────────────────────────────
// The declarative per-project tier of the cake's heal panel. keep executes these; the project
// (usually rune, from its spec's fault slugs) authors them. Schema is the cross-repo contract
// between keep and rune — keep both sides in lockstep when changing it.

/** One suggestion a slug maps to. Unknown `kind`s are preserved and ignored by the client. */
export interface HealRule {
  kind: string;
  /** Exact endpoint id (run-step) / variable name (set-input, pick) / body field (remove-key…). */
  target?: string;
  /** run-step alternative: a "/regex/flags" (or bare substring) over endpoint ids. */
  match?: string;
  value?: unknown;
  /** pick: the exact array field name in any capture to offer as options. */
  fromPlural?: string;
  /** note: the guidance text. */
  label?: string;
  why?: string;
  /** note: also offer a retry button after the guidance. */
  retryAfter?: boolean;
}

/** The whole `spec/misc/heal-rules.json` artifact: error slug → suggestions. */
export interface HealRules {
  v: 1;
  slugs: Record<string, HealRule[]>;
}

/** Coerce arbitrary parsed JSON into well-formed {@linkcode HealRules}; junk degrades to empty. */
export function normalizeHealRules(value: unknown): HealRules {
  const empty: HealRules = { v: 1, slugs: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const slugsIn = (value as { slugs?: unknown }).slugs;
  if (!slugsIn || typeof slugsIn !== "object" || Array.isArray(slugsIn)) {
    return empty;
  }
  const slugs: Record<string, HealRule[]> = {};
  for (const [slug, rules] of Object.entries(slugsIn)) {
    if (!Array.isArray(rules)) continue;
    const kept = rules.filter((r): r is HealRule =>
      !!r && typeof r === "object" && typeof (r as HealRule).kind === "string"
    );
    if (kept.length) slugs[slug] = kept;
  }
  return { v: 1, slugs };
}

/** Read + normalize the project rules. Missing/corrupt file yields the empty rule set. */
export async function readHealRules(dir = fixturesDir()): Promise<HealRules> {
  try {
    return normalizeHealRules(
      JSON.parse(
        await Deno.readTextFile(`${dir.replace(/[\/]+$/, "")}/heal-rules.json`),
      ),
    );
  } catch {
    return { v: 1, slugs: {} };
  }
}

// ── scenarios (spec/misc/scenarios/<name>.json) ───────────────────────────────
// A scenario is a named, committable snapshot of one module's walk configuration: the flow plus
// every step's body text and params (refs intact — they resolve at send time as usual). Loading
// one overwrites the page's editor state; running one is load + Run all. One file per scenario
// so they read naturally in a repo (happy-path.json, refund-flow.json, …).

/** One step's frozen editor state inside a scenario. */
export interface ScenarioStep {
  id: string;
  body?: string;
  params?: Record<string, string>;
  /** Excluded from the walk when the scenario runs. */
  skip?: boolean;
}

/** The whole scenario file. */
export interface Scenario {
  v: 1;
  name: string;
  /** The owning module (docs path segment) — scenarios replay on that module's cake page. */
  module: string;
  /** The flow the walk ran under ("" / absent = all). */
  flow?: string;
  steps: ScenarioStep[];
  savedAt?: number;
}

/** A small, stable, sync djb2 hash → base36 — only used to disambiguate filename stems. */
function nameHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** "Happy Path (EU)" → "happy-path-eu" — the scenario's filename stem. */
export function scenarioSlug(name: string): string {
  // Unicode-aware: keep letters/digits from any script (CJK, Cyrillic, accented …), not an
  // ASCII-only class that would strip a whole non-Latin name to "" and collide all of them.
  const slug = name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  // An empty base (a name with no letters/digits at all, e.g. "---") still needs a stem, but two
  // distinct such names must NOT collapse to one constant file — disambiguate with a name hash.
  return slug === "" ? `scenario-${nameHash(name)}` : slug;
}

/** Coerce one parsed scenario file; null when it lacks the identity fields. */
export function normalizeScenario(value: unknown): Scenario | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || v.name === "") return null;
  if (typeof v.module !== "string" || v.module === "") return null;
  const steps = Array.isArray(v.steps)
    ? v.steps.filter((s): s is ScenarioStep =>
      !!s && typeof s === "object" &&
      typeof (s as ScenarioStep).id === "string"
    )
    : [];
  const out: Scenario = { v: 1, name: v.name, module: v.module, steps };
  if (typeof v.flow === "string" && v.flow !== "") out.flow = v.flow;
  if (typeof v.savedAt === "number") out.savedAt = v.savedAt;
  return out;
}

function scenariosDir(dir: string): string {
  return `${dir.replace(/[\/]+$/, "")}/scenarios`;
}

/** Every readable scenario in `<dir>/scenarios/*.json`, sorted by name. Missing dir ⇒ []. */
export async function readScenarios(dir = fixturesDir()): Promise<Scenario[]> {
  const out: Scenario[] = [];
  try {
    for await (const entry of Deno.readDir(scenariosDir(dir))) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = normalizeScenario(
          JSON.parse(
            await Deno.readTextFile(`${scenariosDir(dir)}/${entry.name}`),
          ),
        );
        if (parsed) out.push(parsed);
      } catch {
        // one unreadable scenario must not hide the rest
      }
    }
  } catch {
    return [];
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Write one scenario to `<dir>/scenarios/<slug(name)>.json` (creating directories), stamping
 * `savedAt`. Same-name saves overwrite — that IS updating the scenario. IO errors propagate.
 */
export async function writeScenario(
  scenario: Scenario,
  dir = fixturesDir(),
  now: number = Date.now(),
): Promise<Scenario> {
  await Deno.mkdir(scenariosDir(dir), { recursive: true });
  const stamped: Scenario = { ...scenario, v: 1, savedAt: now };
  await Deno.writeTextFile(
    `${scenariosDir(dir)}/${scenarioSlug(scenario.name)}.json`,
    JSON.stringify(stamped, null, 2) + "\n",
  );
  return stamped;
}
