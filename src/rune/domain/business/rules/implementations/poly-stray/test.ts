import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

const fileContents: Record<string, string> = {
  "src/mymod/domain/business/rules/implementations/foo/mod.ts":
    'export async function check() {}\nexport const SYSTEM_PROMPT = "";\nexport function buildPrompt() {}',
  "src/mymod/domain/business/rules/implementations/bar/mod.ts":
    'export async function check() {}\nexport const SYSTEM_PROMPT = "";\nexport function buildPrompt() {}',
  "src/mymod/domain/business/stray/mod.ts":
    'export async function check() {}\nexport const SYSTEM_PROMPT = "";\nexport function buildPrompt() {}',
  "src/mymod/domain/business/unrelated/mod.ts":
    "export function doSomething() {}\nexport const VALUE = 42;",
};

function makeCtx(files: string[], dirs: string[]): PipelineContext {
  return {
    targetDir: "/fake",
    files,
    dirs,
    getFileContent: async (rel: string) => fileContents[rel] ?? "",
    getImports: async () => [],
    lsp: null,
  };
}

Deno.test("flags standalone that matches poly implementations", async () => {
  const ctx = makeCtx(
    Object.keys(fileContents).concat([
      "src/mymod/domain/business/rules/poly-mod.ts",
    ]),
    [
      "src/mymod/domain/business",
      "src/mymod/domain/business/rules",
      "src/mymod/domain/business/rules/implementations",
      "src/mymod/domain/business/rules/implementations/foo",
      "src/mymod/domain/business/rules/implementations/bar",
      "src/mymod/domain/business/stray",
      "src/mymod/domain/business/unrelated",
    ],
  );

  const result = await check("src/mymod/domain/business", "folder", ctx);
  assertEquals(result !== null, true, "should flag stray");
  assertEquals(result!.length, 1);
  assertEquals(result![0].includes("belongs inside"), true);
});

Deno.test("does not flag unrelated standalone", async () => {
  const ctx = makeCtx(
    [
      "src/mymod/domain/business/rules/implementations/foo/mod.ts",
      "src/mymod/domain/business/rules/poly-mod.ts",
      "src/mymod/domain/business/unrelated/mod.ts",
    ],
    [
      "src/mymod/domain/business",
      "src/mymod/domain/business/rules",
      "src/mymod/domain/business/rules/implementations",
      "src/mymod/domain/business/rules/implementations/foo",
      "src/mymod/domain/business/unrelated",
    ],
  );

  const result = await check("src/mymod/domain/business", "folder", ctx);
  assertEquals(result, null, "unrelated should not be flagged");
});

Deno.test("skips non-business folders", async () => {
  const ctx = makeCtx([], []);
  const result = await check("src/mymod/domain/data", "folder", ctx);
  assertEquals(result, null);
});

Deno.test("skips files", async () => {
  const ctx = makeCtx([], []);
  const result = await check("src/mymod/domain/business/foo/mod.ts", "ts", ctx);
  assertEquals(result, null);
});
