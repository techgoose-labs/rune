import { assert, assertEquals } from "#std/assert";
import { join } from "#std/path";
import { loadCoreSrvs, resolveRoot } from "./spec-root.ts";
import { CORE_SPEC_REL } from "@rune/domain/business/rune-bindings/mod.ts";

const CORE = `[MOD] core
[SRV] (SIDECAR)db: DB_URL
    the datastore
    @docs https://docs.example.com/db
[SRV] (HTTP)ex: EX_BASE_URL
    external http
    @docs https://example.com/api`;

async function withRoot(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      await Deno.mkdir(join(abs, ".."), { recursive: true });
      await Deno.writeTextFile(abs, content);
    }
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("loadCoreSrvs — loads the shared [SRV] set from core.rune", async () => {
  await withRoot(
    { [CORE_SPEC_REL]: CORE, "src/tasks/tasks.rune": "[MOD] tasks" },
    async (root) => {
      const srvs = await loadCoreSrvs(root, join(root, "src/tasks/tasks.rune"));
      assert(srvs !== undefined);
      assertEquals([...srvs!.keys()].sort(), ["db", "ex"]);
      assertEquals(srvs!.get("db")!.transport, "SIDECAR");
      assertEquals(srvs!.get("db")!.envVars, ["DB_URL"]);
    },
  );
});

Deno.test("loadCoreSrvs — returns undefined when target IS core.rune (no self-merge)", async () => {
  await withRoot({ [CORE_SPEC_REL]: CORE }, async (root) => {
    const srvs = await loadCoreSrvs(root, join(root, CORE_SPEC_REL));
    assertEquals(srvs, undefined);
  });
});

Deno.test("loadCoreSrvs — returns undefined when no core spec exists", async () => {
  await withRoot({ "src/tasks/tasks.rune": "[MOD] tasks" }, async (root) => {
    const srvs = await loadCoreSrvs(root, join(root, "src/tasks/tasks.rune"));
    assertEquals(srvs, undefined);
  });
});

Deno.test("loadCoreSrvs — a draft core (core.in-prog.rune) still supplies services", async () => {
  // Core is infrastructure: marking it in-prog must not strip a module's
  // boundary services, so the draft variant resolves like a finalized core.
  await withRoot(
    { "spec/core.in-prog.rune": CORE, "spec/tasks.rune": "[MOD] tasks" },
    async (root) => {
      const srvs = await loadCoreSrvs(root, join(root, "spec/tasks.rune"));
      assert(srvs !== undefined);
      assertEquals([...srvs!.keys()].sort(), ["db", "ex"]);
    },
  );
});

Deno.test("resolveRoot — root is the dir above an outermost src/<module>/", () => {
  assertEquals(resolveRoot("/p/src/tasks/tasks.rune"), "/p");
  assertEquals(resolveRoot("/p/todos.rune"), "/p");
});

Deno.test("resolveRoot — a singular spec/ folder resolves to the server/ codegen root (staging layout)", () => {
  // spec/ is the SHARED STAGING area at the git root; the keep codegen root is the
  // sibling server/, so sync moves the spec into server/src/<module>/.
  assertEquals(resolveRoot("/p/spec/tasks.rune"), "/p/server");
  assertEquals(resolveRoot("/p/spec/core.rune"), "/p/server");
  // Plural specs/ is the legacy STAGING convention (sync moves the spec into
  // src/<module>/), so it is NOT treated as a root — it resolves to itself.
  assertEquals(resolveRoot("/p/specs/tasks.rune"), "/p/specs");
});

Deno.test("resolveRoot — the canonical spec/runes/ staging dir resolves to the server/ codegen root", () => {
  // spec/runes/ sits beside spec/misc/ and spec/ui/ under one shared spec/ at the
  // git root; the keep codegen root is the sibling server/, so sync lands code in
  // server/src/<module>/. A spec already moved into server/src/<m>/ resolves back
  // to that same server/ (the dir above its src/), so staging + re-sync agree.
  assertEquals(resolveRoot("/p/spec/runes/tasks.rune"), "/p/server");
  assertEquals(resolveRoot("/p/spec/runes/core.rune"), "/p/server");
  assertEquals(resolveRoot("/p/server/src/tasks/tasks.rune"), "/p/server");
});

Deno.test("loadCoreSrvs — finds the core spec in a spec/ folder layout", async () => {
  await withRoot(
    { "spec/core.rune": CORE, "spec/tasks.rune": "[MOD] tasks" },
    async (root) => {
      const srvs = await loadCoreSrvs(root, join(root, "spec/tasks.rune"));
      assert(srvs !== undefined);
      assertEquals([...srvs!.keys()].sort(), ["db", "ex"]);
    },
  );
});

Deno.test("loadCoreSrvs — finds the core spec in the canonical spec/runes/ staging dir", async () => {
  await withRoot(
    { "spec/runes/core.rune": CORE, "spec/runes/tasks.rune": "[MOD] tasks" },
    async (root) => {
      const srvs = await loadCoreSrvs(
        root,
        join(root, "spec/runes/tasks.rune"),
      );
      assert(srvs !== undefined);
      assertEquals([...srvs!.keys()].sort(), ["db", "ex"]);
    },
  );
});
