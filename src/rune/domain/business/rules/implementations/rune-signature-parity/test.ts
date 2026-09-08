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

const RUNE = `[MOD] recording

[REQ] recording.set(GetRecordingDto): IdDto
    id::create(name): id`;

Deno.test("check — passes when coordinator file references both DTOs", async () => {
  const code = `import { GetRecordingDto } from "@/core/dto/get-recording.ts";
import { IdDto } from "@/core/dto/id.ts";
export async function set(input: GetRecordingDto): Promise<IdDto> { return new IdDto(); }`;
  const ctx = ctxWith(RUNE, [
    "src/recording/domain/coordinators/recording-set/mod.ts",
  ], {
    "src/recording/domain/coordinators/recording-set/mod.ts": code,
    "specs/recording.rune": RUNE,
  });
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — flags missing input DTO reference", async () => {
  const code =
    `export async function set(input: WrongDto): Promise<IdDto> { return new IdDto(); }`;
  const ctx = ctxWith(RUNE, [
    "src/recording/domain/coordinators/recording-set/mod.ts",
  ], {
    "src/recording/domain/coordinators/recording-set/mod.ts": code,
    "specs/recording.rune": RUNE,
  });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("GetRecordingDto"), true);
});

Deno.test("check — flags missing output DTO reference", async () => {
  const code =
    `export async function set(input: GetRecordingDto): Promise<unknown> { return null; }`;
  const ctx = ctxWith(RUNE, [
    "src/recording/domain/coordinators/recording-set/mod.ts",
  ], {
    "src/recording/domain/coordinators/recording-set/mod.ts": code,
    "specs/recording.rune": RUNE,
  });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("IdDto"), true);
});

Deno.test("check — skips coordinators that don't exist", async () => {
  const ctx = ctxWith(RUNE, [], { "specs/recording.rune": RUNE });
  // No coordinator file → presence rule's job, not this rule's
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — checks entrypoint signatures too", async () => {
  const rune = `[MOD] recording

[ENT] http.postRecording(GetRecordingDto): IdDto`;
  const code =
    `export async function postRecording(input: WrongDto): Promise<unknown> { return null; }`;
  const ctx = ctxWith(rune, [
    "src/recording/entrypoints/http/mod.ts",
  ], {
    "src/recording/entrypoints/http/mod.ts": code,
    "specs/recording.rune": rune,
  });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 2);
  assertEquals(result?.some((v) => v.includes("[ENT]")), true);
});

Deno.test("check — skips inline DTO inputs", async () => {
  const rune = `[MOD] recording

[REQ] recording.set({a:b, c:d}): IdDto
    id::create(name): id`;
  const code =
    `export async function set(input: { a: B; c: D }): Promise<IdDto> { return new IdDto(); }`;
  const ctx = ctxWith(rune, [
    "src/recording/domain/coordinators/recording-set/mod.ts",
  ], {
    "src/recording/domain/coordinators/recording-set/mod.ts": code,
    "specs/recording.rune": rune,
  });
  // Inline DTO inputs are skipped; only IdDto is checked, and it's present.
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});
