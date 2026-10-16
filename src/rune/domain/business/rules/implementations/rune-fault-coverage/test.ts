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

[REQ] recording.set(InDto): OutDto
    id::create(name): id
      ! invalid-id
    db:metadata.set(id, x): void
      ! timed-out=504 network-error`;

Deno.test("check — passes when all fault tests exist", async () => {
  const intTest = `Deno.test("invalid-id", () => {});
Deno.test("timed-out", () => {});
Deno.test("network-error", () => {});`;
  const idTest = `Deno.test("invalid-id", () => {});`;
  const adapterTest = `Deno.test("timed-out", () => {});
Deno.test("network-error", () => {});`;
  const ctx = ctxWith(RUNE, [
    "src/recording/domain/coordinators/recording-set/int.test.ts",
    "src/recording/domain/business/id/test.ts",
    "src/recording/domain/data/metadata/smk.test.ts",
  ], {
    "src/recording/domain/coordinators/recording-set/int.test.ts": intTest,
    "src/recording/domain/business/id/test.ts": idTest,
    "src/recording/domain/data/metadata/smk.test.ts": adapterTest,
    "specs/recording.rune": RUNE,
  });
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — flags missing fault test in int.test.ts", async () => {
  const intTest = `Deno.test("invalid-id", () => {});`; // missing timed-out + network-error
  const ctx = ctxWith(RUNE, [
    "src/recording/domain/coordinators/recording-set/int.test.ts",
  ], {
    "src/recording/domain/coordinators/recording-set/int.test.ts": intTest,
    "specs/recording.rune": RUNE,
  });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 2);
  assertEquals(result?.some((v) => v.includes("timed-out")), true);
  assertEquals(result?.some((v) => v.includes("network-error")), true);
});

Deno.test("check — flags missing fault test in business test.ts", async () => {
  const intTest = `Deno.test("invalid-id", () => {});
Deno.test("timed-out", () => {});
Deno.test("network-error", () => {});`;
  const idTest = ``; // missing invalid-id
  const adapterTest = `Deno.test("timed-out", () => {});
Deno.test("network-error", () => {});`;
  const ctx = ctxWith(RUNE, [
    "src/recording/domain/coordinators/recording-set/int.test.ts",
    "src/recording/domain/business/id/test.ts",
    "src/recording/domain/data/metadata/smk.test.ts",
  ], {
    "src/recording/domain/coordinators/recording-set/int.test.ts": intTest,
    "src/recording/domain/business/id/test.ts": idTest,
    "src/recording/domain/data/metadata/smk.test.ts": adapterTest,
    "specs/recording.rune": RUNE,
  });
  const result = await check("specs/recording.rune", "rune", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("invalid-id"), true);
  assertEquals(result?.[0].includes("/business/id/test.ts"), true);
});

Deno.test("check — accepts single, double, and backtick quoted test names", async () => {
  const rune = `[MOD] m
[REQ] m.x(InDto): OutDto
    a::b(c): d
      foo`;
  const test = `Deno.test('foo', () => {});`;
  const ctx = ctxWith(rune, [
    "src/m/domain/coordinators/m-x/int.test.ts",
    "src/m/domain/business/a/test.ts",
  ], {
    "src/m/domain/coordinators/m-x/int.test.ts": test,
    "src/m/domain/business/a/test.ts": test,
    "specs/m.rune": rune,
  });
  assertEquals(await check("specs/m.rune", "rune", ctx), null);
});

Deno.test("check — skips files that don't exist (presence rules handle that)", async () => {
  const ctx = ctxWith(RUNE, [], { "specs/recording.rune": RUNE });
  // No test files exist — but fault-coverage doesn't fire (presence rules will).
  assertEquals(await check("specs/recording.rune", "rune", ctx), null);
});

Deno.test("check — collects faults from inside [PLY] cases", async () => {
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    [PLY] provider.getRecording(id): data
        [CSE] genie
        ex:provider.search(id): SearchDto
          ! not-found timed-out=504`;
  const intTest = ``; // missing both faults
  const adapterTest = ``; // missing both faults
  const ctx = ctxWith(rune, [
    "src/recording/domain/coordinators/recording-set/int.test.ts",
    "src/recording/domain/data/provider/smk.test.ts",
  ], {
    "src/recording/domain/coordinators/recording-set/int.test.ts": intTest,
    "src/recording/domain/data/provider/smk.test.ts": adapterTest,
    "specs/recording.rune": rune,
  });
  const result = await check("specs/recording.rune", "rune", ctx);
  // 2 faults in int.test + 2 faults in adapter smk.test = 4 violations
  assertEquals(result?.length, 4);
});
