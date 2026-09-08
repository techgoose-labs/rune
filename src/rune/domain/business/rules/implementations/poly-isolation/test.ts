import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

const mockCtx: PipelineContext = {
  targetDir: "/tmp",
  files: [],
  dirs: [],
  getFileContent: async () => "",
  getImports: async () => [],
  lsp: null,
};

Deno.test("check — skips folders", async () => {
  const result = await check(
    "src/orders/domain/business/foo",
    "folder",
    mockCtx,
  );
  assertEquals(result, null);
});

Deno.test("check — no violations when no poly-mod files exist", async () => {
  const result = await check(
    "src/orders/domain/business/foo/mod.ts",
    "ts",
    mockCtx,
  );
  assertEquals(result, null);
});
