import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

Deno.test("check — skips non-dto files", async () => {
  const ctx: PipelineContext = {
    targetDir: "/tmp",
    files: [],
    dirs: [],
    getFileContent: async () => "",
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

Deno.test("check — flags dto without validation", async () => {
  const ctx: PipelineContext = {
    targetDir: "/tmp",
    files: [],
    dirs: [],
    // A value export (runtime surface) with no validation → flagged.
    getFileContent: async () => "export const foo = { bar: 'x' };",
    getImports: async () => [],
    lsp: null,
  };
  const result = await check("src/orders/dto/foo.ts", "ts", ctx);
  assertEquals(result![0].includes("missing runtime validation"), true);
});

Deno.test("check — passes a pure type alias (no runtime surface)", async () => {
  const ctx: PipelineContext = {
    targetDir: "/tmp",
    files: [],
    dirs: [],
    getFileContent: async () => "export type Id = string;",
    getImports: async () => [],
    lsp: null,
  };
  const result = await check("src/orders/dto/id.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("check — passes dto with zod schema", async () => {
  const ctx: PipelineContext = {
    targetDir: "/tmp",
    files: [],
    dirs: [],
    getFileContent: async () => "const schema = z.object({ bar: z.string() })",
    getImports: async () => [],
    lsp: null,
  };
  const result = await check("src/orders/dto/foo.ts", "ts", ctx);
  assertEquals(result, null);
});
