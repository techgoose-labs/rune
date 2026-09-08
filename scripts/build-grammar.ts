#!/usr/bin/env -S deno run -A
// Out-of-band tree-sitter build pipeline.
//
//   deno run -A build-grammar.ts
//
// Regenerates every editor artifact FROM THE ARTIFACT (keywords.json) and compiles
// a WASM parser the in-Studio editor (and external editors) consume — the browser
// never runs the tree-sitter toolchain. Steps:
//   1. generate.mjs          lang/keywords.json -> lang/grammar/grammar.js + lang/queries/highlights.scm
//   2. tree-sitter generate  grammar.js    -> lang/grammar/src/parser.c (+ grammar.json)
//   3. tree-sitter build     parser.c      -> lang/grammar/rune.wasm
//   4. copy rune.wasm + highlights.scm     -> rune-studio/static/ (editor consumes)
//
// A tag/colour change in keywords.json, re-run through this, recolours both the
// in-Studio editor (new WASM + highlights) and any external editor fed the same
// artifacts. No hand edits to generated files (the Drift + grammar gates guard).
//
// This file lives in scripts/, so HERE is scripts/ and repo paths are one up (`../`).

const HERE = new URL(".", import.meta.url);
const grammarDir = new URL("../lang/grammar/", HERE);
const highlightsScm = new URL("../lang/queries/highlights.scm", HERE);
const studioStatic = new URL("../rune-studio/static/", HERE);

async function run(cmd: string, args: string[], cwd: URL): Promise<void> {
  let result;
  try {
    result = await new Deno.Command(cmd, {
      args,
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `'${cmd}' not found on PATH — install it before running build-grammar.ts`,
      );
    }
    throw e;
  }
  if (!result.success) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.code})`);
  }
}

// 1. registry -> lang/grammar/grammar.js + lang/queries/highlights.scm
await run(
  "deno",
  ["run", "--allow-read", "--allow-write", "generate.mjs"],
  HERE,
);
// 2. grammar.js -> parser.c
await run("tree-sitter", ["generate"], grammarDir);
// 3. parser.c -> WASM
await run("tree-sitter", ["build", "--wasm", "-o", "rune.wasm"], grammarDir);
// 4. publish to the studio's static dir for the in-browser editor
await Deno.mkdir(studioStatic, { recursive: true });
await Deno.copyFile(
  new URL("rune.wasm", grammarDir),
  new URL("rune-tree-sitter.wasm", studioStatic),
);
await Deno.copyFile(
  highlightsScm,
  new URL("rune-highlights.scm", studioStatic),
);

console.log("grammar build complete:");
console.log("  lang/grammar/rune.wasm");
console.log("  rune-studio/static/rune-tree-sitter.wasm");
console.log("  rune-studio/static/rune-highlights.scm");
