import { assertEquals } from "#std/assert";
import { check } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

function makeCtx(
  rune: string,
  files: string[],
  dirs: string[],
): PipelineContext {
  // Always include the rune file in files for predictions to load.
  return {
    targetDir: "/tmp",
    files: ["specs/recording.rune", ...files],
    dirs,
    getFileContent: async (rel) => {
      if (rel === "specs/recording.rune") return rune;
      return "";
    },
    getImports: async () => [],
    lsp: null,
  };
}

const RUNE = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    id::create(name): id
    db:metadata.set(id, x): void

[DTO] InDto: a
    desc

[TYP] url: string
    desc`;

Deno.test("check — predicted folder passes", async () => {
  const ctx = makeCtx(RUNE, [], [
    "src/recording/domain/coordinators/recording-set",
  ]);
  assertEquals(
    await check(
      "src/recording/domain/coordinators/recording-set",
      "folder",
      ctx,
    ),
    null,
  );
});

Deno.test("check — orphan coordinator folder is flagged", async () => {
  const ctx = makeCtx(RUNE, [], [
    "src/recording/domain/coordinators/something-else",
  ]);
  const result = await check(
    "src/recording/domain/coordinators/something-else",
    "folder",
    ctx,
  );
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("Orphan"), true);
  assertEquals(result?.[0].includes("coordinator"), true);
});

Deno.test("check — orphan business feature folder is flagged", async () => {
  const ctx = makeCtx(RUNE, [], ["src/recording/domain/business/orphan"]);
  const result = await check(
    "src/recording/domain/business/orphan",
    "folder",
    ctx,
  );
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("business-feature"), true);
});

Deno.test("check — orphan adapter folder is flagged", async () => {
  const ctx = makeCtx(RUNE, [], ["src/recording/domain/data/orphan"]);
  const result = await check("src/recording/domain/data/orphan", "folder", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("adapter"), true);
});

Deno.test("check — orphan dto file is flagged", async () => {
  const ctx = makeCtx(RUNE, ["src/recording/dto/orphan.ts"], []);
  const result = await check("src/recording/dto/orphan.ts", "ts", ctx);
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].includes("dto"), true);
});

Deno.test("check — predicted dto file passes", async () => {
  // [DTO] InDto: a → file at src/recording/dto/in.ts
  const ctx = makeCtx(RUNE, ["src/recording/dto/in.ts"], []);
  assertEquals(await check("src/recording/dto/in.ts", "ts", ctx), null);
});

Deno.test("check — predicted typ file passes", async () => {
  const ctx = makeCtx(RUNE, ["src/recording/dto/url.ts"], []);
  assertEquals(await check("src/recording/dto/url.ts", "ts", ctx), null);
});

Deno.test("check — typ colliding with a same-dir DTO stem passes at -type", async () => {
  // [TYP] cap + [DTO] CapDto: cap collide on the `cap` stem, so the generator
  // (and rune-typ-shape) write/expect the TYP at `cap-type.ts`. The orphan rule
  // must predict it the same way — not flag the real file.
  const rune = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    id::create(name): id

[DTO] CapDto: cap

[TYP] cap: number
    desc`;
  const ctx = makeCtx(rune, ["src/recording/dto/cap-type.ts"], []);
  assertEquals(await check("src/recording/dto/cap-type.ts", "ts", ctx), null);
});

Deno.test("check — files outside rune-managed slots are skipped", async () => {
  const ctx = makeCtx(RUNE, ["src/recording/domain/business/id/mod.ts"], []);
  // This is a file inside a managed folder but not the folder itself — rule skips it.
  assertEquals(
    await check("src/recording/domain/business/id/mod.ts", "ts", ctx),
    null,
  );
});

Deno.test("check — modules with no rune are skipped", async () => {
  const ctx = makeCtx(RUNE, [], ["src/other-module/domain/business/x"]);
  // other-module has no rune file → not rune-managed → no orphan check
  assertEquals(
    await check("src/other-module/domain/business/x", "folder", ctx),
    null,
  );
});
