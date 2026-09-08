#!/usr/bin/env -S deno run --allow-read --allow-write
// Regenerate every artifact derived from the single-source registry.
//
//   deno run --allow-read --allow-write scripts/generate.mjs
//   deno run --allow-read --allow-write scripts/generate.mjs --out   # write to scripts/out/ only (diff first)
//
// Single source of truth: lang/keywords.json. Derived (do NOT hand-edit):
//   lang/grammar/grammar.js      the tree-sitter grammar  (then: tree-sitter generate)
//   lang/queries/highlights.scm  the highlight query
//
// The Drift gate (WO-1) runs this then `git diff --exit-code`: a clean tree
// proves no derived artifact was hand-edited.

import { buildGrammar, buildHighlights } from "./generate-core.mjs";

const HERE = new URL(".", import.meta.url);
const registryUrl = new URL("../lang/keywords.json", HERE);

const outOnly = Deno.args.includes("--out");
const outDir = new URL("out/", HERE);

const dest = outOnly
  ? {
    grammar: new URL("grammar.js", outDir),
    highlights: new URL("highlights.scm", outDir),
  }
  : {
    grammar: new URL("../lang/grammar/grammar.js", HERE),
    highlights: new URL("../lang/queries/highlights.scm", HERE),
  };

async function writeText(url, text) {
  if (outOnly) await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(url, text);
}

// Single source of truth: keywords.json (the rune-studio artifact). The Rust
// tree-sitter grammar + highlight query under lang/ are DERIVED from it.
const raw = await Deno.readTextFile(registryUrl);
const reg = JSON.parse(raw);

await writeText(dest.grammar, buildGrammar(reg));
await writeText(dest.highlights, buildHighlights(reg));

console.log(
  `Generated from ${reg.tags.length} tag(s)${outOnly ? " -> out/" : ""}:`,
);
console.log("  lang/grammar/grammar.js");
console.log("  lang/queries/highlights.scm");
if (!outOnly) {
  console.log("(tree-sitter parser: run `tree-sitter generate` in rune/)");
}
