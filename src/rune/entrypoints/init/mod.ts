import { basename, join, resolve } from "#std/path";
import {
  ensureImportMap,
  renderAppRegistry,
  renderConfig,
  renderMain,
} from "@rune/entrypoints/sync/mod.ts";
import {
  checkArtifactVersion,
  ensureSpecSkeleton,
  registerManifestEntries,
  RUNE_MANIFEST_ENTRIES,
} from "./artifact.ts";
import { ensureWorkspace, renderServe } from "@techgoose-labs/bedrock/artifact";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const CORE_TEMPLATE = `[MOD] core

// This is a rune project. You author tiny .rune specs (here in spec/runes/),
// and "rune sync spec/runes/<m>.rune" generates a typed, validated Deno module
// into src/<m>/. The spec STAYS here — spec/runes/ is its durable home; a
// build never relocates it (D-durable-home) —
// routed endpoints, auto Swagger, an interactive "cake" at /docs. The sibling
// spec/misc/ holds data design + cake artifacts; spec/ui/ holds the UI prototype.
// The generated code runs on rune's runtime, @techgoose-labs/rune (on JSR).
//
// Working with an AI assistant (Claude Code)? Have it use the "rune" skill —
// it knows the spec syntax, the lifecycle, and the runtime's rules. The rune
// installer puts it at ~/.claude/skills/rune ("rune update" refreshes it).
//
// core.rune holds the project's SHARED SERVICES. Declare each ONCE; every
// module resolves its boundary calls against this spec, and each [SRV]
// generates a client under src/core/data/<name>/. Add one when you need it:
//   [SRV] (SIDECAR)<name>: <ENV_VAR>
//       one-line description
//       @docs <url>
`;

// The canonical composed-repo layout, written to spec/misc/layout.md so the shape
// of the repo is a RECORDED decision, not an accident re-invented by each build.
// The ui/ + server/ two-package split is now the ONE canonical shape — the flat
// "serve.ts beside bootstrap/ + src/ at one root" layout was removed. `rune init`
// pins THIS shape; anything you do differently belongs under "## Deviations" below
// so the next tool — and the next teammate — can see it was on purpose.
const LAYOUT_TEMPLATE = `# Composed-repo layout

This app was scaffolded by \`rune init\`, which pins ONE canonical shape: a
composed \`ui/\` (sprig frontend) + \`server/\` (keep backend) monorepo with a shared
\`spec/\` at the git root. Each half is a Deno workspace member with its own import
map; the git-root \`serve.ts\` folds them into one origin with ONE call —
\`Bedrock({ ui: Frontend(), backend: api })\`. Each half is a UNIT: bedrock mounts
them, runs one guard above them on every channel, and provisions the one
in-process client they call each other through.

| Path | Owner | What it is |
| --- | --- | --- |
| \`deno.json\` | sprig | Deno workspace (\`["./ui","./server"]\`); tasks \`dev = sprig dev\`, \`build = sprig build\`, \`start = deno serve -A serve.ts\` |
| \`serve.ts\` | generated | THE COMPOSITION ROOT — \`Bedrock({ ui, backend, auth })\`, rendered identically by either toolchain's \`init\`; UI at \`/\`, backend at \`/api\` (docs at \`/api/docs/*\`), an auth unit at \`/auth\` |
| \`ui/\` | sprig | the sprig UI package — \`ui/src/\` (mod.ts, pages/, shell), \`ui/static/\` (client build output) |
| \`server/\` | rune | the keep backend package — \`server/bootstrap/\` (\`bootstrapServer\`; \`modules.ts\` is the generated registry sync rewrites); \`rune sync\` lands generated modules as \`server/src/<m>/\` |
| \`spec/runes/\` | you | authored \`.rune\` specs — \`core.rune\` (shared services) + one per module; \`rune sync\` generates from them into \`server/src/<m>/\` |
| \`spec/misc/\` | rune | data design (\`data.json\`), cake artifacts (\`cake.json\`), and this layout note |
| \`spec/ui/\` | sprig | UI prototype + design system |

## Why this shape

- **One contract at the waist.** The backend exposes queries + commands; the UI
  consumes them through the in-process client and the generated OpenAPI/typed
  client — never an editable shared record.
- **Each half has one owner.** sprig owns \`ui/\` and its pins; rune owns \`server/\`
  (the spec-driven keep backend). Neither hand-copies the other's config, so
  nothing drifts against a stale pin. The shared \`spec/\` at the root is the one
  place both read.

## Deviations

None yet. If this repo diverges from the canonical layout above — a nested app
dir, a moved \`server/\`, a spec/ not at the root — record it here (what changed and
why) so the shape stays a decision, not an accident.
`;

// --- sprig UI: delegated to the sprig CLI --------------------------------------
//
// `rune init` no longer hand-rolls the sprig UI. sprig is CLI-compilation now —
// `sprig dev`/`sprig build` compile the templates and emit the client bundle into
// ui/static/ — and the sprig CLI owns that scaffold: it writes the git-root serve.ts
// (the Bedrock composition root, importing `api` from ./server/bootstrap/mod.ts), the ui/ UI package
// (ui/src/, ui/deno.json), server/bootstrap/mod.ts (an empty keep backend) with its
// server/deno.json, and a git-root Deno workspace deno.json over [./ui, ./server]
// with `dev = sprig dev` / `build = sprig build` tasks. So the UI half has ONE owner
// (sprig) and never drifts against a stale hand-copied pin.
//
// rune init runs `sprig init <dir>` for the ui/ + server/ split, then OVERLAYS its
// spec-driven keep backend under server/: it replaces sprig's empty
// server/bootstrap/mod.ts with the registry-driven one (`renderMain`, whose `api`
// export the sprig-written serve.ts already imports, and whose `import.meta.main`
// listen keeps `rune dev` a backend-only loop), adds the module registry + config,
// lays the shared spec/ layout at the git root, and merges rune's engine import map
// into server/deno.json (additive — sprig already pins @techgoose-labs/rune).

/** Locations to look for the installed sprig CLI: PATH first, then the default
 *  `deno install` bin. sprig's compiler/scaffold need the on-disk runtime (~/.sprig),
 *  so it can't be run straight from `jsr:` — it must be `sprig install`ed first. */
function sprigCandidates(): string[] {
  // RUNE_INIT_NO_SPRIG=1 forces the backend-only (degraded) scaffold even when
  // sprig is installed — for a deliberately UI-less service, and for tests.
  if (Deno.env.get("RUNE_INIT_NO_SPRIG") === "1") return [];
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  return ["sprig", ...(home ? [join(home, ".deno", "bin", "sprig")] : [])];
}

/** Run the installed sprig CLI's `init` to scaffold the UI half. Returns the
 *  captured output; `missing` when no sprig binary is installed (→ guidance),
 *  `ok=false` when sprig ran but failed. */
async function runSprigInit(
  dir: string,
): Promise<{ ok: boolean; output: string; missing: boolean }> {
  for (const bin of sprigCandidates()) {
    let out: Deno.CommandOutput;
    try {
      out = await new Deno.Command(bin, {
        args: ["init", dir],
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue; // try the next candidate
      return {
        ok: false,
        output: e instanceof Error ? e.message : String(e),
        missing: false,
      };
    }
    const dec = new TextDecoder();
    return {
      ok: out.success,
      output: dec.decode(out.stdout) + dec.decode(out.stderr),
      missing: false,
    };
  }
  return { ok: false, output: "", missing: true };
}

/** Overlay rune's spec-driven keep backend onto a scaffolded sprig app (a dir the
 *  sprig CLI already populated with serve.ts + src/ UI + a deno.json + an empty
 *  bootstrap/mod.ts). Pure filesystem — exported so it can be tested against a
 *  fixture sprig scaffold without shelling out to the sprig CLI. Additive to
 *  sprig's deno.json (never clobbers its keys); replaces sprig's empty bootstrap
 *  backend with the registry-driven one and lays down the spec/ authoring layout. */
export async function overlayRuneBackend(
  dir: string,
  appName: string,
  ioErrors: string[],
  opts: { freshScaffold?: boolean } = {},
): Promise<void> {
  const fresh = opts.freshScaffold ?? true;
  // Write a file of rune's OWN half. On a FRESH scaffold every write proceeds
  // (sprig's empty placeholder bootstrap sits inside rune's server/ subtree, and
  // rune reclaims it); on a LATER init (contributor mode against an existing
  // repo) writes are only-if-absent — a dev-owned file is NEVER clobbered
  // (artifact contract §8's additive-and-idempotent own-half rule).
  const writeOwn = async (path: string, content: string) => {
    if (!fresh) {
      try {
        await Deno.stat(path);
        return; // present — later init never overwrites
      } catch { /* absent — write it */ }
    }
    await Deno.writeTextFile(path, content);
  };

  // The keep backend is a `server/` package beside the sprig `ui/` package. Merge
  // rune's engine import map into any server/deno.json already there (additive —
  // a sprig scaffold already pins @techgoose-labs/rune, so this only ADDS @/,
  // class-validator/-transformer, #std, #assert, #api-doc, etc.). `@/` → `./`
  // there scopes the generated `server/src/**` imports (`@/src/…`) to the server
  // package.
  const serverDir = join(dir, "server");
  await Deno.mkdir(serverDir, { recursive: true }); // degraded path: no sprig scaffold made it
  await ensureImportMap(serverDir, ioErrors);

  // server/bootstrap/ — the registry-driven keep backend. `renderMain` exports
  // the `api` the git-root serve.ts imports (from `./server/bootstrap/mod.ts`),
  // and its `import.meta.main` listen keeps `rune dev` a backend-only loop.
  // modules.ts is the GENERATED registry `rune sync` rewrites as [ENT] surfaces
  // are added.
  await Deno.mkdir(join(serverDir, "bootstrap"), { recursive: true });
  await writeOwn(
    join(serverDir, "bootstrap", "modules.ts"),
    renderAppRegistry([]),
  );
  await writeOwn(join(serverDir, "bootstrap", "config.ts"), renderConfig());
  await writeOwn(join(serverDir, "bootstrap", "mod.ts"), renderMain(appName));

  // spec/ — rune's authored contributions to the shared artifact (the skeleton
  // dirs themselves come from ensureSpecSkeleton). core.rune and layout.md are
  // written only-if-absent even on a fresh scaffold: they are durable/derived
  // artifacts a re-run must never regress.
  await Deno.mkdir(join(dir, "spec", "runes"), { recursive: true });
  await Deno.mkdir(join(dir, "spec", "misc"), { recursive: true });
  await Deno.mkdir(join(dir, "spec", "ui"), { recursive: true });
  const onlyIfAbsent = async (path: string, content: string) => {
    try {
      await Deno.stat(path);
    } catch {
      await Deno.writeTextFile(path, content);
    }
  };
  await onlyIfAbsent(join(dir, "spec", "runes", "core.rune"), CORE_TEMPLATE);
  // Record the canonical layout as an artifact, so the repo's shape is a decision a
  // build can read (and record deviations against), not one re-invented each time.
  await onlyIfAbsent(join(dir, "spec", "misc", "layout.md"), LAYOUT_TEMPLATE);
}

// --- the degraded (sprig-absent) neutral scaffold ------------------------------
//
// Neither toolchain's `init` hard-fails on the other's absence (artifact §8): a
// backend-only repo is a valid, buildable checkpoint. rune writes its own half
/** The root task that runs the composition root. */
const START_TASK = ["deno", "serve", "-A", "serve.ts"].join(" ");

// plus the NEUTRAL root files — the workspace config and the composition root.
// Both come from BEDROCK's renderers now, not rune's own copies: whichever
// toolchain's `init` runs first, the emitted `serve.ts` is byte-identical
// (D-18), and the later one recognizes it by the ONE shared marker instead of
// each toolchain hunting for the other's private one.

/** The composition root at the git root. Backend-only here — `rune init` runs
 *  with no sprig present — and regenerated to the composed shape when the UI
 *  half lands, because both toolchains render it from this same function. */
function backendOnlyServeTs(): string {
  return renderServe({
    backend: { from: "./server/bootstrap/mod.ts", symbol: "api" },
    notes: [
      "Backend-only shape, written by `rune init` (no sprig CLI present).",
      "Add the UI half by installing sprig and running `sprig build` here.",
    ],
  });
}

/** Additively ensure the neutral git-root workspace config carries rune's own
 *  member + the decorator compilerOptions the remote keep graph needs when the
 *  app boots from the root. Never removes or rewrites another toolchain's keys. */
async function ensureNeutralWorkspace(dir: string): Promise<void> {
  await ensureWorkspace(dir, {
    members: ["./server"],
    tasks: { start: START_TASK },
    compilerOptions: {
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
    // ONE bedrock copy for the whole app: a member that pins its own would give
    // the composed app two roots — two envelopes, two guards, two clients.
    imports: { "@techgoose-labs/bedrock": "jsr:@techgoose-labs/bedrock@^1" },
    hoistOnly: ["@techgoose-labs/bedrock"],
  });
}

// `rune init <project-name>` — scaffold a fresh sprig + keep app. The UI half
// (serve.ts, src/ UI, deno.json pins, `sprig dev`/`sprig build` tasks) is scaffolded
// by the sprig CLI; rune overlays its spec-driven keep backend (bootstrap/ + the
// spec/ layout) on top. It does NOT generate module code — author module specs under
// spec/runes/ (e.g. spec/runes/tasks.rune) and run `rune sync spec/runes/tasks.rune`
// to generate them into src/tasks/; the spec stays at spec/runes/ — its durable
// home (D-durable-home). The bootstrap files come from the SAME renderers `rune sync`
// uses, so they're byte-identical to engine output; bootstrap/modules.ts starts empty
// and sync fills it in as modules with [ENT] surfaces are generated.
export async function runInit(args: string[]): Promise<number> {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("Usage: rune init <project-name>");
    return 2;
  }
  if (
    name.includes("/") || name.includes("\\") || name === "." || name === ".."
  ) {
    console.error(
      `${RED}error: '${name}' is not a valid project name (it becomes a directory).${RESET}`,
    );
    return 2;
  }

  const dir = resolve(name);
  // An existing target is a CONTRIBUTOR run (artifact §8: every init is an
  // idempotent contributor to the composed-app repo) — but only against a repo
  // that reads as a composed-app root (has spec/ or .git). Anything else is
  // refused so a typo can't scribble rune's half into an unrelated directory.
  let laterInit = false;
  try {
    await Deno.stat(dir);
    const looksComposed = await Promise.any([
      Deno.stat(join(dir, "spec")).then(() => true),
      Deno.lstat(join(dir, ".git")).then(() => true),
    ]).catch(() => false);
    if (!looksComposed) {
      console.error(
        `${RED}error: ${name}/ exists but has no spec/ or .git — refusing to write into it.${RESET}\n` +
          `  A composed-app repo takes contributor runs; anything else needs a fresh name.`,
      );
      return 2;
    }
    laterInit = true;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(
        `${RED}error: cannot use ${name}/: ${
          e instanceof Error ? e.message : e
        }${RESET}`,
      );
      return 2;
    }
    // NotFound → fresh directory.
  }

  // keep's app name: the project dir, normalized to a slug.
  const appName = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app";

  // 1) FRESH dir: delegate the UI half to the sprig CLI when it is installed
  //    (it owns the UI, client compilation, and the @sprig pins). When sprig is
  //    ABSENT, DEGRADE instead of failing (artifact §8: no init hard-fails on
  //    another toolchain's absence): scaffold the backend half plus the neutral
  //    root files, and say — transiently, never as a committed file — how to
  //    add the UI half later. A LATER init never touches sprig's half at all.
  let degraded = false;
  if (!laterInit) {
    const sprig = await runSprigInit(dir);
    if (sprig.missing) {
      degraded = true;
      await Deno.mkdir(dir, { recursive: true });
      await ensureNeutralWorkspace(dir);
      await Deno.writeTextFile(join(dir, "serve.ts"), backendOnlyServeTs());
    } else if (!sprig.ok) {
      console.error(
        `${RED}rune init: 'sprig init ${name}' failed:${RESET}\n${sprig.output.trimEnd()}`,
      );
      return 1;
    }
  }

  // 2) The shared spec/ artifact: skeleton (atomic, iff absent), the version
  //    handshake, and rune's manifest entries (additive, only-if-absent).
  try {
    await ensureSpecSkeleton(dir);
  } catch (e) {
    console.error(
      `${RED}error: could not create the spec/ skeleton: ${
        e instanceof Error ? e.message : e
      }${RESET}`,
    );
    return 1;
  }
  const versionError = await checkArtifactVersion(dir);
  if (versionError) {
    console.error(`${RED}${versionError}${RESET}`);
    return 2;
  }

  // 3) Overlay rune's spec-driven keep backend (its own half; additive and
  //    idempotent on a later init).
  const ioErrors: string[] = [];
  try {
    await overlayRuneBackend(dir, appName, ioErrors, {
      freshScaffold: !laterInit,
    });
    await registerManifestEntries(dir, RUNE_MANIFEST_ENTRIES);
  } catch (e) {
    console.error(
      `${RED}error: could not overlay the rune backend onto ${name}/: ${
        e instanceof Error ? e.message : e
      }${RESET}`,
    );
    return 1;
  }
  if (ioErrors.length) {
    for (const e of ioErrors) console.error(`${RED}${e}${RESET}`);
    return 1;
  }

  if (degraded) {
    console.log(
      `${GREEN}${BOLD}✓ Created ${name}/${RESET} ${DIM}— rune keep backend (backend-only: no sprig CLI found)${RESET}
${DIM}  server/, spec/ (manifest + vendored tests/), deno.json (workspace ./server), serve.ts (backend-only)${RESET}

The UI half is absent — this is a valid, buildable backend-only app.
Add the UI later:  ${BOLD}deno run -A jsr:@sprig/core/cli install${RESET} then run ${BOLD}sprig build${RESET} in ${name}/.

Next:
  ${BOLD}cd ${name}${RESET}
  ${BOLD}rune sync spec/runes/core.rune${RESET}
  ${BOLD}deno task start${RESET}   ${DIM}# serves /api-less backend routes + /docs${RESET}
`,
    );
    return 0;
  }
  if (laterInit) {
    console.log(
      `${GREEN}${BOLD}✓ Contributed rune's half to ${name}/${RESET} ${DIM}— backend files written only where absent; manifest entries registered${RESET}`,
    );
    return 0;
  }

  const row = (path: string, desc: string) => `  ${path.padEnd(22)} ${desc}`;
  console.log(
    `${GREEN}${BOLD}✓ Created ${name}/${RESET} ${DIM}— sprig UI (via sprig init) + rune keep backend${RESET}
${DIM}${
      row(
        "deno.json",
        "Deno workspace [./ui, ./server]; tasks: dev=sprig dev, build=sprig build",
      )
    }
${
      row(
        "serve.ts",
        "Bedrock composition root — UI /, backend /api (docs /api/docs/*)  [shared]",
      )
    }
${
      row(
        "ui/",
        "sprig UI package — ui/src/ (mod.ts, pages/home, shell)  [sprig]",
      )
    }
${
      row(
        "server/",
        "keep backend — server/bootstrap/ (bootstrapServer); rune modules land in server/src/<m>/ on sync",
      )
    }
${
      row(
        "spec/runes/core.rune",
        "shared-services spec — add module specs beside it",
      )
    }
${row("spec/misc/", "layout.md (repo shape) + data design + cake artifacts")}
${row("spec/ui/", "UI prototype + design system (sprig output)")}${RESET}

Next:
  ${BOLD}cd ${name}${RESET}
  ${BOLD}deno task dev${RESET}                            ${DIM}# sprig HMR dev → http://localhost:8000/ui (compiles the client)${RESET}
  ${DIM}# draft a module spec under spec/runes/ as a work-in-progress (.in-prog.rune),${RESET}
  ${DIM}# which dev/run-all skip; iterate with rune check, then sync to scaffold:${RESET}
  ${BOLD}rune sync spec/runes/tasks.in-prog.rune${RESET}  # generate into server/src/tasks/ (draft stays in spec/runes/)
  ${BOLD}rune sync spec/runes/core.rune${RESET}           # generate the shared service clients
  ${DIM}# read it from a page with inject(Backend) in ui/src/pages/<p>/logic.ts (in-process)${RESET}
`,
  );
  return 0;
}
