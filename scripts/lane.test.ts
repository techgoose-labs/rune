// REQ-017 — the four gate tasks are declared and every lane reaches only
// files of its own kind.
import { assert, assertEquals } from "#std/assert";
import { kindOf, plan, ROOT } from "./lane.ts";

Deno.test("REQ-017: a test's kind is its filename, the gate's rule", () => {
  assertEquals(kindOf("src/rune/domain/data/lsp/smk.test.ts"), "smoke");
  assertEquals(kindOf("keep/src/foundation/x/ws.e2e.test.ts"), "e2e");
  assertEquals(
    kindOf("e2e/cake/src/cake/domain/business/batter/test.ts"),
    "e2e",
  );
  assertEquals(
    kindOf("src/rune/domain/coordinators/pipeline/int.test.ts"),
    "int",
  );
  assertEquals(kindOf("keep/src/bootstrap/parity.int.test.ts"), "int");
  assertEquals(kindOf("src/rune/entrypoints/check/test.ts"), "unit");
  assertEquals(kindOf("src/rune/entrypoints/init/vectors.test.ts"), "unit");
});

Deno.test("REQ-017: the unit and int plans are non-empty and pure", async () => {
  const unit = await plan("unit");
  const int = await plan("int");
  assert(unit.length > 0 && int.length > 0);
  assertEquals(unit.filter((p) => kindOf(p) !== "unit"), []);
  assertEquals(int.filter((p) => kindOf(p) !== "int"), []);
  assert(unit.includes("scripts/lane.test.ts"));
  assert(int.includes("keep/src/bootstrap/parity.int.test.ts"));
});

Deno.test("REQ-017: deno.json declares test:unit, test:int, test:e2e and serve", () => {
  const tasks = JSON.parse(Deno.readTextFileSync(`${ROOT}/deno.json`)).tasks;
  for (const t of ["test:unit", "test:int", "test:e2e", "serve"]) {
    assert(t in tasks, `missing task ${t}`);
  }
});
