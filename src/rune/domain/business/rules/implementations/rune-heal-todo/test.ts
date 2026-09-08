import { assertEquals } from "#std/assert";
import { check, isStrict } from "./mod.ts";
import type { PipelineContext } from "@core/dto/types.ts";

function ctxWith(contents: Record<string, string>): PipelineContext {
  return {
    targetDir: "/tmp",
    files: Object.keys(contents),
    dirs: [],
    getFileContent: (rel) => Promise.resolve(contents[rel] ?? ""),
    getImports: () => Promise.resolve([]),
    lsp: null,
  };
}

const WITH_TODO = JSON.stringify({
  v: 1,
  slugs: {
    "not-enabled": [{ kind: "run-step", match: "/enable/i", why: "real" }],
    "quota-exceeded": [{
      kind: "note",
      label: "TODO",
      why: "TODO",
      todo: true,
    }],
    "stale-cursor": [{ kind: "note", label: "TODO", todo: true }],
  },
});

const FULLY_ENRICHED = JSON.stringify({
  v: 1,
  slugs: {
    "not-enabled": [{ kind: "run-step", match: "/enable/i", why: "real" }],
  },
});

// Run a body with RUNE_LINT_STRICT forced on/off, restoring the prior value.
async function withStrict(on: boolean, fn: () => Promise<void>): Promise<void> {
  const prev = Deno.env.get("RUNE_LINT_STRICT");
  if (on) Deno.env.set("RUNE_LINT_STRICT", "1");
  else Deno.env.delete("RUNE_LINT_STRICT");
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("RUNE_LINT_STRICT");
    else Deno.env.set("RUNE_LINT_STRICT", prev);
  }
}

Deno.test("rune-heal-todo — silent by default (non-strict), even with todo entries", async () => {
  await withStrict(false, async () => {
    const ctx = ctxWith({ "fixtures/heal-rules.json": WITH_TODO });
    assertEquals(await check("fixtures/heal-rules.json", "json", ctx), null);
  });
});

Deno.test("rune-heal-todo — under strict, flags every todo:true slug (sorted)", async () => {
  await withStrict(true, async () => {
    const ctx = ctxWith({ "fixtures/heal-rules.json": WITH_TODO });
    const v = await check("fixtures/heal-rules.json", "json", ctx);
    assertEquals(v?.length, 2);
    // sorted; the fully-enriched not-enabled is NOT flagged
    assertEquals(v?.[0].includes('"quota-exceeded"'), true);
    assertEquals(v?.[1].includes('"stale-cursor"'), true);
  });
});

Deno.test("rune-heal-todo — under strict, a fully-enriched file is clean", async () => {
  await withStrict(true, async () => {
    const ctx = ctxWith({ "fixtures/heal-rules.json": FULLY_ENRICHED });
    assertEquals(await check("fixtures/heal-rules.json", "json", ctx), null);
  });
});

Deno.test("rune-heal-todo — honors KEEP_FIXTURES_DIR location (matches by basename)", async () => {
  await withStrict(true, async () => {
    const ctx = ctxWith({ "keep-fixtures/heal-rules.json": WITH_TODO });
    const v = await check("keep-fixtures/heal-rules.json", "json", ctx);
    assertEquals(v?.length, 2);
  });
});

Deno.test("rune-heal-todo — ignores non-heal-rules json and non-json targets", async () => {
  await withStrict(true, async () => {
    const ctx = ctxWith({
      "fixtures/cake.json": WITH_TODO,
      "deno.json": WITH_TODO,
    });
    assertEquals(await check("fixtures/cake.json", "json", ctx), null);
    assertEquals(await check("deno.json", "json", ctx), null);
    assertEquals(await check("fixtures/heal-rules.json", "ts", ctx), null);
  });
});

Deno.test("rune-heal-todo — malformed JSON is not this rule's concern", async () => {
  await withStrict(true, async () => {
    const ctx = ctxWith({ "fixtures/heal-rules.json": "{ not json ]" });
    assertEquals(await check("fixtures/heal-rules.json", "json", ctx), null);
  });
});

Deno.test("isStrict — truthy/falsey env handling", () => {
  const prev = Deno.env.get("RUNE_LINT_STRICT");
  try {
    for (const v of ["1", "true", "yes", "on"]) {
      Deno.env.set("RUNE_LINT_STRICT", v);
      assertEquals(isStrict(), true, `"${v}" should be strict`);
    }
    for (const v of ["0", "false", ""]) {
      Deno.env.set("RUNE_LINT_STRICT", v);
      assertEquals(isStrict(), false, `"${v}" should not be strict`);
    }
    Deno.env.delete("RUNE_LINT_STRICT");
    assertEquals(isStrict(), false);
  } finally {
    if (prev === undefined) Deno.env.delete("RUNE_LINT_STRICT");
    else Deno.env.set("RUNE_LINT_STRICT", prev);
  }
});
