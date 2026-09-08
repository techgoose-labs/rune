import { basename, dirname, join, relative, resolve } from "#std/path";
import {
  isRuneGenerated,
  parseBarrelTarget,
  planCreateOnceGrowth,
  planSync,
  polyBarrelNote,
} from "@rune/domain/business/rune-sync/mod.ts";
import {
  artifactToOptions,
  type ManifestOptions,
} from "@rune/domain/business/rune-manifest/mod.ts";
import { loadArtifact } from "@rune/domain/business/artifact/mod.ts";
import { checkArtifactVersion } from "@rune/entrypoints/init/artifact.ts";
import {
  applyCase,
  isInProgSpec,
  isProjectSpec,
} from "@rune/domain/business/rune-bindings/mod.ts";
import {
  type CseNode,
  parse,
  type StepLike,
} from "@rune/domain/business/rune-parse/mod.ts";
import {
  planInputDiagnostics,
  planStubs,
  renderStubsModule,
} from "@rune/domain/business/rune-stubs/mod.ts";
import {
  type HealRules,
  mergeHealRules,
  planHealRules,
  readHealRules,
  renderHealRules,
  todoSlugs,
} from "@rune/domain/business/rune-heal/mod.ts";
import {
  coreSpecExists,
  loadCoreSrvs,
  resolveRoot,
} from "@rune/entrypoints/spec-root.ts";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

interface SyncArgs {
  runePath: string;
  root: string | null; // null = derive from the spec's location; --root overrides
  dryRun: boolean;
  force: boolean;
  artifactPath: string | null;
  regen: string | null; // --regen <path>: regenerate just this file (non-destructively)
  noRun: boolean; // --no-run: skip the run-all gate (red-by-default is the point)
}

export function parseSyncArgs(args: string[]): SyncArgs | null {
  let runePath: string | null = null;
  let root: string | null = null;
  let dryRun = false;
  let force = false;
  let artifactPath: string | null = null;
  let regen: string | null = null;
  let noRun = false;
  // A value-taking flag at the end of argv (or followed by another flag) used to
  // silently default — for --regen that degraded a targeted, NON-destructive
  // single-file regen into a FULL sync that prunes dev-owned orphans. Treat a
  // missing value as a usage error (return null) so the flag fails loudly.
  const value = (i: number): string | null => {
    const v = args[i];
    return v === undefined || v.startsWith("--") ? null : v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a === "--no-run") noRun = true;
    else if (a === "--root") {
      root = value(++i);
      if (root === null) return null;
    } else if (a === "--artifact") {
      artifactPath = value(++i);
      if (artifactPath === null) return null;
    } else if (a === "--regen") {
      regen = value(++i);
      if (regen === null) return null;
    } else if (!a.startsWith("--") && runePath === null) runePath = a;
  }
  if (runePath === null) return null;
  return { runePath, root, dryRun, force, artifactPath, regen, noRun };
}

// Load the artifact's manifest options (bindings + codegen templates + policies)
// from --artifact, so a policy edited in the Studio drives sync. Returns null on
// a read/parse/validation failure (caller has already printed the diagnostic).
async function loadOptions(
  artifactPath: string | null,
): Promise<ManifestOptions | null | "error"> {
  if (!artifactPath) return null; // no artifact → engine defaults
  let raw: string;
  try {
    raw = await Deno.readTextFile(resolve(artifactPath));
  } catch (e) {
    console.error(
      `${RED}error: cannot read artifact ${artifactPath}: ${
        errMessage(e)
      }${RESET}`,
    );
    return "error";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(
      `${RED}error: ${artifactPath} is not valid JSON: ${
        errMessage(e)
      }${RESET}`,
    );
    return "error";
  }
  const artifact = loadArtifact(parsed, artifactPath); // prints its own diagnostics
  if (!artifact) return "error";
  return artifactToOptions(artifact);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Reconcile a .rune spec with the project tree: scaffold new code, prune orphans
// the spec no longer declares, and preserve everything already filled in.
//
// `written` (optional) collects the ABSOLUTE path of every file this run actually
// wrote, deleted, or moved (both sides of the spec move) — byte-identical skips
// are NOT recorded. `rune dev` uses it to ignore the FS events sync itself causes.
export async function runSync(
  args: string[],
  written?: string[],
): Promise<number> {
  const parsed = parseSyncArgs(args);
  if (!parsed) {
    console.error(
      "Usage: rune sync <rune-file> [--root <dir>] [--artifact <keywords.json>] [--dry-run] [--force] [--regen <path>] [--no-run]",
    );
    console.error(
      "  The keep codegen root is resolved from <rune-file>'s path: a shared <git>/spec/runes/ (or spec/) staging spec resolves to the sibling <git>/server/ codegen root; a moved src/<module>/ spec to the server/ above it. Codegen lands in <root>/src/<module>/ (i.e. <git>/server/src/<module>/). --root overrides it (e.g. --root <git>/server). Shared [SRV]s are read from <root>/src/core/core.rune, falling back to the shared <git>/spec/runes/core.rune.",
    );
    return 2;
  }

  const absRune = resolve(parsed.runePath);
  const root = parsed.root !== null
    ? resolve(parsed.root)
    : resolveRoot(absRune);
  const relRune = relative(root, absRune);

  // Artifact version handshake: when a spec/manifest.json is present (at the
  // git root beside this codegen root, or under the root itself), an
  // out-of-range formatVersion fails loud — never a silent misread.
  for (const artifactRoot of [dirname(root), root]) {
    const versionError = await checkArtifactVersion(artifactRoot);
    if (versionError) {
      console.error(`${RED}${versionError}${RESET}`);
      return 2;
    }
  }

  let runeText: string;
  try {
    runeText = await Deno.readTextFile(absRune);
  } catch (e) {
    console.error(
      `${RED}error: cannot read ${parsed.runePath}: ${errMessage(e)}${RESET}`,
    );
    return 2;
  }

  const opts = await loadOptions(parsed.artifactPath);
  if (opts === "error") return 2;

  const existingFiles = await collectFiles(root);
  const sharedSrvs = await loadCoreSrvs(root, absRune);
  const coreSpecFound = await coreSpecExists(root, absRune);
  const plan = planSync(
    relRune,
    runeText,
    existingFiles,
    { ...(opts ?? {}), strictServices: true, projectRoot: root, coreSpecFound },
    sharedSrvs,
  );

  if (plan.errors.length > 0) {
    console.error(`${RED}error in ${relRune}:${RESET}`);
    for (const e of plan.errors) console.error(`  ${e}`);
    return 2;
  }

  const created: string[] = [];
  const regenerated: string[] = [];
  const pruned: string[] = [];
  const ioErrors: string[] = [];

  // --regen <path>: regenerate exactly one file. If it exists and differs, write a `.new` sibling
  // (a hand-edited body is preserved for a manual merge); if it's absent, create it. This is the
  // non-destructive way to pull a changed signature into an already-filled shell — no full sync,
  // no prune.
  if (parsed.regen) {
    const relTarget = relative(root, resolve(parsed.regen));
    const planned = [...plan.toCreate, ...plan.toRegenerate, ...plan.toSkip]
      .find((f) => f.path === relTarget);
    if (!planned) {
      console.error(
        `${RED}error: ${relTarget} is not a generated file of ${plan.module}${RESET}`,
      );
      return 2;
    }
    const abs = join(root, relTarget);
    const existing = await readMaybe(abs);
    if (existing === null) {
      // Only report success when the write actually landed; a failed write adds
      // to ioErrors below, and a success log would contradict the error + exit 2.
      if (await write(root, relTarget, planned.content, ioErrors, written)) {
        console.log(`  ${CYAN}created ${relTarget}${RESET}`);
      }
    } else if (existing === planned.content) {
      console.log(
        `  ${CYAN}${relTarget} already matches the spec — nothing to do${RESET}`,
      );
    } else {
      const newRel = `${relTarget}.new`;
      if (await write(root, newRel, planned.content, ioErrors, written)) {
        console.log(
          `  ${CYAN}wrote ${newRel} — diff it into ${relTarget}, then delete the .new${RESET}`,
        );
      }
    }
    if (ioErrors.length > 0) {
      for (const e of ioErrors) console.error(`  ${RED}${e}${RESET}`);
    }
    return ioErrors.length > 0 ? 2 : 0;
  }

  // Dev-owned orphans (hand-written bodies) are only deleted with --force; without
  // it they're held back so a spec edit can never silently drop your code.
  const ownedSet = new Set(plan.toPruneOwned);
  const blocked = parsed.force
    ? []
    : plan.toPrune.filter((p) => ownedSet.has(p));
  const forceGated = parsed.force
    ? plan.toPrune
    : plan.toPrune.filter((p) => !ownedSet.has(p));

  // Honest-ownership gate: sync deletes ONLY what it can PROVE it generated.
  // A file-level orphan (dto/*.ts — the one slot that prunes without --force)
  // whose header carries no rune generation banner is FOREIGN — hand-authored
  // code parked in a rune-owned slot — and is warned about, never deleted, not
  // even under --force (--force is consent to drop dev-owned GENERATED
  // orphans, not files rune never wrote). Dir-level orphans stay governed by
  // the dev-owned --force gate above: every dir slot is rune-scaffolded and
  // banner-marked at creation, and the ownership proof is per-file.
  const foreign: string[] = [];
  const deletable: string[] = [];
  for (const target of forceGated) {
    let isFile = false;
    try {
      isFile = (await Deno.lstat(join(root, target))).isFile;
    } catch {
      // Missing/unreadable: fall through — the deletion loop reports the I/O
      // error exactly as before.
    }
    if (isFile) {
      const content = await readMaybe(join(root, target));
      if (content === null || !isRuneGenerated(content)) {
        foreign.push(target);
        continue;
      }
    }
    deletable.push(target);
  }

  // Incremental create-once growth: when the spec GREW an existing module, the
  // preserved files may now owe members the fresh plan predicts — adapter/
  // business methods the new coordinators call, DTO fields, @Endpoint bindings
  // (the last invisible even to `deno check`). Append each missing member
  // exactly as the generator would have emitted it (throwing stubs — red by
  // design), never touching existing members; when a file has drifted so far
  // its class can't be located, report the owed members loudly instead.
  const grown: { path: string; added: string[] }[] = [];
  const growthOwed: string[] = [];
  const growthWrites: { path: string; content: string }[] = [];
  for (const file of plan.toSkip) {
    const existing = await readMaybe(join(root, file.path));
    if (existing === null) continue;
    const result = planCreateOnceGrowth(file.path, existing, file.content);
    if (result === null) continue;
    if ("owed" in result) {
      growthOwed.push(`${file.path} — hand-add: ${result.owed.join(", ")}`);
    } else {
      grown.push({ path: file.path, added: result.grown.added });
      growthWrites.push({ path: file.path, content: result.grown.content });
    }
  }

  if (parsed.dryRun) {
    created.push(...plan.toCreate.map((f) => f.path));
    regenerated.push(...plan.toRegenerate.map((f) => f.path));
    pruned.push(...deletable);
  } else {
    for (const file of plan.toCreate) {
      if (await write(root, file.path, file.content, ioErrors, written)) {
        created.push(file.path);
      }
    }
    // Spec-owned signatures: rewritten every run — but a byte-identical write is
    // skipped (and not reported), so a no-change re-sync touches nothing.
    for (const file of plan.toRegenerate) {
      if (await write(root, file.path, file.content, ioErrors, written)) {
        regenerated.push(file.path);
      }
    }
    // Create-once files extended with the members the grown spec now owes them.
    for (const file of growthWrites) {
      await write(root, file.path, file.content, ioErrors, written);
    }
    for (const target of deletable) {
      const abs = join(root, target);
      try {
        const info = await Deno.lstat(abs);
        await Deno.remove(abs, { recursive: info.isDirectory });
        pruned.push(target);
        written?.push(abs);
      } catch (e) {
        ioErrors.push(`${target}: ${errMessage(e)}`);
      }
    }
    // Make the synced project compile out of the box: ensure deno.json carries
    // the import aliases the generated code uses (@/, #zod, #std/*).
    const mapNote = await ensureImportMap(root, ioErrors, written);
    if (mapNote) console.log(`\n  ${CYAN}${mapNote}${RESET}`);

    // The spec's home. `spec/runes/` (and the legacy staging layouts) is the
    // DURABLE CANONICAL HOME (D-durable-home): a spec authored there — draft or
    // finalized — is read in place and NEVER relocated by a build; deleting or
    // regenerating `src/<module>/` can never destroy the source spec, and the
    // shared `spec/` artifact stays whole for every other toolchain reading it.
    // The one remaining rename is WITHIN src/: a spec already resident in its
    // module dir under an arbitrary basename is normalized to the CANONICAL
    // convention isProjectSpec() recognises (`<module>.rune`) — otherwise it sits
    // at a path collectProjectSpecs() rejects and ghost-stub planning / input
    // diagnostics (run later in THIS same sync) silently skip it. Specs already
    // at a canonical src path (spec.rune or <module>.rune) are untouched, so
    // pre-D-durable-home projects keep working unchanged. Idempotent: a no-op
    // once the spec is at any canonical home. Happens BEFORE ensureBootstrap so
    // the just-synced spec is collected.
    const canonicalDir = join(root, "src", plan.module);
    // D-durable-home: a finalized spec in a recognized staging dir (`spec/runes/`
    // etc., under the root or the git-root sibling) is the spec's DURABLE
    // CANONICAL HOME — sync reads it there and generates into src/<module>/ but
    // never relocates it. Only a spec already resident under src/ may still be
    // renamed to its module-canonical basename below.
    const relSpecPath = relative(root, resolve(absRune)).replaceAll("\\", "/");
    const stagingHome = isProjectSpec(relSpecPath) &&
      !relSpecPath.replace(/^(?:\.\.\/)+/, "").startsWith("src/");
    const leaveInPlace = stagingHome || isInProgSpec(absRune) ||
      (resolve(absRune) === resolve(join(canonicalDir, "spec.rune"))) ||
      (resolve(absRune) === resolve(join(canonicalDir, `${plan.module}.rune`)));
    const specTarget = leaveInPlace
      ? absRune
      : join(canonicalDir, `${plan.module}.rune`);
    if (resolve(specTarget) !== absRune) {
      try {
        await Deno.mkdir(dirname(specTarget), { recursive: true });
        await Deno.rename(absRune, specTarget);
        written?.push(absRune, resolve(specTarget));
        console.log(
          `\n  ${CYAN}normalized spec name → ${
            relative(root, specTarget)
          }${RESET}`,
        );
      } catch (e) {
        ioErrors.push(`move spec: ${errMessage(e)}`);
      }
    }

    // Keep the app bootstrap in step with the module set: bootstrap/modules.ts
    // (the registry) is regenerated as runes come and go; bootstrap/mod.ts is
    // created once.
    const bootNotes = await ensureBootstrap(root, ioErrors, written);
    for (const n of bootNotes) console.log(`\n  ${CYAN}${n}${RESET}`);

    // Emit/merge the starter heal-rules file for keep's cake self-healer, keyed
    // on the fault slugs the project's endpoints declare. Merge-don't-clobber,
    // so human/LLM enrichment (and keep's future "Ask Claude" learned rules)
    // survive re-syncs.
    const healNotes = await ensureHealRules(root, ioErrors, written);
    for (const n of healNotes) console.log(`\n  ${CYAN}${n}${RESET}`);

    // Warn when a create-once poly-mod barrel re-exports a [PLY] variant the spec no
    // longer declares (or whose folder a --force prune just removed). The barrel is
    // dev-owned so sync never rewrites it — and its dangling re-export sits outside the
    // composed-app graph `deno check` / the run-all gate traverse, so this is the only
    // place that silent break surfaces.
    const barrelNotes = await ensurePolyBarrels(root, plan.module, runeText);
    for (const n of barrelNotes) console.log(`\n  ${YELLOW}${n}${RESET}`);

    // Composition diagnostics: unproducible $inputs (plural-convention misses)
    // and required fields nothing fills — the two shapes that turn the
    // headless walk red. Printed every sync while they remain.
    const inputNotes = planInputDiagnostics(await collectProjectSpecs(root));
    for (const n of inputNotes) console.log(`\n  ${YELLOW}${n}${RESET}`);
  }

  report(
    relRune,
    plan.module,
    parsed.dryRun,
    created,
    regenerated,
    plan.toSkip.length,
    pruned,
    blocked,
    ioErrors,
    grown,
    growthOwed,
    foreign,
  );

  // The run-all gate: execute the composed app's walk and print the verdict
  // LAST — "the map runs green" is the generation-time definition of done.
  if (!parsed.dryRun) {
    const gateLines = await runAllGate(root, parsed.noRun, written);
    if (gateLines.length > 0) console.log("\n" + gateLines.join("\n"));
  }

  return ioErrors.length > 0 ? 2 : 0;
}

/** Warn (never rewrite — it's create-once) when a [PLY] feature's poly-mod barrel
 * re-exports a variant the spec no longer declares, or whose folder is gone. The pure
 * decision lives in rune-sync (parseBarrelTarget / polyBarrelNote); this does the I/O. */
async function ensurePolyBarrels(
  root: string,
  module: string,
  runeText: string,
): Promise<string[]> {
  const ast = parse(runeText);
  const features: { dir: string; cases: Set<string> }[] = [];
  const collect = (steps: StepLike[] | CseNode["steps"]): void => {
    for (const step of steps) {
      if (step.kind === "ply") {
        features.push({
          dir: `src/${module}/domain/business/${applyCase(step.noun, "kebab")}`,
          cases: new Set(step.cases.map((c) => applyCase(c.name, "kebab"))),
        });
        for (const c of step.cases) collect(c.steps);
      }
    }
  };
  for (const req of ast.reqs) collect(req.steps);

  const notes: string[] = [];
  for (const f of features) {
    const barrel = await readMaybe(join(root, f.dir, "poly-mod.ts"));
    if (barrel === null) continue;
    const target = parseBarrelTarget(barrel);
    if (target === null) continue; // hand-rewritten barrel — can't statically check
    const exists = (await readMaybe(
      join(root, f.dir, "implementations", target, "mod.ts"),
    )) !==
      null;
    const note = polyBarrelNote(f.dir, target, f.cases, exists);
    if (note) notes.push(note);
  }
  return notes;
}

// Import aliases the generated code relies on; the consuming project's deno.json
// must define them (@/ → project root, validation/std libs → external deps).
// DTOs are class-validator / class-transformer classes, so the project also needs
// experimental decorators + reflect-metadata (wired below in ensureImportMap).
const REQUIRED_IMPORTS: Record<string, string> = {
  "@/": "./",
  "class-validator": "npm:class-validator@^0.14",
  "class-transformer": "npm:class-transformer@^0.5",
  // Pinned to keep/danet's EXACT reflect-metadata so the module graph dedupes to
  // ONE copy. A range like ^0.2 resolves to 0.2.x and loads a SECOND Reflect
  // polyfill that re-initialises the global metadata store — wiping the
  // design:paramtypes danet wrote through its 0.1.13 copy, so @Body()/@Endpoint
  // param decorators read `undefined` and bootstrapServer() throws at load. Keep
  // this in lockstep with keep's pin.
  "reflect-metadata": "npm:reflect-metadata@0.1.13",
  "#std/assert": "jsr:@std/assert",
  "#std/path": "jsr:@std/path",
  // Generated [ENT] controllers + e2e tests import the keep backend framework.
  // Track keep's published major on JSR (retarget on every keep major bump, as
  // @^2→@^3 did for the 3.0.0 release). MUST stay equal to the #assert pin's
  // major below: they resolve to ONE keep copy, so ONE class-validator /
  // class-transformer copy — the single-copy invariant assert relies on. A
  // sprig-overlaid project (rune init) inherits its main pin from sprig, so
  // sprig's @mrg-keystone/rune major must match this one too.
  "@mrg-keystone/rune": "jsr:@mrg-keystone/rune@^7",
  // The foundation: the composition root, the runtime, the one in-process
  // client, the observability boundary. `bootstrap/mod.ts` composes with it,
  // and the generated e2e tests serve through it.
  "@mrg-keystone/bedrock": "jsr:@mrg-keystone/bedrock@^1",
  // Generated coordinators validate their seams via keep's assert runtime,
  // published as the @mrg-keystone/rune/assert subpath (same major as above).
  "#assert": "jsr:@mrg-keystone/rune@^7/assert",
  // DTO [TYP:example=…] fields emit @ApiProperty({ example }) — the swagger
  // decorator keep's runner/cake read example values from. Same range keep
  // itself maps #danet/swagger to.
  "#api-doc": "jsr:@danet/swagger@^2.1.1/decorators",
};

// Compiler options the generated code needs. class-validator / class-transformer
// decorators require the legacy experimental-decorator semantics + metadata.
const REQUIRED_COMPILER_OPTIONS: Record<string, unknown> = {
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
};

/** Ensure the project's deno.json carries the import map the generated code
 * needs. Non-destructive: only adds missing keys, never overwrites the user's
 * values. Creates a minimal deno.json if none exists. Returns a report note. */
export async function ensureImportMap(
  root: string,
  ioErrors: string[],
  written?: string[],
): Promise<string | null> {
  const path = join(root, "deno.json");
  // deno-lint-ignore no-explicit-any
  let config: Record<string, any> = {};
  let existed = false;
  // Distinguish "file does not exist" (create fresh, fine) from "file exists but
  // is malformed" (error loudly — never silently clobber the user's config).
  let raw: string | null = null;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    raw = null; // absent → create a fresh minimal deno.json below
  }
  if (raw !== null) {
    // Strip a UTF-8 BOM: Deno.readTextFile does not, and JSON.parse throws on a
    // leading U+FEFF — which the old catch swallowed into a fresh-file clobber.
    const text = raw.replace(/^﻿/, "");
    try {
      config = JSON.parse(text);
      existed = true;
    } catch (e) {
      // The file is present but unparseable. Refuse to overwrite it.
      ioErrors.push(
        `deno.json: existing file is not valid JSON (${errMessage(e)}) — ` +
          `refusing to overwrite; fix or remove it and re-run`,
      );
      return null;
    }
  }
  const imports: Record<string, string> =
    (config.imports && typeof config.imports === "object")
      ? config.imports
      : {};
  const added: string[] = [];
  for (const [k, v] of Object.entries(REQUIRED_IMPORTS)) {
    if (!(k in imports)) {
      imports[k] = v;
      added.push(k);
    }
  }
  // Ensure the decorator compiler options are present (merge, don't clobber).
  const co: Record<string, unknown> =
    (config.compilerOptions && typeof config.compilerOptions === "object")
      ? config.compilerOptions
      : {};
  if (!existed && !("strict" in co)) co.strict = true;
  for (const [k, v] of Object.entries(REQUIRED_COMPILER_OPTIONS)) {
    if (!(k in co)) {
      co[k] = v;
      added.push(k);
    }
  }
  config.compilerOptions = co;

  if (existed && added.length === 0) return null;
  config.imports = imports;
  try {
    await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
    written?.push(path);
  } catch (e) {
    ioErrors.push(`deno.json: ${errMessage(e)}`);
    return null;
  }
  return existed
    ? `updated deno.json import map (added ${added.join(", ")})`
    : "created deno.json with the import map (project is ready to type-check)";
}

// ---- app bootstrap (the canonical bootstrap/ composition root) ---------------
//
// A project whose runes declare [ENT] surfaces gets a runnable keep app:
//   bootstrap/modules.ts — the module registry (GENERATED, rewritten on every
//             sync): imports every src/<module>/entrypoints/<surface>/mod.ts
//             surface module and exports them as one array. Adding/removing a
//             rune updates it.
//   bootstrap/mod.ts — the bootstrap (DEV-OWNED, created once, never
//             overwritten): calls keep's bootstrapServer with that array;
//             tune the app name, port, or keep options freely.

const APP_REGISTRY_HEADER = "// Generated by rune sync — DO NOT EDIT.";

export interface SurfaceModule {
  module: string; // "checkout"
  surface: string; // "http"
  exportName: string; // "httpModule" (read from the file; convention fallback)
  alias: string; // "checkoutHttpModule" — unique across modules
}

const camel = (s: string): string =>
  s.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string): string => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

// Coerce an alias candidate into a valid JS/TS identifier: drop every character
// that can't appear in an identifier (so module/surface names with quotes,
// spaces, or other punctuation can't break the import binding) and prefix a `_`
// when the result would start with a digit. A normal camel/pascal alias is
// unchanged; empty residue falls back to `surfaceModule`.
const safeIdent = (s: string): string => {
  const stripped = s.replace(/[^A-Za-z0-9_$]/g, "");
  const prefixed = /^[0-9]/.test(stripped) ? `_${stripped}` : stripped;
  return prefixed || "surfaceModule";
};

// Strip line and block comments before scanning a mod.ts for its export name so
// a commented-out `export const …Module` can't be read as the real one.
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Find every generated keep surface module in the project tree. Aliases are
 * always valid identifiers and unique across surfaces, so the rendered registry
 * type-checks even when module/surface names collide or carry illegal chars. */
export async function scanSurfaceModules(
  root: string,
): Promise<SurfaceModule[]> {
  const found: SurfaceModule[] = [];
  const src = join(root, "src");
  for (const mod of await listDirs(src)) {
    for (const surface of await listDirs(join(src, mod, "entrypoints"))) {
      const modPath = join(src, mod, "entrypoints", surface, "mod.ts");
      let text: string;
      try {
        text = await Deno.readTextFile(modPath);
      } catch {
        continue; // no mod.ts in this surface folder
      }
      // The generated convention is `export const <surface>Module = endpointModule(…)`,
      // but the file is dev-owned — read the actual export name when it diverges.
      // Comments are stripped first so a commented-out export isn't read as it.
      const exportName =
        stripComments(text).match(/export const (\w+Module)\b/)?.[1] ??
          `${camel(surface)}Module`;
      found.push({
        module: mod,
        surface,
        exportName,
        alias: safeIdent(`${camel(mod)}${pascal(surface)}Module`),
      });
    }
  }
  found.sort((a, b) =>
    a.module === b.module
      ? a.surface.localeCompare(b.surface)
      : a.module.localeCompare(b.module)
  );
  // Disambiguate alias collisions (distinct surfaces whose names camel/pascal to
  // the same identifier, e.g. foo-bar/http vs foo/bar-http): the registry imports
  // each surface under its alias, so a duplicate is a `Duplicate identifier`
  // compile error that silently drops a module. Suffix the 2nd+ occurrence.
  const seen = new Map<string, number>();
  for (const s of found) {
    const n = seen.get(s.alias) ?? 0;
    seen.set(s.alias, n + 1);
    if (n > 0) s.alias = `${s.alias}_${n + 1}`;
  }
  return found;
}

async function listDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory && !e.name.startsWith(".")) out.push(e.name);
    }
  } catch { /* missing dir → no entries */ }
  return out.sort();
}

/** The module registry — regenerated on every sync. When the ghost stub module
 * exists (bootstrap/stubs.ts), it is statically imported (dynamic `import()`
 * deadlocks under rollup-bundled keep apps) and gated out of production inside
 * the array. */
export function renderAppRegistry(
  surfaces: SurfaceModule[],
  ghostStubs = false,
): string {
  const L: string[] = [
    APP_REGISTRY_HEADER,
    "// Module registry: one entry per rune surface, regenerated on every sync as",
    "// runes are added and removed. bootstrap/mod.ts (dev-owned) wires it to keep.",
    "",
  ];
  for (const s of surfaces) {
    // The module/surface segments are dev-controlled directory names; JSON-encode
    // the specifier so a `"` (or other quote) in a name can't break the string
    // literal (the alias itself is already a sanitized identifier).
    const specifier = JSON.stringify(
      `@/src/${s.module}/entrypoints/${s.surface}/mod.ts`,
    );
    L.push(
      `import { ${s.exportName} as ${s.alias} } from ${specifier};`,
    );
  }
  if (ghostStubs) {
    L.push('import { stubsModule } from "@/bootstrap/stubs.ts";');
  }
  if (surfaces.length > 0 || ghostStubs) L.push("");
  L.push("export const modules = [");
  for (const s of surfaces) L.push(`  ${s.alias},`);
  if (ghostStubs) {
    L.push(
      "  // Ghost stubs: minted stand-ins for [TYP:ext] inputs nothing produces yet.",
      "  // Dev/test only — excluded in production; evaporates with a real producer.",
      '  ...(Deno.env.get("DENO_ENV") === "production" ? [] : [stubsModule]),',
    );
  }
  L.push("];", "");
  return L.join("\n");
}

/** The app bootstrap — created once, then dev-owned. */
export function renderMain(appName: string): string {
  return [
    "// App bootstrap (dev-owned): created once by rune sync, never overwritten —",
    "// tune the app name, port, or keep options freely. The module registry",
    "// (bootstrap/modules.ts) is regenerated as runes are added and removed.",
    "//",
    "// `api` is a bedrock UNIT: the backend half of the app. The composition",
    "// root is the git root's serve.ts — `Bedrock({ ui, backend: api, auth })`",
    "// — which is where a UI or an auth unit joins it. The block below is the",
    "// standalone shape, for running the backend on its own.",
    "",
    'import { bootstrapServer } from "@mrg-keystone/rune";',
    'import { Bedrock } from "@mrg-keystone/bedrock";',
    'import { config } from "@/bootstrap/config.ts";',
    'import { modules } from "@/bootstrap/modules.ts";',
    "",
    `export const api = await bootstrapServer("${appName}", modules, { port: config.port });`,
    "",
    "if (import.meta.main) {",
    "  // One socket serves the whole composed app; PORT is fail-loud, so a busy",
    "  // port is an error you see rather than a silent bind somewhere else.",
    "  const { port } = await Bedrock({ backend: api }).listen();",
    "  console.log(",
    `    \`${appName} on http://localhost:\${port} — emulator at /api/docs/<module>\`,`,
    "  );",
    "}",
    "",
  ].join("\n");
}

/** App configuration — created once, then dev-owned. */
export function renderConfig(): string {
  return [
    "// App configuration (dev-owned): created once by rune sync, never",
    "// overwritten. Centralize environment reads here so the rest of the app",
    "// stays env-free.",
    "",
    "export const config = {",
    '  port: Number(Deno.env.get("PORT") ?? 3000),',
    "};",
    "",
  ].join("\n");
}

/** Create main.ts once and keep app.ts in step with the project's surfaces.
 * Exported for tests. Returns report notes; never throws. */
export async function ensureBootstrap(
  root: string,
  ioErrors: string[],
  written?: string[],
): Promise<string[]> {
  const notes: string[] = [];
  const surfaces = await scanSurfaceModules(root);
  const registryPath = join(root, "bootstrap", "modules.ts");
  const existing = await readMaybe(registryPath);

  // No keep surfaces and no registry → not a keep app; generate nothing.
  if (surfaces.length === 0 && existing === null) return notes;

  // Never clobber a hand-written modules.ts that rune didn't generate.
  if (existing !== null && !existing.startsWith(APP_REGISTRY_HEADER)) {
    notes.push(
      "bootstrap/modules.ts exists but was not generated by rune sync — left untouched (module registry not updated)",
    );
    return notes;
  }

  // Ghost stubs: reconcile bootstrap/stubs.ts with the project's unfulfilled
  // [TYP:ext] inputs BEFORE rendering the registry, which imports it when live.
  const ghostStubs = await ensureGhostStubs(
    root,
    surfaces,
    notes,
    ioErrors,
    written,
  );

  const registry = renderAppRegistry(surfaces, ghostStubs);
  if (existing !== registry) {
    try {
      await Deno.mkdir(join(root, "bootstrap"), { recursive: true });
      await Deno.writeTextFile(registryPath, registry);
      written?.push(registryPath);
      notes.push(
        `${
          existing === null ? "created" : "updated"
        } bootstrap/modules.ts (module registry: ${surfaces.length} surface module(s))`,
      );
    } catch (e) {
      ioErrors.push(`bootstrap/modules.ts: ${errMessage(e)}`);
    }
  }

  // Dev-owned companions: created once, never overwritten.
  const once: Array<[string, () => string, string]> = [
    [
      "config.ts",
      renderConfig,
      "created bootstrap/config.ts (app configuration — dev-owned)",
    ],
    [
      "mod.ts",
      () => {
        // In the composed monorepo the codegen root is `<git>/server`, so
        // basename(root) is the literal "server" — name the app after the git
        // root (its parent) instead, and fall back to "app".
        const nameDir = basename(root) === "server" ? dirname(root) : root;
        const appName = basename(nameDir).toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
        return renderMain(appName);
      },
      "created bootstrap/mod.ts (keep bootstrap — dev-owned; run `deno run -A bootstrap/mod.ts`)",
    ],
  ];
  for (const [file, render, note] of once) {
    const path = join(root, "bootstrap", file);
    if (await readMaybe(path) !== null) continue;
    try {
      await Deno.mkdir(join(root, "bootstrap"), { recursive: true });
      await Deno.writeTextFile(path, render());
      written?.push(path);
      notes.push(note);
    } catch (e) {
      ioErrors.push(`bootstrap/${file}: ${errMessage(e)}`);
    }
  }
  return notes;
}

/** Reconcile the ghost stub module (bootstrap/stubs.ts) with the project's
 * specs: write/refresh it while some [TYP:ext] input has no producer anywhere
 * in the project; delete it (header-guarded) once every input is produced.
 * Returns whether the ghost is live, so the registry can import + gate it. */
async function ensureGhostStubs(
  root: string,
  surfaces: SurfaceModule[],
  notes: string[],
  ioErrors: string[],
  written?: string[],
): Promise<boolean> {
  const path = join(root, "bootstrap", "stubs.ts");
  const existing = await readMaybe(path);

  // A REAL module named "stubs" owns the name — never generate the ghost beside it.
  if (surfaces.some((s) => s.module === "stubs")) {
    notes.push("module 'stubs' exists — ghost stubs disabled");
    return false;
  }

  // Never clobber (or delete) a hand-written bootstrap/stubs.ts.
  if (existing !== null && !existing.startsWith(APP_REGISTRY_HEADER)) {
    notes.push(
      "bootstrap/stubs.ts exists but was not generated by rune sync — left untouched (ghost stubs disabled)",
    );
    return false;
  }

  const fields = planStubs(await collectProjectSpecs(root));

  // Every ext input has a real producer → the ghost evaporates.
  if (fields.length === 0) {
    if (existing !== null) {
      try {
        await Deno.remove(path);
        written?.push(path);
        notes.push(
          "removed bootstrap/stubs.ts (every stub input now has a real producer)",
        );
      } catch (e) {
        ioErrors.push(`bootstrap/stubs.ts: ${errMessage(e)}`);
      }
    }
    return false;
  }

  const content = renderStubsModule(fields);
  if (existing !== content) {
    try {
      await Deno.mkdir(join(root, "bootstrap"), { recursive: true });
      await Deno.writeTextFile(path, content);
      written?.push(path);
      notes.push(
        `${
          existing === null ? "created" : "updated"
        } bootstrap/stubs.ts (ghost stub module: ${fields.length} minted input(s) — emulator at /docs/stubs)`,
      );
    } catch (e) {
      ioErrors.push(`bootstrap/stubs.ts: ${errMessage(e)}`);
      return existing !== null; // an older ghost may still be importable
    }
  }
  return true;
}

// ---- heal-rules (keep cake self-healer) ------------------------------------
//
// A keep app's cake turns endpoint failures into one-click fixes via a
// per-project rules file: spec/misc/heal-rules.json, keyed on the fault slug
// (the failed response body's `message`). rune knows every endpoint's slugs
// from the spec, so it scaffolds the file — one entry per slug, pre-filling a
// `run-step` where the slug names an obvious precondition, a TODO note
// otherwise. The dir mirrors keep's cake config (spec/misc/cake.json): it is
// the project's spec/misc/ when a spec/ dir exists, else the legacy fixtures/,
// and obeys the same KEEP_FIXTURES_DIR override.

function fixturesDir(root: string): string {
  const env = Deno.env.get("KEEP_FIXTURES_DIR");
  if (env && env.trim()) return env.trim();
  try {
    if (Deno.statSync(join(root, "spec")).isDirectory) return "spec/misc";
  } catch {
    // no spec/ dir (or stat not permitted) — fall through to the legacy default
  }
  return "fixtures";
}

/** Reconcile spec/misc/heal-rules.json with the project's endpoint fault slugs.
 * Creates it when endpoints declare slugs, merges new slugs into an existing
 * file without ever clobbering human/LLM edits, and reports slugs the spec no
 * longer declares (kept, never auto-deleted). Returns report notes; never
 * throws. */
export async function ensureHealRules(
  root: string,
  ioErrors: string[],
  written?: string[],
): Promise<string[]> {
  const notes: string[] = [];
  const dir = fixturesDir(root);
  const path = join(root, dir, "heal-rules.json");
  const existingRaw = await readMaybe(path);

  const { scaffold, slugs } = planHealRules(await collectProjectSpecs(root));

  // No endpoint declares a slug and there's no file yet → nothing to do.
  if (slugs.length === 0 && existingRaw === null) return notes;

  // Parse an existing file leniently; on bad JSON or a non-heal-rules shape,
  // leave it untouched rather than overwrite hand-authored content.
  let existing: HealRules | null = null;
  if (existingRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingRaw);
    } catch {
      notes.push(`${dir}/heal-rules.json is not valid JSON — left untouched`);
      return notes;
    }
    existing = readHealRules(parsed);
    if (existing === null) {
      notes.push(
        `${dir}/heal-rules.json is not a heal-rules document — left untouched`,
      );
      return notes;
    }
  }

  const { result, added, stale, changed } = mergeHealRules(existing, scaffold);
  const staleNote = stale.length > 0
    ? `${dir}/heal-rules.json: ${stale.length} slug(s) no longer declared by any endpoint (kept — prune by hand): ${
      stale.join(", ")
    }`
    : null;
  // The enrichment nudge is emitted on EVERY sync while un-enriched (todo:true)
  // entries remain — not just the sync that created them. CLI output lands in an
  // LLM's context window; a file on disk does not, so this is what makes "always
  // write the heal prompts" actually happen. A later session inherits the debt
  // and must keep seeing it.
  const enrichNote = healEnrichmentNote(dir, todoSlugs(result));

  // No new slugs (and no creation) → leave the file as-is, preserving any human
  // formatting; still surface stale slugs and the standing enrichment nudge.
  if (!changed) {
    if (staleNote) notes.push(staleNote);
    if (enrichNote) notes.push(enrichNote);
    return notes;
  }

  const content = renderHealRules(result);
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, content);
    written?.push(path);
    notes.push(
      existingRaw === null
        ? `created ${dir}/heal-rules.json (${slugs.length} slug scaffold(s) — enrich each entry's actions/why for keep's cake healer)`
        : `updated ${dir}/heal-rules.json (added ${added.length} new slug(s): ${
          added.join(", ")
        })`,
    );
    if (staleNote) notes.push(staleNote);
    if (enrichNote) notes.push(enrichNote);
  } catch (e) {
    ioErrors.push(`${dir}/heal-rules.json: ${errMessage(e)}`);
  }
  return notes;
}

/** The imperative follow-up that names every un-enriched heal-rules slug, so an
 * LLM/human session sees enrichment is its job. Null when nothing is pending. */
function healEnrichmentNote(dir: string, pending: string[]): string | null {
  if (pending.length === 0) return null;
  return [
    `heal-rules: ${pending.length} slug(s) need enrichment before this module is done:`,
    `    ${pending.join(", ")}`,
    `    → edit ${dir}/heal-rules.json: replace each TODO suggestion with real`,
    `      actions (run-step/set-input/pick/retry/note + a concrete \`why\`), then`,
    `      remove \`todo: true\`. Schema: the keep skill's rules-file reference.`,
    `    A module is NOT done while todo:true entries remain.`,
  ].join("\n");
}

// ---- the run-all gate -------------------------------------------------------
//
// "Click Run all in the system view and it passes for anything I build."
// After every real sync of a keep app, execute the composed app's walk —
// keep's exerciseEndpoints, in-process, in a subprocess running the PROJECT's
// module graph — and print the verdict as the last block of sync output. A
// red walk names every failed step so the building session can't not notice
// the app doesn't run. `--no-run` skips; red-by-default is the point.

const GATE_MARKER = "__RUNE_RUN_ALL__";
const GATE_SCRIPT = ".rune-run-all.ts";
const GATE_TIMEOUT_MS = 120_000;

/** One failed step of the walk (the subset of keep's EndpointResult we print). */
interface GateFailure {
  id: string;
  module: string;
  status?: number;
  error?: string;
  body?: unknown;
}

interface GateReport {
  passed: { id: string }[];
  failed: GateFailure[];
  optionalFailed?: { id: string }[];
  cycles: string[][];
  iterations?: number;
}

// keep recognizes a fault slug in a failed body's `message`.
const GATE_SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

/** The headline failure text of a walk step: the response body's message
 * (string or class-validator array), else the transport error, else status. */
function gateFailureText(f: GateFailure): string {
  const body = f.body as { message?: unknown } | undefined;
  const m = body?.message;
  if (typeof m === "string" && m) return m;
  if (Array.isArray(m) && m.length) return m.map(String).join("; ");
  if (f.error) return f.error;
  return `status ${f.status ?? "?"}`;
}

/** Render the walk verdict. Pure — exported for tests. `heal` is the parsed
 * project heal-rules file (null when absent) so slug failures can say whether
 * a heal rule exists / is still an un-enriched scaffold. */
export function formatRunAllVerdict(
  report: GateReport,
  heal: HealRules | null,
): string[] {
  const failed = report.failed ?? [];
  const passed = report.passed ?? [];
  const total = failed.length + passed.length;
  const cycles = report.cycles ?? [];

  if (failed.length === 0 && cycles.length === 0) {
    return [
      `  ${GREEN}run-all: ${total}/${total} steps passed — the composed app runs green.${RESET}`,
    ];
  }

  const todo = new Set(heal ? todoSlugs(heal) : []);
  const L: string[] = [
    `  ${RED}${BOLD}run-all: ${failed.length}/${total} steps FAILED — the module is not done.${RESET}`,
  ];
  for (const f of failed) {
    const text = gateFailureText(f);
    let hint = "";
    if (GATE_SLUG_RE.test(text)) {
      const rules = heal?.slugs[text];
      if (!rules || rules.length === 0) {
        hint = " (no heal rule — enrich heal-rules.json)";
      } else if (todo.has(text)) {
        hint = " (heal rule un-enriched — enrich heal-rules.json)";
      }
    }
    L.push(
      `    ${RED}${f.module}:${f.id}  ${
        f.status ?? "?"
      } ${text}${hint}${RESET}`,
    );
  }
  for (const c of cycles) {
    L.push(`    ${RED}cycle: ${c.join(" → ")}${RESET}`);
  }
  L.push(
    `    ${YELLOW}→ fix the spec/bindings until run-all is green, or enrich${RESET}`,
    `    ${YELLOW}  spec/misc/heal-rules.json where the failure is environmental.${RESET}`,
  );
  return L;
}

/** Execute the walk in a subprocess (the PROJECT's deno.json + module graph)
 * and return the verdict lines. Soft on every failure mode — a missing deno,
 * a compile error, a hang — the gate reports, it never throws or blocks the
 * sync result. Returns [] when the project isn't a runnable keep app. */
async function runAllGate(
  root: string,
  noRun: boolean,
  written?: string[],
): Promise<string[]> {
  if (noRun) return [];
  // The shared spec/ artifact this app belongs to (git-root sibling of the
  // codegen root, or under the root itself) — where the hash-stamped
  // contract/openapi.json is emitted (artifact-mediated decoupling).
  let specDir: string | null = null;
  let appLabel = "app";
  for (const candidate of [dirname(root), root]) {
    try {
      const st = await Deno.stat(join(candidate, "spec"));
      if (st.isDirectory) {
        specDir = join(candidate, "spec");
        appLabel = basename(candidate);
        break;
      }
    } catch { /* keep looking */ }
  }
  // Only a keep app with surfaces can walk.
  if (await readMaybe(join(root, "bootstrap", "mod.ts")) === null) return [];
  if ((await scanSurfaceModules(root)).length === 0) return [];

  const script = join(root, GATE_SCRIPT);
  const body = [
    "// Written by rune sync for the run-all gate; deleted right after the run.",
    'import { api } from "@/bootstrap/mod.ts";',
    'import { exerciseEndpoints } from "@mrg-keystone/rune";',
    "const report = await exerciseEndpoints({ api });",
    ...(specDir
      ? [
        "// Artifact-mediated decoupling: emit the hash-stamped contract for the",
        "// frontend toolchain to READ (it never invokes this side). Feature-checked",
        "// so an app pinned to an older keep just skips it.",
        "try {",
        '  const keepMod = await import("@mrg-keystone/rune");',
        '  if (typeof keepMod.emitContractOpenApi === "function") {',
        `    const c = await keepMod.emitContractOpenApi(${
          JSON.stringify(specDir)
        }, api.docs, ${JSON.stringify(appLabel)});`,
        '    if (c.wrote) console.error("contract: wrote spec/contract/openapi.json (x-spec-hash " + c.hash.slice(0, 12) + "…)");',
        "  }",
        "} catch (e) {",
        '  console.error("contract: emission failed — " + (e instanceof Error ? e.message : String(e)));',
        "}",
      ]
      : []),
    "// deno-lint-ignore no-explicit-any",
    "const slim = (r: any) => ({ id: r.id, module: r.module, status: r.status, error: r.error, body: r.body });",
    `console.log(${JSON.stringify(GATE_MARKER)} + JSON.stringify({`,
    "  passed: report.passed.map(slim),",
    "  failed: report.failed.map(slim),",
    "  optionalFailed: report.optionalFailed.map(slim),",
    "  cycles: report.cycles,",
    "  iterations: report.iterations,",
    "}));",
    "Deno.exit(0);",
    "",
  ].join("\n");

  try {
    await Deno.writeTextFile(script, body);
    written?.push(script);
  } catch (e) {
    return [`  ${YELLOW}run-all: skipped (${errMessage(e)})${RESET}`];
  }

  try {
    let out;
    try {
      out = await new Deno.Command("deno", {
        args: ["run", "--quiet", "-A", GATE_SCRIPT],
        cwd: root,
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
      }).output();
    } catch (e) {
      // deno missing from PATH, or the timeout abort.
      return [
        `  ${YELLOW}run-all: could not execute the walk (${
          errMessage(e)
        }) — run it manually: deno run -A bootstrap/mod.ts then POST /docs/_run${RESET}`,
      ];
    }
    const stdout = new TextDecoder().decode(out.stdout);
    const marker = stdout.split("\n").find((l) => l.startsWith(GATE_MARKER));
    if (!marker) {
      // The app didn't boot (compile error, missing dep, throw at import).
      const stderr = new TextDecoder().decode(out.stderr).trim()
        .split("\n").slice(0, 6).join("\n    ");
      return [
        `  ${RED}${BOLD}run-all: the app failed to start — the module is not done.${RESET}`,
        `    ${RED}${stderr || "(no error output)"}${RESET}`,
        `    ${YELLOW}→ fix the build (deno check) until the app boots, then re-sync.${RESET}`,
      ];
    }
    let report: GateReport;
    try {
      report = JSON.parse(marker.slice(GATE_MARKER.length));
    } catch {
      return [
        `  ${YELLOW}run-all: unreadable walk report — re-run manually.${RESET}`,
      ];
    }
    const heal = await loadProjectHealRules(root);
    return formatRunAllVerdict(report, heal);
  } finally {
    try {
      await Deno.remove(script);
      written?.push(script);
    } catch { /* already gone */ }
  }
}

/** The project's heal-rules file, parsed leniently (null when absent/foreign). */
async function loadProjectHealRules(root: string): Promise<HealRules | null> {
  const raw = await readMaybe(join(root, fixturesDir(root), "heal-rules.json"));
  if (raw === null) return null;
  try {
    return readHealRules(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Every project spec (specs/<n>.rune, src/<m>/spec.rune, src/<m>/<m>.rune)
 * with its text — the input to ghost-stub planning. */
async function collectProjectSpecs(
  root: string,
): Promise<{ path: string; text: string }[]> {
  const files = await collectFiles(root);
  const specs: { path: string; text: string }[] = [];
  for (const rel of [...files].sort()) {
    if (!rel.endsWith(".rune") || !isProjectSpec(rel)) continue;
    const text = await readMaybe(join(root, rel));
    if (text !== null) specs.push({ path: rel, text });
  }
  // D-durable-home: in a composed app the shared authoring `spec/` sits at the
  // GIT ROOT, a SIBLING of this codegen root, and finalized specs STAY there —
  // so auto-discovery (ghost stubs, input diagnostics, heal-rules) must look
  // across the boundary too. Crossed only when the immediate parent is the git
  // root (`../.git` exists, dir or worktree file), so an in-repo fixture root
  // never wanders into an unrelated sibling tree.
  try {
    await Deno.lstat(join(root, "..", ".git"));
    for (const dir of ["spec/runes", "specs/runes"]) {
      try {
        for await (const entry of Deno.readDir(join(root, "..", dir))) {
          if (!entry.isFile || !entry.name.endsWith(".rune")) continue;
          const rel = `../${dir}/${entry.name}`;
          if (!isProjectSpec(rel)) continue; // drafts and strays fall through
          const text = await readMaybe(join(root, rel));
          if (text !== null) specs.push({ path: rel, text });
        }
      } catch { /* this staging layout absent — fine */ }
    }
  } catch { /* parent is not a git root — no sibling staging to read */ }
  return specs;
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function write(
  root: string,
  rel: string,
  content: string,
  ioErrors: string[],
  written?: string[],
): Promise<boolean> {
  const abs = join(root, rel);
  // Byte-identical content is skipped entirely (no write, no mtime change, no FS
  // event) so a re-sync is physically quiet — `rune dev`'s watcher depends on it.
  if (await readMaybe(abs) === content) return false;
  try {
    await Deno.mkdir(dirname(abs), { recursive: true });
    await Deno.writeTextFile(abs, content);
    written?.push(abs);
    return true;
  } catch (e) {
    ioErrors.push(`${rel}: ${errMessage(e)}`);
    return false;
  }
}

function report(
  relRune: string,
  module: string,
  dryRun: boolean,
  created: string[],
  regenerated: string[],
  preserved: number,
  pruned: string[],
  blocked: string[],
  ioErrors: string[],
  grown: { path: string; added: string[] }[] = [],
  growthOwed: string[] = [],
  foreign: string[] = [],
): void {
  console.log(
    `${BOLD}sync ${relRune} (module: ${module})${
      dryRun ? " — dry run" : ""
    }${RESET}`,
  );
  if (created.length > 0) {
    console.log(`\n  ${GREEN}Created ${created.length} file(s):${RESET}`);
    for (const p of created) console.log(`    ${GREEN}+ ${p}${RESET}`);
  }
  if (regenerated.length > 0) {
    console.log(
      `\n  ${CYAN}Regenerated ${regenerated.length} signature(s):${RESET}`,
    );
    for (const p of regenerated) console.log(`    ${CYAN}~ ${p}${RESET}`);
  }
  if (grown.length > 0) {
    console.log(
      `\n  ${GREEN}Extended ${grown.length} create-once file(s) — the spec grew, new members appended (bodies still yours):${RESET}`,
    );
    for (const g of grown) {
      console.log(
        `    ${GREEN}~ ${g.path} (+${g.added.join(", +")})${RESET}`,
      );
    }
  }
  if (growthOwed.length > 0) {
    console.log(
      `\n  ${YELLOW}create-once drift — these files must be hand-edited (sync preserved them, and could not safely append):${RESET}`,
    );
    for (const o of growthOwed) console.log(`    ${YELLOW}! ${o}${RESET}`);
  }
  if (preserved > 0) {
    console.log(
      `\n  ${YELLOW}Preserved ${preserved} existing file(s).${RESET}`,
    );
  }
  if (pruned.length > 0) {
    console.log(`\n  ${RED}Pruned ${pruned.length} orphan(s):${RESET}`);
    for (const p of pruned) console.log(`    ${RED}- ${p}${RESET}`);
  }
  if (blocked.length > 0) {
    console.log(
      `\n  ${YELLOW}Held back ${blocked.length} dev-owned orphan(s) — re-run with --force to delete:${RESET}`,
    );
    for (const p of blocked) console.log(`    ${YELLOW}? ${p}${RESET}`);
  }
  if (foreign.length > 0) {
    console.log(
      `\n  ${YELLOW}Left ${foreign.length} foreign file(s) in place — in a rune-owned slot but not rune-generated (no generation header); delete by hand if truly orphaned:${RESET}`,
    );
    for (const p of foreign) console.log(`    ${YELLOW}? ${p}${RESET}`);
  }
  if (ioErrors.length > 0) {
    console.log(`\n  ${RED}I/O errors:${RESET}`);
    for (const e of ioErrors) console.log(`    ${RED}! ${e}${RESET}`);
  }
  if (
    created.length === 0 && grown.length === 0 && growthOwed.length === 0 &&
    pruned.length === 0 && blocked.length === 0 && foreign.length === 0 &&
    ioErrors.length === 0
  ) {
    console.log(`\n  ${CYAN}In sync — nothing to create or prune.${RESET}`);
  }
  console.log(
    `\n  ${CYAN}Next: run \`deno check\` to surface method-level drift.${RESET}`,
  );
}

async function collectFiles(root: string): Promise<Set<string>> {
  const SKIP = new Set([".git", "node_modules", "dist", ".playwright-mcp"]);
  const files = new Set<string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    // Deno.readDir returns its iterable synchronously and only throws on
    // ITERATION, so the try must wrap the loop — a not-yet-created codegen root
    // (a first `rune sync` into a fresh `server/`) is simply "no files", not an error.
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = join(dir, entry.name);
        if (entry.isDirectory) await walk(abs, rel);
        else if (entry.isFile) files.add(rel);
      }
    } catch {
      return; // missing / unreadable dir → contributes no files
    }
  }
  await walk(root, "");
  return files;
}
