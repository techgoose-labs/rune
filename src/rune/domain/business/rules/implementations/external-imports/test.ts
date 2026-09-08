import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

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

Deno.test("flags npm: imports", async () => {
  const ctx = makeCtx({
    "src/foo.ts": `import { z } from ${'"npm'}:zod";`,
  });
  const result = await check("src/foo.ts", "ts", ctx);
  assertEquals(result !== null, true);
  assertEquals(result![0].includes("npm:zod"), true);
  assertEquals(result![0].includes("# alias"), true);
});

Deno.test("flags jsr: imports", async () => {
  const ctx = makeCtx({
    "src/foo.ts": `import { join } from ${'"jsr'}:@std/path";`,
  });
  const result = await check("src/foo.ts", "ts", ctx);
  assertEquals(result !== null, true);
  assertEquals(result![0].includes("jsr:@std/path"), true);
});

Deno.test("allows # aliased imports", async () => {
  const ctx = makeCtx({
    "src/foo.ts": 'import { z } from "#zod";',
  });
  const result = await check("src/foo.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("allows bare node imports", async () => {
  const ctx = makeCtx({
    "src/foo.ts": 'import { createHash } from "crypto";',
  });
  const result = await check("src/foo.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("skips folders", async () => {
  const ctx = makeCtx({});
  const result = await check("src/foo", "folder", ctx);
  assertEquals(result, null);
});
