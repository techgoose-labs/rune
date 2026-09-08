import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

function ctxWith(
  rune: string,
  files: string[],
  dirs: string[] = [],
): PipelineContext {
  return {
    targetDir: "/tmp",
    files,
    dirs,
    getFileContent: async () => rune,
    getImports: async () => [],
    lsp: null,
  };
}

Deno.test("check — skips non-rune files", async () => {
  const ctx = ctxWith("", []);
  assertEquals(await check("src/foo/mod.ts", "ts", ctx), null);
});

Deno.test("check — skips rune files outside spec conventions", async () => {
  const rune = `[MOD] foo
[REQ] foo.bar(InDto): OutDto
    a::b(c): d`;
  const ctx = ctxWith(rune, []);
  assertEquals(await check("rune/docs/example.rune", "rune", ctx), null);
});

Deno.test("check — passes when business feature exists", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    id::create(name): id`;
  const ctx = ctxWith(rune, [
    "src/recording/domain/business/id/mod.ts",
    "src/recording/domain/business/id/test.ts",
  ]);
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — flags missing business feature mod.ts", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    id::create(name): id`;
  const ctx = ctxWith(rune, [
    "src/recording/domain/business/id/test.ts",
  ]);
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("/business/id/mod.ts"), true);
});

Deno.test("check — collects nouns across multiple REQs", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    id::create(name): id


[REQ] recording.get(InDto): OutDto
    metadata::load(id): metadata`;
  const ctx = ctxWith(rune, []);
  const result = await check("specs/recording.rune", "rune", ctx);
  // 2 nouns × 2 expected files each = 4 violations
  assertEquals(result?.length, 4);
});

Deno.test("check — kebab-cases multi-word nouns", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    recordingMetadata::load(id): meta`;
  const ctx = ctxWith(rune, []);
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.[0].includes("/business/recording-metadata/"), true);
});

Deno.test("check — for [PLY] noun, only requires folder (no mod.ts)", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    [PLY] provider.getRecording(id): data
        [CSE] genie
        ex:provider.search(id): SearchDto`;
  const ctx = ctxWith(rune, [], [
    "src/recording/domain/business/provider",
  ]);
  // Folder exists; even though no mod.ts at that level (poly uses base/), no violation.
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — for [PLY] noun, missing folder is flagged", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    [PLY] provider.getRecording(id): data
        [CSE] genie
        ex:provider.search(id): SearchDto`;
  const ctx = ctxWith(rune, [], []);
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("[PLY]"), true);
  assertEquals(result?.[0].includes("/business/provider/"), true);
});

Deno.test("check — collects nouns from inside [PLY] cases", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    [PLY] provider.getRecording(id): data
        [CSE] genie
        helper::transform(x): y`;
  const ctx = ctxWith(rune, [], [
    "src/recording/domain/business/provider",
  ]);
  const result = await check("specs/recording.rune", "rune", ctx);
  // helper is an untagged step inside a CSE → must have mod.ts + test.ts
  assertEquals(result?.length, 2);
  assertEquals(
    result?.some((v) => v.includes("/business/helper/mod.ts")),
    true,
  );
});

Deno.test("check — boundary steps are not business features", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    db:metadata.set(id, x): void`;
  const ctx = ctxWith(rune, []);
  // No untagged steps, no [PLY] — no business features required.
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});
