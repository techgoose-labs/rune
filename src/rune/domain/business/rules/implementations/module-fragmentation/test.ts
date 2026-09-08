import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

function makeCtx(
  files: string[],
  dirs: string[],
  importMap: Record<string, string[]> = {},
): PipelineContext {
  return {
    targetDir: "/fake",
    files,
    dirs,
    getFileContent: async () => "",
    getImports: async (rel: string) => importMap[rel] ?? [],
    lsp: null,
  };
}

Deno.test("check — skips non-folder targets", async () => {
  const ctx = makeCtx([], []);
  const result = await check("src/orders", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("check — skips non-module paths", async () => {
  const ctx = makeCtx([], []);
  const result = await check("src/orders/domain/business", "folder", ctx);
  assertEquals(result, null);
});

Deno.test("check — skips core module", async () => {
  const ctx = makeCtx(
    [
      "src/core/business/classify/mod.ts",
      "src/core/business/classify/test.ts",
      "src/core/dto/types.ts",
    ],
    [
      "src/core",
      "src/core/business",
      "src/core/business/classify",
      "src/core/dto",
    ],
  );
  const result = await check("src/core", "folder", ctx);
  assertEquals(result, null);
});

Deno.test("check — skips bootstrap module", async () => {
  const ctx = makeCtx(
    ["src/bootstrap/mod.ts", "src/bootstrap/config.ts"],
    ["src/bootstrap"],
  );
  const result = await check("src/bootstrap", "folder", ctx);
  assertEquals(result, null);
});

Deno.test("check — returns null for stub module", async () => {
  const ctx = makeCtx(
    ["src/tiny/mod-root.ts"],
    ["src/tiny"],
  );
  const result = await check("src/tiny", "folder", ctx);
  assertEquals(result, null);
});

Deno.test("check — returns null for well-formed module", async () => {
  const ctx = makeCtx(
    [
      "src/orders/mod-root.ts",
      "src/orders/domain/business/create/mod.ts",
      "src/orders/domain/business/create/test.ts",
      "src/orders/domain/business/cancel/mod.ts",
      "src/orders/domain/business/cancel/test.ts",
      "src/orders/domain/data/db/mod.ts",
      "src/orders/domain/data/db/smk.test.ts",
      "src/orders/domain/coordinators/process/mod.ts",
      "src/orders/domain/coordinators/process/int.test.ts",
    ],
    [
      "src/orders",
      "src/orders/domain",
      "src/orders/domain/business",
      "src/orders/domain/business/create",
      "src/orders/domain/business/cancel",
      "src/orders/domain/data",
      "src/orders/domain/data/db",
      "src/orders/domain/coordinators",
      "src/orders/domain/coordinators/process",
    ],
  );
  const result = await check("src/orders", "folder", ctx);
  assertEquals(result, null);
});

Deno.test("check — flags small module", async () => {
  const ctx = makeCtx(
    [
      "src/tiny/mod-root.ts",
      "src/tiny/domain/business/feat/mod.ts",
      "src/tiny/domain/business/feat/test.ts",
      "src/tiny/domain/data/svc/mod.ts",
    ],
    [
      "src/tiny",
      "src/tiny/domain",
      "src/tiny/domain/business",
      "src/tiny/domain/business/feat",
      "src/tiny/domain/data",
      "src/tiny/domain/data/svc",
    ],
  );
  const result = await check("src/tiny", "folder", ctx);
  assertEquals(result !== null, true);
  assertEquals(result!.some((v) => v.includes("source files")), true);
});

Deno.test("check — flags single-feature module", async () => {
  const ctx = makeCtx(
    [
      "src/notify/mod-root.ts",
      "src/notify/domain/business/send/mod.ts",
      "src/notify/domain/business/send/test.ts",
      "src/notify/domain/data/email/mod.ts",
    ],
    [
      "src/notify",
      "src/notify/domain",
      "src/notify/domain/business",
      "src/notify/domain/business/send",
      "src/notify/domain/data",
      "src/notify/domain/data/email",
    ],
  );
  const result = await check("src/notify", "folder", ctx);
  assertEquals(result !== null, true);
  assertEquals(
    result!.some((v) => v.includes("only one business feature")),
    true,
  );
});

Deno.test("check — flags underutilized layers", async () => {
  const ctx = makeCtx(
    [
      "src/util/mod-root.ts",
      "src/util/domain/business/parse/mod.ts",
      "src/util/domain/business/parse/test.ts",
    ],
    [
      "src/util",
      "src/util/domain",
      "src/util/domain/business",
      "src/util/domain/business/parse",
    ],
  );
  const result = await check("src/util", "folder", ctx);
  assertEquals(result !== null, true);
  assertEquals(result!.some((v) => v.includes("layer(s)")), true);
});

Deno.test("check — flags high coupling on small module", async () => {
  const imports: Record<string, string[]> = {
    "src/tiny/mod-root.ts": ["src/big/mod-root.ts"],
    "src/tiny/domain/business/feat/mod.ts": [
      "src/big/mod-root.ts",
      "src/big/mod-root.ts",
    ],
    "src/tiny/domain/data/svc/mod.ts": ["src/big/mod-root.ts"],
  };
  const ctx = makeCtx(
    [
      "src/tiny/mod-root.ts",
      "src/tiny/domain/business/feat/mod.ts",
      "src/tiny/domain/business/feat/test.ts",
      "src/tiny/domain/data/svc/mod.ts",
    ],
    [
      "src/tiny",
      "src/tiny/domain",
      "src/tiny/domain/business",
      "src/tiny/domain/business/feat",
      "src/tiny/domain/data",
      "src/tiny/domain/data/svc",
    ],
    imports,
  );
  const result = await check("src/tiny", "folder", ctx);
  assertEquals(result !== null, true);
  assertEquals(
    result!.some((v) => v.includes("imports") && v.includes("merging")),
    true,
  );
});

Deno.test("check — does not flag coupling on large well-formed module", async () => {
  const imports: Record<string, string[]> = {
    "src/orders/mod-root.ts": ["src/auth/mod-root.ts"],
    "src/orders/domain/business/create/mod.ts": [
      "src/auth/mod-root.ts",
      "src/auth/mod-root.ts",
    ],
    "src/orders/domain/business/cancel/mod.ts": ["src/auth/mod-root.ts"],
    "src/orders/domain/data/db/mod.ts": ["src/auth/mod-root.ts"],
    "src/orders/domain/coordinators/process/mod.ts": ["src/auth/mod-root.ts"],
  };
  const ctx = makeCtx(
    [
      "src/orders/mod-root.ts",
      "src/orders/domain/business/create/mod.ts",
      "src/orders/domain/business/create/test.ts",
      "src/orders/domain/business/cancel/mod.ts",
      "src/orders/domain/business/cancel/test.ts",
      "src/orders/domain/data/db/mod.ts",
      "src/orders/domain/data/db/smk.test.ts",
      "src/orders/domain/coordinators/process/mod.ts",
      "src/orders/domain/coordinators/process/int.test.ts",
    ],
    [
      "src/orders",
      "src/orders/domain",
      "src/orders/domain/business",
      "src/orders/domain/business/create",
      "src/orders/domain/business/cancel",
      "src/orders/domain/data",
      "src/orders/domain/data/db",
      "src/orders/domain/coordinators",
      "src/orders/domain/coordinators/process",
    ],
    imports,
  );
  const result = await check("src/orders", "folder", ctx);
  assertEquals(result, null);
});

Deno.test("check — single business feature alone (adequate size + layers) is NOT flagged", async () => {
  // A focused service like `secrets` legitimately has one business noun. With
  // enough source files and ≥2 active layers, the single-feature signal must not
  // fire on its own — it only contributes when corroborated by structural thinness.
  const ctx = makeCtx(
    [
      "src/secrets/mod-root.ts",
      "src/secrets/domain/business/vault/mod.ts",
      "src/secrets/domain/business/vault/test.ts",
      "src/secrets/domain/coordinators/vault-fetch/mod.ts",
      "src/secrets/domain/coordinators/vault-fetch/int.test.ts",
      "src/secrets/dto/secret.ts",
      "src/secrets/dto/secret-ref.ts",
      "src/secrets/entrypoints/http/mod.ts",
    ],
    [
      "src/secrets",
      "src/secrets/domain",
      "src/secrets/domain/business",
      "src/secrets/domain/business/vault",
      "src/secrets/domain/coordinators",
      "src/secrets/domain/coordinators/vault-fetch",
      "src/secrets/dto",
      "src/secrets/entrypoints",
      "src/secrets/entrypoints/http",
    ],
  );
  const result = await check("src/secrets", "folder", ctx);
  assertEquals(result, null);
});
