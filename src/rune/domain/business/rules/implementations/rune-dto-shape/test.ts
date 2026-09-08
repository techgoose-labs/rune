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
    getFileContent: async (rel) => {
      if (contents[rel] !== undefined) return contents[rel];
      return rune; // default — return the rune for the rune path
    },
    getImports: async () => [],
    lsp: null,
  };
}

Deno.test("check — passes when DTO file exists with all properties", async () => {
  const rune = `[DTO] GetRecordingDto: providerName, externalId
    input for retrieving a recording`;
  const dtoContent = `import { z } from "zod";
export const GetRecordingDto = z.object({
  providerName: z.string(),
  externalId: z.string(),
});`;
  const ctx = ctxWith(rune, ["src/recording/dto/get-recording.ts"], {
    "src/recording/dto/get-recording.ts": dtoContent,
    "specs/recording.rune": rune,
  });
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — flags missing DTO file", async () => {
  const rune = `[DTO] FooDto: a, b
    a description`;
  const ctx = ctxWith(rune, [], { "specs/recording.rune": rune });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("dto/foo.ts"), true);
});

Deno.test("check — flags missing properties in existing DTO", async () => {
  const rune = `[DTO] FooDto: alpha, beta, gamma
    a description`;
  const dtoContent = `export const FooDto = z.object({ alpha: z.string() });`;
  const ctx = ctxWith(rune, ["src/recording/dto/foo.ts"], {
    "src/recording/dto/foo.ts": dtoContent,
    "specs/recording.rune": rune,
  });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("beta"), true);
  assertEquals(result?.[0].includes("gamma"), true);
});

Deno.test("check — :core modifier routes to core/dto/", async () => {
  const rune = `[DTO:core] CommonDto: a
    shared`;
  const ctx = ctxWith(rune, [], { "specs/recording.rune": rune });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.[0].includes("src/core/dto/common.ts"), true);
});

Deno.test("check — normalizes optional property suffix", async () => {
  const rune = `[DTO] FooDto: name, value?
    a description`;
  const dtoContent =
    `export const FooDto = z.object({ name: z.string(), value: z.string().optional() });`;
  const ctx = ctxWith(rune, ["src/recording/dto/foo.ts"], {
    "src/recording/dto/foo.ts": dtoContent,
    "specs/recording.rune": rune,
  });
  // "value?" normalizes to "value"; both "name" and "value" appear in content
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — normalizes array property suffix", async () => {
  const rune = `[DTO] SearchDto: url(s)
    a description`;
  const dtoContent =
    `export const SearchDto = z.object({ urls: z.array(z.string()) });`;
  const ctx = ctxWith(rune, ["src/recording/dto/search.ts"], {
    "src/recording/dto/search.ts": dtoContent,
    "specs/recording.rune": rune,
  });
  // "url(s)" normalizes to "urls"; appears in content
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — strips Dto suffix from filename", async () => {
  const rune = `[DTO] GetRecordingDto: a
    desc`;
  const ctx = ctxWith(rune, [], { "specs/recording.rune": rune });
  const result = await check("specs/recording.rune", "rune", ctx);
  // "GetRecordingDto" → "get-recording.ts" (Dto stripped)
  assertEquals(result?.[0].includes("/dto/get-recording.ts"), true);
});
