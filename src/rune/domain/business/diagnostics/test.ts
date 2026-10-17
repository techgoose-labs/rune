import { assertEquals } from "#std/assert";
import { renderFinding } from "./mod.ts";
import { registry } from "@rune/domain/business/registry/mod.ts";

Deno.test("REQ-013: renderFinding is path:line: message [id]", () => {
  assertEquals(
    renderFinding({
      id: "cse-outside-ply",
      severity: "error",
      path: "specs/a.rune",
      line: 7,
      message: "[CSE] outside [PLY] block",
    }),
    "specs/a.rune:7: [CSE] outside [PLY] block [cse-outside-ply]",
  );
  // A whole-file finding has no line.
  assertEquals(
    renderFinding({
      id: "mod-underivable",
      severity: "error",
      path: "specs/a.rune",
      line: 0,
      message: "no [MOD] directive and could not derive module name",
    }),
    "specs/a.rune: no [MOD] directive and could not derive module name [mod-underivable]",
  );
});

Deno.test("REQ-013: diagnostic ids are unique", () => {
  const ids = registry.lint.map((r) => r.id);
  assertEquals(new Set(ids).size, ids.length);
});

import { corpusParity } from "./corpus.ts";
import { fromFileUrl, join } from "#std/path";

const CORPUS = fromFileUrl(new URL("../../../../../fixtures/corpus", import.meta.url));

Deno.test("REQ-014: the valid corpus checks clean and every invalid fixture matches its sidecar", async () => {
  assertEquals(await corpusParity(CORPUS), []);
});

Deno.test("REQ-014: an invalid fixture without a sidecar is a mismatch, and a wrong sidecar names the difference", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "valid"));
    await Deno.mkdir(join(dir, "invalid"));
    await Deno.writeTextFile(
      join(dir, "invalid/dup.rune"),
      "[MOD] one\n[MOD] two\n",
    );
    const missing = await corpusParity(dir);
    assertEquals(missing.length, 1);
    assertEquals(missing[0].includes("no sidecar"), true);
    // --update-goldens captures it; the capture is the real verdict.
    assertEquals(await corpusParity(dir, { update: true }), []);
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, "invalid/dup.diag.json"))),
      [{ id: "mod-duplicate", line: 2 }],
    );
    // A sidecar that disagrees is reported with both lists.
    await Deno.writeTextFile(
      join(dir, "invalid/dup.diag.json"),
      JSON.stringify([{ id: "mod-name", line: 2 }], null, 2) + "\n",
    );
    const wrong = await corpusParity(dir);
    assertEquals(wrong.length, 1);
    assertEquals(wrong[0].includes("mod-duplicate@2"), true);
    assertEquals(wrong[0].includes("mod-name@2"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// REQ-016 — the shipped Claude Code plugin marketplace (claude/plugin/) stays
// coherent: the entry name is the manifest name (what `claude plugin install
// rune-lsp@rune` resolves) and the server maps .rune to the rune-lsp binary.
const PLUGIN_ROOT = fromFileUrl(new URL("../../../../../claude/plugin", import.meta.url));

Deno.test("REQ-016: the rune-lsp plugin registers rune-lsp for .rune under the marketplace entry of the same name", async () => {
  const market = JSON.parse(
    await Deno.readTextFile(join(PLUGIN_ROOT, ".claude-plugin/marketplace.json")),
  );
  assertEquals(market.name, "rune");
  const entry = market.plugins.find((p: { name: string }) => p.name === "rune-lsp");
  assertEquals(entry.source, "./rune-lsp");
  const manifest = JSON.parse(
    await Deno.readTextFile(join(PLUGIN_ROOT, "rune-lsp/.claude-plugin/plugin.json")),
  );
  assertEquals(manifest.name, entry.name);
  const lsp = JSON.parse(await Deno.readTextFile(join(PLUGIN_ROOT, "rune-lsp/.lsp.json")));
  assertEquals(lsp.rune.command, "rune-lsp");
  assertEquals(lsp.rune.extensionToLanguage, { ".rune": "rune" });
});
