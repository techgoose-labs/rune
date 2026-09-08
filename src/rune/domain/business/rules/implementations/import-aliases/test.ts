import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@/core/dto/types.ts";

function makeCtx(files: Record<string, string>): PipelineContext {
  return {
    targetDir: "/fake",
    files: Object.keys(files),
    dirs: [],
    getFileContent: async (rel: string) => files[rel] ?? "",
    getImports: async () => [],
    lsp: null,
  };
}

Deno.test("flags dotdot imports", async () => {
  const ctx = makeCtx({
    "src/mod/domain/foo.ts":
      `import { x } from "${"../"}../core/dto/types.ts";`,
  });
  const result = await check("src/mod/domain/foo.ts", "ts", ctx);
  assertEquals(result !== null, true);
  assertEquals(result![0].includes("../"), true);
  assertEquals(result![0].includes("@ alias"), true);
});

Deno.test("allows alias imports", async () => {
  const ctx = makeCtx({
    "src/mod/domain/foo.ts": 'import { x } from "@/core/dto/types.ts";',
  });
  const result = await check("src/mod/domain/foo.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("allows sibling imports", async () => {
  const ctx = makeCtx({
    "src/mod/domain/foo.ts": 'import { x } from "./bar.ts";',
  });
  const result = await check("src/mod/domain/foo.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("skips folders", async () => {
  const ctx = makeCtx({});
  const result = await check("src/mod/domain", "folder", ctx);
  assertEquals(result, null);
});
