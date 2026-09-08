import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

function makeCtx(
  files: string[],
  importMap: Record<string, string[]> = {},
): PipelineContext {
  return {
    targetDir: "/tmp",
    files,
    dirs: [],
    getFileContent: async () => "",
    getImports: async (rel: string) => importMap[rel] ?? [],
    lsp: null,
  };
}

Deno.test("check — fixture not imported by any mod/bootstrap returns null", async () => {
  const ctx = makeCtx(
    ["fixtures/seeds/users.json", "src/app/domain/business/auth/mod.ts"],
    { "src/app/domain/business/auth/mod.ts": ["@core/dto/types.ts"] },
  );
  const result = await check("fixtures/seeds/users.json", "json", ctx);
  assertEquals(result, null);
});

Deno.test("check — fixture imported by a mod.ts returns violation", async () => {
  const ctx = makeCtx(
    ["fixtures/seeds/users.json", "src/app/domain/data/seed/mod.ts"],
    { "src/app/domain/data/seed/mod.ts": ["fixtures/seeds/users.json"] },
  );
  const result = await check("fixtures/seeds/users.json", "json", ctx);
  assertEquals(result, [
    "This fixture is imported by production code — move it to assets/ instead",
  ]);
});

Deno.test("check — fixture imported by a bootstrap file returns violation", async () => {
  const ctx = makeCtx(
    ["fixtures/config/defaults.json", "src/bootstrap/mod.ts"],
    { "src/bootstrap/mod.ts": ["fixtures/config/defaults.json"] },
  );
  const result = await check("fixtures/config/defaults.json", "json", ctx);
  assertEquals(result, [
    "This fixture is imported by production code — move it to assets/ instead",
  ]);
});

Deno.test("check — fixture imported only by a test file returns null", async () => {
  const ctx = makeCtx(
    ["fixtures/seeds/users.json", "src/app/domain/business/auth/test.ts"],
    { "src/app/domain/business/auth/test.ts": ["fixtures/seeds/users.json"] },
  );
  const result = await check("fixtures/seeds/users.json", "json", ctx);
  assertEquals(result, null);
});

Deno.test("check — non-fixture file returns null", async () => {
  const ctx = makeCtx(
    ["src/app/domain/business/auth/mod.ts"],
    {},
  );
  const result = await check("src/app/domain/business/auth/mod.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("check — folder target returns null", async () => {
  const ctx = makeCtx(["fixtures/seeds"], {});
  const result = await check("fixtures/seeds", "folder", ctx);
  assertEquals(result, null);
});

Deno.test("check — matches import without file extension", async () => {
  const ctx = makeCtx(
    ["fixtures/seeds/users.ts", "src/app/domain/data/seed/mod.ts"],
    { "src/app/domain/data/seed/mod.ts": ["fixtures/seeds/users"] },
  );
  const result = await check("fixtures/seeds/users.ts", "ts", ctx);
  assertEquals(result, [
    "This fixture is imported by production code — move it to assets/ instead",
  ]);
});
