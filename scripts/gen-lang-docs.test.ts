import { assert, assertEquals } from "#std/assert";
import { registry } from "@rune/domain/business/registry/mod.ts";
import { planManifest } from "@rune/domain/business/rune-manifest/mod.ts";
import { buildCard, fillMarkers, SECTIONS } from "./gen-lang-docs.ts";
import { buildScannerConfig } from "./generate-core.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, ROOT));

Deno.test("REQ-028: the doc tables between the markers are the registry's and example.rune checks clean", async () => {
  for (const rel of ["lang/docs/spec.md", "lang/docs/constraints.md"]) {
    const doc = await read(rel);
    assertEquals(fillMarkers(doc), doc, `${rel} is out of date — run scripts/gen-lang-docs.ts`);
    assert(doc.includes("<!-- rune:gen "), `${rel} carries no generated section`);
  }
  // Every registry fact is in the rendered tables.
  const spec = await read("lang/docs/spec.md");
  for (const t of registry.tags) assert(spec.includes(`\`${t.tag}\``), t.tag);
  for (const m of registry.modifiers) assert(spec.includes(m.syntax ?? m.token), m.id);
  for (const t of registry.transports) assert(spec.includes(`\`${t.id}\``), t.id);
  for (const f of registry.faults.wellKnown) assert(spec.includes(`\`${f.id}\``), f.id);
  const constraints = await read("lang/docs/constraints.md");
  for (const r of registry.lint.filter((r) => r.target === "spec")) {
    assert(constraints.includes(`\`${r.id}\``), `rule ${r.id} missing from constraints.md`);
  }
  // An unknown section name is refused, never silently dropped.
  let threw = false;
  try {
    fillMarkers("<!-- rune:gen nope -->x<!-- /rune:gen -->");
  } catch {
    threw = true;
  }
  assert(threw);
  // The documentation example is a valid spec: it checks clean.
  const example = await read("lang/docs/example.rune");
  assertEquals(planManifest("src/example/example.rune", example, new Set()).findings, []);
});

Deno.test("REQ-029: the card carries the valid corpus, the tables, every rule and every invalid fixture as an error → fix pair, and the skill ships it", async () => {
  const card = await read("lang/docs/card.md");
  assertEquals(card, await buildCard(), "lang/docs/card.md is out of date — run scripts/gen-lang-docs.ts");
  const valid = [...Deno.readDirSync(new URL("fixtures/corpus/valid/", ROOT))].filter((e) => e.name.endsWith(".rune"));
  for (const e of valid) assert(card.includes(`### ${e.name}`), e.name);
  for (const name of Object.keys(SECTIONS)) {
    if (name === "generated-rules") continue;
    assert(card.includes(SECTIONS[name]().split("\n")[0]), `section ${name}`);
  }
  for (const r of registry.lint.filter((r) => r.target === "spec")) assert(card.includes(`\`${r.id}\``), r.id);
  const invalid = [...Deno.readDirSync(new URL("fixtures/corpus/invalid/", ROOT))].filter((e) => e.name.endsWith(".rune"));
  for (const e of invalid) {
    const stem = e.name.replace(/\.rune$/, "");
    assert(card.includes(`### ${stem}`), stem);
    const side = JSON.parse(await read(`fixtures/corpus/invalid/${stem}.diag.json`)) as { id: string }[];
    for (const f of side) assert(card.includes(`[${f.id}]`), `${stem}: ${f.id}`);
  }
  // The rune:spec skill ships the card (and the cookbook), not spec.md + constraints.md.
  const sync = await read("scripts/sync-spec-skill-refs.ts");
  assert(sync.includes('["lang/docs/card.md", "card.md"]'));
  assert(!sync.includes('"lang/docs/spec.md"'));
  assert(!sync.includes('"lang/docs/constraints.md"'));
  assertEquals(await read("claude/skills/rune:spec/references/card.md"), card, "the shipped card drifted — run scripts/sync-spec-skill-refs.ts");
});

Deno.test("REQ-024: the generated reference documents `?`, `(s?)`, string enums and [DTO:open] from the registry", async () => {
  const tags = SECTIONS.tags();
  assert(tags.includes("`name?`"), "optional property");
  assert(tags.includes("`tag(s?)`"), "lenient array");
  assert(tags.includes("[DTO:open]"), "open DTO");
  assert(tags.includes('"a" \\| "b"'), "string enums are quoted unions (the pipe is escaped in a table cell)");
  const spec = await read("lang/docs/spec.md");
  assert(spec.includes("`name?`") && spec.includes("`tag(s?)`") && spec.includes("[DTO:open]"));
});

Deno.test("REQ-033: scanner-config.h is generated from the registry's indent table", async () => {
  const header = await read("lang/grammar/src/scanner-config.h");
  assertEquals(header, buildScannerConfig(registry), "lang/grammar/src/scanner-config.h drifted — run scripts/generate.mjs");
  assert(header.includes(`#define RUNE_INDENT_UNIT ${registry.indent.unit}`));
  assert(header.includes(`#define RUNE_FAULT_MARKER '${registry.faults.marker}'`));
  assertEquals((await read("lang/grammar/src/scanner.c")).includes('#include "scanner-config.h"'), true);
});
