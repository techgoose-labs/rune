import { dirname, join, relative, resolve } from "#std/path";
import {
  artifactToOptions,
  type ManifestOptions,
  planManifest,
} from "@rune/domain/business/rune-manifest/mod.ts";
import { loadArtifact } from "@rune/domain/business/artifact/mod.ts";
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

interface ManifestArgs {
  runePath: string;
  root: string | null; // null = derive from the spec's location; --root overrides
  json: boolean;
  artifactPath: string | null;
}

function parseManifestArgs(args: string[]): ManifestArgs | null {
  let runePath: string | null = null;
  let root: string | null = null;
  let json = false;
  let artifactPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--root") root = args[++i] ?? ".";
    else if (a === "--artifact") artifactPath = args[++i] ?? null;
    else if (!a.startsWith("--")) {
      if (runePath === null) runePath = a;
    }
  }
  if (runePath === null) return null;
  return { runePath, root, json, artifactPath };
}

// Load --artifact into engine options (bindings + codegen templates + policies);
// returns null for "no artifact, use defaults" or "error" after printing why.
async function loadOptions(
  artifactPath: string | null,
  json: boolean,
): Promise<ManifestOptions | null | "error"> {
  if (!artifactPath) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(resolve(artifactPath)));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (json) {
      console.log(
        JSON.stringify(
          { error: "artifact", path: artifactPath, message },
          null,
          2,
        ),
      );
    } else {console.error(
        `${RED}error: cannot load artifact ${artifactPath}: ${message}${RESET}`,
      );}
    return "error";
  }
  const artifact = loadArtifact(parsed, artifactPath);
  if (!artifact) return "error";
  return artifactToOptions(artifact);
}

export async function runManifest(args: string[]): Promise<number> {
  const parsed = parseManifestArgs(args);
  if (!parsed) {
    console.error(
      "Usage: rune manifest <rune-file> [--root <dir>] [--artifact <keywords.json>] [--json]",
    );
    return 2;
  }

  const absRune = resolve(parsed.runePath);
  const root = parsed.root !== null
    ? resolve(parsed.root)
    : resolveRoot(absRune);
  const relRune = relative(root, absRune);

  let runeText: string;
  try {
    runeText = await Deno.readTextFile(absRune);
  } catch (e) {
    if (parsed.json) {
      console.log(JSON.stringify(
        {
          error: "io",
          path: parsed.runePath,
          message: String(e instanceof Error ? e.message : e),
        },
        null,
        2,
      ));
    } else {
      console.error(
        `${RED}error: cannot read ${parsed.runePath}: ${
          e instanceof Error ? e.message : e
        }${RESET}`,
      );
    }
    return 2;
  }

  const opts = await loadOptions(parsed.artifactPath, parsed.json);
  if (opts === "error") return 2;

  const existingFiles = await collectFiles(root);
  const sharedSrvs = await loadCoreSrvs(root, absRune);
  const coreSpecFound = await coreSpecExists(root, absRune);
  const plan = planManifest(
    relRune,
    runeText,
    existingFiles,
    { ...(opts ?? {}), strictServices: true, projectRoot: root, coreSpecFound },
    sharedSrvs,
  );

  if (plan.errors.length > 0) {
    if (parsed.json) {
      console.log(JSON.stringify(
        {
          error: "parse_error",
          rune: relRune,
          errors: plan.errors,
        },
        null,
        2,
      ));
    } else {
      console.error(`${RED}error in ${relRune}:${RESET}`);
      for (const e of plan.errors) console.error(`  ${e}`);
    }
    return 2;
  }

  // Write all toCreate files.
  const created: string[] = [];
  const regenerated: string[] = [];
  const ioErrors: string[] = [];
  for (const file of plan.toCreate) {
    const abs = join(root, file.path);
    try {
      await Deno.mkdir(dirname(abs), { recursive: true });
      await Deno.writeTextFile(abs, file.content);
      created.push(file.path);
    } catch (e) {
      ioErrors.push(
        `${file.path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Spec-owned signatures (sig.ts): rewritten every run.
  for (const file of plan.toRegenerate) {
    const abs = join(root, file.path);
    try {
      await Deno.mkdir(dirname(abs), { recursive: true });
      await Deno.writeTextFile(abs, file.content);
      regenerated.push(file.path);
    } catch (e) {
      ioErrors.push(
        `${file.path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (parsed.json) {
    console.log(JSON.stringify(
      {
        module: plan.module,
        rune: relRune,
        created,
        regenerated,
        appended: [],
        skipped: plan.toSkip.map((f) => f.path),
        errors: ioErrors,
      },
      null,
      2,
    ));
  } else {
    console.log(
      `${BOLD}Manifested ${relRune} (module: ${plan.module})${RESET}`,
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
    if (plan.toSkip.length > 0) {
      console.log(
        `\n  ${YELLOW}Skipped ${plan.toSkip.length} existing file(s).${RESET}`,
      );
    }
    if (ioErrors.length > 0) {
      console.log(`\n  ${RED}I/O errors:${RESET}`);
      for (const e of ioErrors) console.log(`    ${RED}! ${e}${RESET}`);
    }
    if (created.length === 0 && plan.toSkip.length > 0) {
      console.log(
        `\n  ${CYAN}Nothing to do — all files already exist.${RESET}`,
      );
    }
  }

  return ioErrors.length > 0 ? 2 : 0;
}

async function collectFiles(root: string): Promise<Set<string>> {
  const SKIP = new Set([".git", "node_modules", "dist", ".playwright-mcp"]);
  const files = new Set<string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(dir);
    } catch {
      return;
    }
    for await (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory) await walk(abs, rel);
      else if (entry.isFile) files.add(rel);
    }
  }
  await walk(root, "");
  return files;
}
