import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

function ctxWith(
  rune: string,
  files: string[],
  contents: Record<string, string> = {},
): PipelineContext {
  return {
    targetDir: "/tmp",
    files,
    dirs: [],
    getFileContent: async (rel) => contents[rel] ?? rune,
    getImports: async () => [],
    lsp: null,
  };
}

Deno.test("check — passes when TYP file exists with type identifier", async () => {
  const rune = `[TYP] url: string
    a URL string`;
  const ctx = ctxWith(rune, ["src/recording/dto/url.ts"], {
    "src/recording/dto/url.ts": `export type url = string;`,
    "specs/recording.rune": rune,
  });
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — flags missing TYP file", async () => {
  const rune = `[TYP] url: string
    a URL string`;
  const ctx = ctxWith(rune, [], { "specs/recording.rune": rune });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("/dto/url.ts"), true);
});

Deno.test("check — flags TYP file without identifier", async () => {
  const rune = `[TYP] url: string
    desc`;
  const ctx = ctxWith(rune, ["src/recording/dto/url.ts"], {
    "src/recording/dto/url.ts": `export const wrongName = "x";`,
    "specs/recording.rune": rune,
  });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("doesn't reference"), true);
});

Deno.test("check — :core modifier routes to core/dto/", async () => {
  const rune = `[TYP:core] timestamp: number
    desc`;
  const ctx = ctxWith(rune, [], { "specs/recording.rune": rune });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.[0].includes("src/core/dto/timestamp.ts"), true);
});

Deno.test("check — kebab-cases multi-word TYP name", async () => {
  const rune = `[TYP] providerName: string
    desc`;
  const ctx = ctxWith(rune, [], { "specs/recording.rune": rune });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.[0].includes("/dto/provider-name.ts"), true);
});
