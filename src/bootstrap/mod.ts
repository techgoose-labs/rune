import { dirname, fromFileUrl, join, resolve } from "#std/path";
import {
  parseArgs,
  printHeader,
  printJson,
  printResults,
  rules,
  runCheck,
  runDev,
  runInit,
  runManifest,
  runPipeline,
  runStop,
  runSync,
  runUpdate,
  runValidate,
  runVersion,
} from "@rune/mod-root.ts";
import { getIgnoredPaths } from "@rune/domain/data/project/mod.ts";
import { suggestForResults } from "@rune/domain/data/llm/openai.ts";
import { canonicalPaths as SHAPE } from "@rune/domain/business/artifact/canonical-paths.ts";
import type { EntryResult } from "@core/dto/types.ts";

// Walk up from `start` to the nearest dir containing a deno.json(c) — the project
// root. `rune lint` runs from there, so it works invoked from any subdirectory.
// Falls back to `start` if no marker is found.
function findProjectRoot(start: string): string {
  let dir = start;
  while (true) {
    for (const f of ["deno.json", "deno.jsonc"]) {
      try {
        if (Deno.statSync(join(dir, f)).isFile) return dir;
      } catch { /* keep looking */ }
    }
    const up = dirname(dir);
    if (up === dir) return start; // hit filesystem root, no marker
    dir = up;
  }
}

// ---- version ---- print this build's version and check for a newer release.
if (["-v", "--version", "-V", "version"].includes(Deno.args[0] ?? "")) {
  Deno.exit(await runVersion(Deno.args.slice(1)));
}

// ---- help ---- (bare `rune` with no args shows this too)
if (
  ["-h", "--help", "help"].includes(Deno.args[0] ?? "") ||
  Deno.args.length === 0
) {
  console.log(`rune — design a spec, generate the code, keep it honest.

USAGE
  rune init <project-name>   scaffold a fresh project (folder, deno.json, src/, bootstrap/)
  rune sync <file.rune>      generate/update a module from its spec
  rune check <file.rune>     check a spec for errors (no codegen); --json for findings
                             with rule ids, --stdin --path <file> to check a buffer
  rune dev [path]            live loop: save spec → check → sync → app restart → page reload
                            (one shared process per git repo; re-run to attach to it)
  rune stop [path]           stop this repo's shared \`rune dev\` process
  rune lint [dir] [--strict] lint a project against the architecture (default: .);
                            --strict promotes strict-gated rules (e.g. un-enriched
                            heal-rules) to failing violations — the CI profile
  rune manifest <file.rune>  one-shot generate (no prune)
  rune validate <art.json>   validate a keywords.json artifact
  rune lsp                   start the language server (editor integration)
  rune fmt <file.rune>       format a spec
  rune update [tag]          self-update to the latest release (or a pinned tag)
  rune -v                     print the version and check for a newer release

Generation is Deno/TypeScript. Edit the language in Rune Studio
(\`deno task studio\`) — it writes keywords.json, the single source of truth.`);
  Deno.exit(0);
}

// ---- delegation to the fast Rust helpers (rune-lsp / rune-syntax) ----
// `rune` is the single front door; the speed-critical paths (LSP, parse/format/
// highlight/render) are the Rust binaries it ships alongside. Codegen + lint
// stay here in Deno. We resolve the helper next to this binary (installed),
// from a RUNE_BIN_DIR override, from the repo's lang/target (dev), or PATH.
function helperPath(name: string): string {
  const candidates: string[] = [];
  const env = Deno.env.get("RUNE_BIN_DIR");
  if (env) candidates.push(join(env, name));
  try {
    candidates.push(join(dirname(Deno.execPath()), name)); // installed: next to `rune`
  } catch { /* ignore */ }
  const repo = dirname(dirname(dirname(fromFileUrl(import.meta.url)))); // src/bootstrap/mod.ts -> repo root
  candidates.push(join(repo, "lang", "target", "release", name));
  candidates.push(join(repo, "lang", "target", "debug", name));
  for (const c of candidates) {
    try {
      if (Deno.statSync(c).isFile) return c;
    } catch { /* keep looking */ }
  }
  return name; // last resort: rely on PATH
}

async function delegate(name: string, args: string[]): Promise<number> {
  try {
    const child = new Deno.Command(helperPath(name), {
      args,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    return (await child.status).code;
  } catch (e) {
    console.error(
      `rune: could not run helper '${name}': ${
        e instanceof Error ? e.message : e
      }`,
    );
    console.error(
      `(build it with \`cd lang && cargo build\`, or set RUNE_BIN_DIR)`,
    );
    return 127;
  }
}

// `rune lsp …` -> the Rust LSP server.
if (Deno.args[0] === "lsp") {
  Deno.exit(await delegate("rune-lsp", Deno.args.slice(1)));
}

// Fast syntax/authoring commands -> the Rust `rune-syntax` helper (verbatim passthrough).
const SYNTAX_CMDS = new Set([
  "format",
  "fmt",
  "install",
  "uninstall",
  "completions",
]);
if (SYNTAX_CMDS.has(Deno.args[0])) {
  const sub = Deno.args[0] === "fmt" ? "format" : Deno.args[0];
  Deno.exit(await delegate("rune-syntax", [sub, ...Deno.args.slice(1)]));
}

// Subcommand dispatch.
if (Deno.args[0] === "manifest") {
  const code = await runManifest(Deno.args.slice(1));
  Deno.exit(code);
}

if (Deno.args[0] === "sync") {
  const code = await runSync(Deno.args.slice(1));
  Deno.exit(code);
}

if (Deno.args[0] === "init") {
  const code = await runInit(Deno.args.slice(1));
  Deno.exit(code);
}

if (Deno.args[0] === "check") {
  const code = await runCheck(Deno.args.slice(1));
  Deno.exit(code);
}

if (Deno.args[0] === "dev") {
  const code = await runDev(Deno.args.slice(1));
  Deno.exit(code);
}

if (Deno.args[0] === "stop") {
  const code = await runStop(Deno.args.slice(1));
  Deno.exit(code);
}

if (Deno.args[0] === "validate") {
  const code = await runValidate(Deno.args.slice(1));
  Deno.exit(code);
}

if (Deno.args[0] === "update" || Deno.args[0] === "upgrade") {
  const code = await runUpdate(Deno.args.slice(1));
  Deno.exit(code);
}

// Everything else must be an explicit command. Lint lives under `rune lint`;
// a bare `.rune` arg is no longer a sync shorthand — point at the real commands.
if (Deno.args[0] !== "lint") {
  const cmd = Deno.args[0] ?? "";
  if (cmd.endsWith(".rune")) {
    console.error(
      `rune: '${cmd}' is a spec — run \`rune sync ${cmd}\` to generate or \`rune check ${cmd}\` to validate.`,
    );
  } else {
    console.error(`rune: unknown command '${cmd}' — run \`rune --help\`.`);
  }
  Deno.exit(2);
}

const { dir, module: moduleName, suggest, json } = parseArgs(
  Deno.args.slice(1),
);

// `--strict` promotes strict-gated rules (e.g. rune-heal-todo) into failing
// violations — the CI profile. Surfaced to the rules via RUNE_LINT_STRICT so the
// check() bodies stay flag-free; an env already set by the caller is honored too.
if (Deno.args.includes("--strict")) Deno.env.set("RUNE_LINT_STRICT", "1");

const startDir = resolve(dir);

// Reject a non-directory cleanly instead of crashing deep in a git spawn.
let startStat: Deno.FileInfo | null = null;
try {
  startStat = Deno.statSync(startDir);
} catch {
  console.error(`rune: no such file or directory: ${dir}`);
  Deno.exit(2);
}
if (!startStat.isDirectory) {
  console.error(`rune: '${dir}' is not a directory.`);
  Deno.exit(2);
}

// Lint the PROJECT: walk up to the nearest deno.json and run from that root, so
// `rune lint` works from anywhere inside a project.
let targetDir = findProjectRoot(startDir);
// In the composed monorepo the keep backend is a `server/` package beside the sprig
// `ui/`. Run from the git root, findProjectRoot lands on the workspace root (which has
// no `src/` of its own) — descend into `server/` when THAT holds the codegen tree, so
// `rune lint` works from the git root as well as from inside `server/`.
{
  const hasOwnSrc = (() => {
    try {
      return Deno.statSync(join(targetDir, "src")).isDirectory;
    } catch {
      return false;
    }
  })();
  if (!hasOwnSrc) {
    try {
      if (
        Deno.statSync(join(targetDir, "server", "bootstrap", "mod.ts")).isFile
      ) {
        targetDir = join(targetDir, "server");
      }
    } catch { /* no server/ backend — lint targetDir as-is */ }
  }
}
if (targetDir !== startDir && !json) {
  console.log(`Linting from project root: ${targetDir}`);
}

const ignoredPaths = await getIgnoredPaths(targetDir);

let scanDir = targetDir;
let filterPrefix: string | null = null;

if (moduleName) {
  scanDir = resolve(join(targetDir, "src", moduleName));
  filterPrefix = `src/${moduleName}/`;
}

if (!json) printHeader(scanDir);
const allResults: EntryResult[] = await runPipeline(
  moduleName ? targetDir : scanDir,
  rules,
  ignoredPaths,
);

// Filter to only the module's violations when --module is used
const filtered = filterPrefix
  ? allResults.filter((r) => r.path.startsWith(filterPrefix!))
  : allResults;

// Deterministic suggestions for simple rules
for (const r of filtered) {
  if (r.suggestion) continue;

  if (r.rule === "import-aliases") {
    const imp = r.violations[0]?.match(/\((.+)\)$/)?.[1];
    if (imp) {
      r.suggestion =
        `Replace the relative import "${imp}" with the corresponding @ alias.`;
    }
  } else if (r.rule === "external-imports") {
    r.suggestion =
      "Use a # alias in the import map instead of bare npm: or jsr: specifiers.";
  } else if (r.rule === "barrel-discipline") {
    r.suggestion =
      "Move re-exports to mod-root.ts or poly-mod.ts — other files should only export their own declarations.";
  } else if (r.rule === "dto-validation") {
    r.suggestion = "Add a Zod schema to validate this DTO shape.";
  } else if (r.rule === "layer-restrictions") {
    r.suggestion = r.violations[0];
  } else if (r.rule === "module-isolation") {
    r.suggestion = r.violations[0];
  } else if (r.rule === "fixture-promotion") {
    r.suggestion =
      "Move this fixture to assets/ since it's imported by production code.";
  } else if (r.rule === "structure") {
    const v = r.violations[0] ?? "";
    if (v.includes("Wrong extension")) {
      const match = v.match(/expected (.+?) \(/);
      if (match) {
        r.suggestion = `Rename this file to use the ${match[1]} extension.`;
      }
    } else if (v.includes("Missing required file")) {
      const match = v.match(/Missing required file "(.+?)"/);
      const extMatch = v.match(/\((\.[a-z]+(?:\|.[a-z]+)*)\)/);
      if (match) {
        r.suggestion = `Create ${match[1]}${
          extMatch ? extMatch[1].split("|")[0] : ".ts"
        } in this folder.`;
      }
    }
  }
}

if (suggest && filtered.length > 0) {
  const needsLlm = filtered.some(
    (r) =>
      !r.suggestion &&
      ((r.rule === "structure" &&
        r.violations.some((v) => v.includes("not allowed"))) ||
        r.rule === "module-fragmentation"),
  );

  if (needsLlm) {
    try {
      const specJson = JSON.stringify(SHAPE, null, 2);
      const readFile = (path: string) =>
        Deno.readTextFile(join(targetDir, path));
      console.error("  [suggest] Generating suggestions via OpenAI...");
      const t0 = performance.now();
      await suggestForResults(filtered, specJson, readFile);
      console.error(
        `  [suggest] Done in ${(performance.now() - t0).toFixed(0)}ms`,
      );
    } catch (e) {
      console.error(`  [suggest] Failed: ${e}`);
    }
  }
}

if (json) printJson(filtered);
else printResults(filtered);

Deno.exit(filtered.length > 0 ? 1 : 0);
