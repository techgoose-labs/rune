import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

function makeCtx(content: string, sig: string): PipelineContext {
  return {
    targetDir: "/tmp",
    files: [],
    dirs: [],
    getFileContent: async () => content,
    getImports: async () => [],
    lsp: {
      capabilities: {
        documentSymbol: true,
        hover: true,
        references: true,
        implementation: true,
        definition: true,
        diagnostics: true,
      },
      getExportTypes: async () => [{ name: "User", kind: "Class", type: "" }],
      getSiblingExportSignatures: async () => new Map(),
      getSymbolType: async () => sig,
      findSymbolReferences: async () => [],
      findSymbolImplementations: async () => [],
      findSymbolDefinition: async () => [],
      getDiagnostics: async () => [],
    },
  };
}

Deno.test("skips files without class-validator decorators", async () => {
  const ctx = makeCtx(
    "export class Foo { bar(): string { return ''; } }",
    "class Foo { bar(): string; }",
  );
  const result = await check("src/x/y.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("flags primitive return from data class method", async () => {
  const ctx = makeCtx(
    "class User { @IsString() name!: string; getName(): string { return this.name; } }",
    "class User { name: string; getName(): string; }",
  );
  const result = await check("src/x/y.ts", "ts", ctx);
  assertEquals(result !== null && result[0].includes("getName"), true);
});

Deno.test("passes when method returns a class instance", async () => {
  const ctx = makeCtx(
    "class User { @IsString() name!: string; withName(): User { return this; } }",
    "class User { name: string; withName(): User; }",
  );
  const result = await check("src/x/y.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("passes for Promise<Class> returns", async () => {
  const ctx = makeCtx(
    "class User { @IsString() name!: string; async load(): Promise<User> { return this; } }",
    "class User { name: string; load(): Promise<User>; }",
  );
  const result = await check("src/x/y.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("flags object literal return", async () => {
  const ctx = makeCtx(
    "class User { @IsString() name!: string; toJSON() { return { name: this.name }; } }",
    "class User { name: string; toJSON(): { name: string; }; }",
  );
  const result = await check("src/x/y.ts", "ts", ctx);
  assertEquals(result !== null, true);
});

// Regression: a member whose param carries an inline object type with an internal
// `;` must not be fragmented at that `;` — its real primitive return still flags.
Deno.test("flags primitive return even with an inline-object param containing ';'", async () => {
  const ctx = makeCtx(
    "class User { @IsString() name!: string; build(opts: { a: number; b: string }): string { return this.name; } }",
    "class User { name: string; build(opts: { a: number; b: string }): string; }",
  );
  const result = await check("src/x/y.ts", "ts", ctx);
  assertEquals(result !== null && result[0].includes("build"), true);
});
