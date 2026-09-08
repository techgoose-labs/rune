import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

function ctxWith(rune: string, files: string[]): PipelineContext {
  return {
    targetDir: "/tmp",
    files,
    dirs: [],
    getFileContent: async () => rune,
    getImports: async () => [],
    lsp: null,
  };
}

const RUNE = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    [PLY] provider.getRecording(id): data
        [CSE] genie
        ex:provider.search(id): SearchDto
        [CSE] fiveNine
        ex:provider.search(id): SearchDto`;

const ALL_FILES = [
  "src/recording/domain/business/provider/base/mod.ts",
  "src/recording/domain/business/provider/base/test.ts",
  "src/recording/domain/business/provider/poly-mod.ts",
  "src/recording/domain/business/provider/implementations/genie/mod.ts",
  "src/recording/domain/business/provider/implementations/genie/test.ts",
  "src/recording/domain/business/provider/implementations/five-nine/mod.ts",
  "src/recording/domain/business/provider/implementations/five-nine/test.ts",
];

Deno.test("check — no [PLY] means no violations", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    db:metadata.set(id, x): void`;
  const ctx = ctxWith(rune, []);
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — passes with full poly structure", async () => {
  const ctx = ctxWith(RUNE, ALL_FILES);
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — flags missing base/mod.ts", async () => {
  const files = ALL_FILES.filter((f) => !f.endsWith("base/mod.ts"));
  const ctx = ctxWith(RUNE, files);
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("base/mod.ts"), true);
});

Deno.test("check — flags missing poly-mod.ts", async () => {
  const files = ALL_FILES.filter((f) => !f.endsWith("/provider/poly-mod.ts"));
  const ctx = ctxWith(RUNE, files);
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("poly-mod.ts"), true);
});

Deno.test("check — flags missing case implementations", async () => {
  const files = ALL_FILES.filter((f) => !f.includes("/implementations/genie/"));
  const ctx = ctxWith(RUNE, files);
  const result = await check("specs/recording.rune", "rune", ctx);
  // 2 missing case files for genie
  assertEquals(result?.length, 2);
  assertEquals(result?.every((v) => v.includes("genie")), true);
});

Deno.test("check — kebab-cases case names", async () => {
  const ctx = ctxWith(RUNE, []);
  const result = await check("specs/recording.rune", "rune", ctx);
  // fiveNine → five-nine in path
  assertEquals(
    result?.some((v) => v.includes("/implementations/five-nine/")),
    true,
  );
});

Deno.test("check — no violations when all files present", async () => {
  const ctx = ctxWith(RUNE, ALL_FILES);
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});
