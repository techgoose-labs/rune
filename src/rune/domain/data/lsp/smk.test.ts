import { assert, assertEquals } from "#std/assert";
import { Lsp } from "./mod.ts";

const LSP_CONFIG = {
  command: "deno",
  args: ["lsp"],
  initializationOptions: { enable: true },
};

const TEST_FILE = "src/core/business/classify/mod.ts";

Deno.test({
  name: "Lsp — negotiates capabilities",
  ignore: Deno.env.get("CI") === "true",
  async fn() {
    const lsp = new Lsp(Deno.cwd(), LSP_CONFIG);
    await lsp.initialize();
    try {
      assertEquals(lsp.capabilities.documentSymbol, true);
      assertEquals(lsp.capabilities.hover, true);
      assertEquals(lsp.capabilities.references, true);
      assertEquals(lsp.capabilities.definition, true);
    } finally {
      await lsp.shutdown();
    }
  },
});

Deno.test({
  name: "Lsp — get export types",
  ignore: Deno.env.get("CI") === "true",
  async fn() {
    const lsp = new Lsp(Deno.cwd(), LSP_CONFIG);
    await lsp.initialize();
    try {
      const exports = await lsp.getExportTypes(TEST_FILE);
      assert(exports.length > 0, "should find exports");
      assert(exports.some((e) => e.name === "classifyFile"));
    } finally {
      await lsp.shutdown();
    }
  },
});

Deno.test({
  name: "Lsp — getSymbolType returns type signature",
  ignore: Deno.env.get("CI") === "true",
  async fn() {
    const lsp = new Lsp(Deno.cwd(), LSP_CONFIG);
    await lsp.initialize();
    try {
      const type = await lsp.getSymbolType(TEST_FILE, "classifyFile");
      assert(type !== null, "should return type info");
      assert(type!.includes("Classification"), "should mention return type");
    } finally {
      await lsp.shutdown();
    }
  },
});

Deno.test({
  name: "Lsp — getSymbolType returns null for unknown symbol",
  ignore: Deno.env.get("CI") === "true",
  async fn() {
    const lsp = new Lsp(Deno.cwd(), LSP_CONFIG);
    await lsp.initialize();
    try {
      const type = await lsp.getSymbolType(TEST_FILE, "doesNotExist");
      assertEquals(type, null);
    } finally {
      await lsp.shutdown();
    }
  },
});

Deno.test({
  name: "Lsp — findSymbolReferences",
  ignore: Deno.env.get("CI") === "true",
  async fn() {
    const lsp = new Lsp(Deno.cwd(), LSP_CONFIG);
    await lsp.initialize();
    try {
      const refs = await lsp.findSymbolReferences(TEST_FILE, "classifyFile");
      assert(Array.isArray(refs), "should return array");
    } finally {
      await lsp.shutdown();
    }
  },
});

Deno.test({
  name: "Lsp — findSymbolDefinition",
  ignore: Deno.env.get("CI") === "true",
  async fn() {
    const lsp = new Lsp(Deno.cwd(), LSP_CONFIG);
    await lsp.initialize();
    try {
      const defs = await lsp.findSymbolDefinition(TEST_FILE, "classifyFile");
      assert(Array.isArray(defs), "should return array");
    } finally {
      await lsp.shutdown();
    }
  },
});

Deno.test({
  name: "Lsp — graceful fallback when not initialized",
  async fn() {
    const lsp = new Lsp(Deno.cwd(), LSP_CONFIG);
    // No initialize — all capabilities false
    assertEquals(lsp.capabilities.hover, false);
    assertEquals(await lsp.getSymbolType(TEST_FILE, "classifyFile"), null);
    assertEquals(
      (await lsp.findSymbolReferences(TEST_FILE, "classifyFile")).length,
      0,
    );
    assertEquals(
      (await lsp.findSymbolImplementations(TEST_FILE, "classifyFile")).length,
      0,
    );
    assertEquals(
      (await lsp.findSymbolDefinition(TEST_FILE, "classifyFile")).length,
      0,
    );
    assertEquals((await lsp.getDiagnostics(TEST_FILE)).length, 0);
  },
});
