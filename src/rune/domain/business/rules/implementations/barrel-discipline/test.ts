import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

const BARREL_CONTENT = ["export", "{ foo }", "from", "'./bar.ts'"].join(" ");
const CLEAN_CONTENT = "export function foo() { return 1; }";

Deno.test("check — skips mod-root files", async () => {
  const ctx: PipelineContext = {
    targetDir: "/tmp",
    files: [],
    dirs: [],
    getFileContent: async () => BARREL_CONTENT,
    getImports: async () => [],
    lsp: null,
  };
  const result = await check("src/orders/mod-root.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("check — flags barrel in regular file", async () => {
  const ctx: PipelineContext = {
    targetDir: "/tmp",
    files: [],
    dirs: [],
    getFileContent: async () => BARREL_CONTENT,
    getImports: async () => [],
    lsp: null,
  };
  const result = await check(
    "src/orders/domain/business/foo/mod.ts",
    "ts",
    ctx,
  );
  assertEquals(result![0].includes("Re-exports"), true);
});

Deno.test("check — passes file with no re-exports", async () => {
  const ctx: PipelineContext = {
    targetDir: "/tmp",
    files: [],
    dirs: [],
    getFileContent: async () => CLEAN_CONTENT,
    getImports: async () => [],
    lsp: null,
  };
  const result = await check(
    "src/orders/domain/business/foo/mod.ts",
    "ts",
    ctx,
  );
  assertEquals(result, null);
});
