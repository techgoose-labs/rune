import { assert, assertEquals, assertStringIncludes } from "#std/assert";
import { join } from "#std/path";
import {
  ensureBootstrap,
  ensureHealRules,
  ensureImportMap,
  parseSyncArgs,
  renderAppRegistry,
  renderMain,
  runSync,
  scanSurfaceModules,
} from "./mod.ts";

async function tempProject(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "rune-sync-test-" });
}

async function addSurface(
  root: string,
  module: string,
  surface: string,
  exportName?: string,
): Promise<void> {
  const dir = join(root, "src", module, "entrypoints", surface);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "mod.ts"),
    `export const ${exportName ?? surface + "Module"} = {};\n`,
  );
}

Deno.test("scanSurfaceModules — finds surfaces across modules, sorted", async () => {
  const root = await tempProject();
  try {
    await addSurface(root, "tasks", "http");
    await addSurface(root, "checkout", "http");
    await addSurface(root, "checkout", "cli");
    const found = await scanSurfaceModules(root);
    assertEquals(
      found.map((s) => `${s.module}/${s.surface}:${s.alias}`),
      [
        "checkout/cli:checkoutCliModule",
        "checkout/http:checkoutHttpModule",
        "tasks/http:tasksHttpModule",
      ],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanSurfaceModules — reads a diverged export name from the file", async () => {
  const root = await tempProject();
  try {
    await addSurface(root, "checkout", "http", "storefrontModule");
    const [s] = await scanSurfaceModules(root);
    assertEquals(s.exportName, "storefrontModule");
    assertEquals(s.alias, "checkoutHttpModule");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("renderAppRegistry — imports each surface and exports the array", () => {
  const out = renderAppRegistry([
    {
      module: "checkout",
      surface: "http",
      exportName: "httpModule",
      alias: "checkoutHttpModule",
    },
  ]);
  assertStringIncludes(
    out,
    'import { httpModule as checkoutHttpModule } from "@/src/checkout/entrypoints/http/mod.ts";',
  );
  assertStringIncludes(
    out,
    "export const modules = [\n  checkoutHttpModule,\n];",
  );
});

Deno.test("renderMain — wires the registry into bootstrapServer", () => {
  const out = renderMain("shop");
  assertStringIncludes(
    out,
    'import { bootstrapServer } from "@techgoose-labs/rune";',
  );
  assertStringIncludes(
    out,
    'import { modules } from "@/bootstrap/modules.ts";',
  );
  assertStringIncludes(
    out,
    'await bootstrapServer("shop", modules, { port: config.port });',
  );
});

Deno.test("ensureBootstrap — creates app.ts + main.ts, then add/remove updates only app.ts", async () => {
  const root = await tempProject();
  const ioErrors: string[] = [];
  try {
    await addSurface(root, "checkout", "http");
    let notes = await ensureBootstrap(root, ioErrors);
    assertEquals(notes.length, 3); // created modules.ts + config.ts + mod.ts
    const main1 = await Deno.readTextFile(join(root, "bootstrap", "mod.ts"));

    // Dev customizes main.ts; a new module appears.
    await Deno.writeTextFile(
      join(root, "bootstrap", "mod.ts"),
      main1 + "// custom\n",
    );
    await addSurface(root, "tasks", "http");
    notes = await ensureBootstrap(root, ioErrors);
    assertEquals(notes, [
      "updated bootstrap/modules.ts (module registry: 2 surface module(s))",
    ]);
    assertStringIncludes(
      await Deno.readTextFile(join(root, "bootstrap", "modules.ts")),
      "tasksHttpModule",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(root, "bootstrap", "mod.ts")),
      "// custom",
    );

    // The module's rune goes away (its tree is deleted) → registry drops it.
    await Deno.remove(join(root, "src", "tasks"), { recursive: true });
    notes = await ensureBootstrap(root, ioErrors);
    assertEquals(notes, [
      "updated bootstrap/modules.ts (module registry: 1 surface module(s))",
    ]);
    assertEquals(
      (await Deno.readTextFile(join(root, "bootstrap", "modules.ts"))).includes(
        "tasksHttpModule",
      ),
      false,
    );
    assertEquals(ioErrors, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureBootstrap — no surfaces and no registry → generates nothing", async () => {
  const root = await tempProject();
  try {
    const notes = await ensureBootstrap(root, []);
    assertEquals(notes, []);
    assertEquals(await exists(join(root, "bootstrap", "mod.ts")), false);
    assertEquals(await exists(join(root, "bootstrap", "modules.ts")), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureBootstrap — a hand-written modules.ts is never clobbered", async () => {
  const root = await tempProject();
  try {
    await addSurface(root, "checkout", "http");
    await Deno.mkdir(join(root, "bootstrap"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "bootstrap", "modules.ts"),
      "// mine\n",
    );
    const notes = await ensureBootstrap(root, []);
    assertEquals(notes.length, 1);
    assertStringIncludes(notes[0], "left untouched");
    assertEquals(
      await Deno.readTextFile(join(root, "bootstrap", "modules.ts")),
      "// mine\n",
    );
    assertEquals(await exists(join(root, "bootstrap", "mod.ts")), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---- ghost stubs (bootstrap/stubs.ts) ----------------------------------------

// Consumes [TYP:ext] memberId that nothing in the module produces.
const CHECKOUT_RUNE = `[MOD] checkout

[ENT] http.start(StartDto): TicketDto

[DTO] StartDto: item, memberId
    what to buy and who buys it
[DTO] TicketDto: ticketId
    the opened ticket

[TYP:ext] memberId: string
    minted by the members module
[TYP] item: string
    a thing to buy
[TYP] ticketId: string
    a ticket id
`;

// Produces memberId — the real producer that evaporates the ghost.
const MEMBERS_RUNE = `[MOD] members

[ENT] http.join(JoinDto): MemberDto

[DTO] JoinDto: alias
    who joins
[DTO] MemberDto: memberId
    the minted member

[TYP] alias: string
    a display name
[TYP] memberId: string
    a member id
`;

async function addSpec(
  root: string,
  module: string,
  text: string,
): Promise<void> {
  const dir = join(root, "src", module);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, `${module}.rune`), text);
}

Deno.test("ensureBootstrap — ghost stubs created for unfulfilled ext inputs, gated in the registry", async () => {
  const root = await tempProject();
  try {
    await addSurface(root, "checkout", "http");
    await addSpec(root, "checkout", CHECKOUT_RUNE);
    const notes = await ensureBootstrap(root, []);
    assertEquals(
      notes.some((n) => n.includes("created bootstrap/stubs.ts")),
      true,
    );
    const stubs = await Deno.readTextFile(join(root, "bootstrap", "stubs.ts"));
    assertEquals(
      stubs.startsWith("// Generated by rune sync — DO NOT EDIT."),
      true,
    );
    assertStringIncludes(stubs, 'path: "mint-member-id"');
    assertStringIncludes(stubs, "stub: true");
    const registry = await Deno.readTextFile(
      join(root, "bootstrap", "modules.ts"),
    );
    assertStringIncludes(
      registry,
      'import { stubsModule } from "@/bootstrap/stubs.ts";',
    );
    assertStringIncludes(
      registry,
      '...(Deno.env.get("DENO_ENV") === "production" ? [] : [stubsModule]),',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureBootstrap — ghost stubs evaporate when a real producer module appears", async () => {
  const root = await tempProject();
  try {
    await addSurface(root, "checkout", "http");
    await addSpec(root, "checkout", CHECKOUT_RUNE);
    await ensureBootstrap(root, []);
    assertEquals(await exists(join(root, "bootstrap", "stubs.ts")), true);

    await addSurface(root, "members", "http");
    await addSpec(root, "members", MEMBERS_RUNE);
    const notes = await ensureBootstrap(root, []);
    assertEquals(
      notes.some((n) => n.includes("removed bootstrap/stubs.ts")),
      true,
    );
    assertEquals(await exists(join(root, "bootstrap", "stubs.ts")), false);
    const registry = await Deno.readTextFile(
      join(root, "bootstrap", "modules.ts"),
    );
    assertEquals(registry.includes("stubsModule"), false);
    assertEquals(registry.includes("DENO_ENV"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureBootstrap — a real module named 'stubs' disables the ghost", async () => {
  const root = await tempProject();
  try {
    await addSurface(root, "checkout", "http");
    await addSpec(root, "checkout", CHECKOUT_RUNE);
    await addSurface(root, "stubs", "http");
    const notes = await ensureBootstrap(root, []);
    assertEquals(
      notes.some((n) =>
        n.includes("module 'stubs' exists — ghost stubs disabled")
      ),
      true,
    );
    assertEquals(await exists(join(root, "bootstrap", "stubs.ts")), false);
    const registry = await Deno.readTextFile(
      join(root, "bootstrap", "modules.ts"),
    );
    assertStringIncludes(registry, "stubsHttpModule"); // the real module, scanned normally
    assertEquals(registry.includes("@/bootstrap/stubs.ts"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureBootstrap — a hand-written bootstrap/stubs.ts is never clobbered or deleted", async () => {
  const root = await tempProject();
  try {
    await addSurface(root, "checkout", "http");
    await addSpec(root, "checkout", CHECKOUT_RUNE);
    await Deno.mkdir(join(root, "bootstrap"), { recursive: true });
    await Deno.writeTextFile(join(root, "bootstrap", "stubs.ts"), "// mine\n");
    const notes = await ensureBootstrap(root, []);
    assertEquals(
      notes.some((n) =>
        n.includes(
          "bootstrap/stubs.ts exists but was not generated by rune sync",
        )
      ),
      true,
    );
    assertEquals(
      await Deno.readTextFile(join(root, "bootstrap", "stubs.ts")),
      "// mine\n",
    );
    const registry = await Deno.readTextFile(
      join(root, "bootstrap", "modules.ts"),
    );
    assertEquals(registry.includes("stubsModule"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureBootstrap — ghost stubs refresh is byte-identical-skip and tracks new fields", async () => {
  const root = await tempProject();
  try {
    await addSurface(root, "checkout", "http");
    await addSpec(root, "checkout", CHECKOUT_RUNE);
    await ensureBootstrap(root, []);
    // Re-run with no changes: no stub note (byte-identical skip).
    const notes = await ensureBootstrap(root, []);
    assertEquals(notes.some((n) => n.includes("bootstrap/stubs.ts")), false);
    // A second ext field appears → the ghost is refreshed.
    await addSpec(
      root,
      "checkout",
      CHECKOUT_RUNE.replace(
        "StartDto: item, memberId",
        "StartDto: item, memberId, tenantKey",
      ) +
        "[TYP:ext] tenantKey: string\n    issued by ops\n",
    );
    const notes2 = await ensureBootstrap(root, []);
    assertEquals(
      notes2.some((n) => n.includes("updated bootstrap/stubs.ts")),
      true,
    );
    const stubs = await Deno.readTextFile(join(root, "bootstrap", "stubs.ts"));
    assertStringIncludes(stubs, 'path: "mint-tenant-key"');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---- ensureHealRules --------------------------------------------------------

// A keep-app spec with two endpoints: `enable` is the precondition, `write`
// declares the `not-enabled` (precondition) + `quota-exceeded` (no-signal) slugs.
const TABLES_SPEC = `[MOD] tables

[ENT] http.enable(EnableDto): TableDto
[ENT] http.write(WriteDto): RowDto

[REQ] table.enable(EnableDto): TableDto
    [NEW] table
    db:table.save(TableDto): void
      timeout
    table.toDto(): TableDto

[REQ] table.write(WriteDto): RowDto
    [NEW] row
    db:row.append(WriteDto): RowDto
      not-enabled
      quota-exceeded
    row.toDto(): RowDto

[DTO] EnableDto: name
    the table to track
[DTO] TableDto: tableId
    a tracked table
[DTO] WriteDto: tableId, payload
    a row to write
[DTO] RowDto: rowId
    a written row

[TYP] name: string
    a table name
[TYP] tableId: string
    a table id
[TYP] payload: string
    row contents
[TYP] rowId: string
    a row id
`;

Deno.test("ensureHealRules — scaffolds fixtures/heal-rules.json from endpoint slugs", async () => {
  const root = await tempProject();
  try {
    await addSpec(root, "tables", TABLES_SPEC);
    const notes = await ensureHealRules(root, []);
    assertEquals(
      notes.some((n) => n.includes("created fixtures/heal-rules.json")),
      true,
    );
    // The enrichment nudge names every un-enriched (todo) slug — including the
    // run-step pre-fill, which is a heuristic guess flagged for verification.
    assertEquals(
      notes.some((n) =>
        n.includes("need enrichment") && n.includes("quota-exceeded") &&
        n.includes("not-enabled")
      ),
      true,
    );
    const rules = JSON.parse(
      await Deno.readTextFile(join(root, "fixtures", "heal-rules.json")),
    );
    assertEquals(rules.v, 1);
    // `timeout` is keep's reserved generic — excluded.
    assertEquals(Object.keys(rules.slugs).sort(), [
      "not-enabled",
      "quota-exceeded",
    ]);
    // `not-enabled` pre-fills a run-step matching the enable endpoint.
    assertEquals(rules.slugs["not-enabled"][0].kind, "run-step");
    assertEquals(rules.slugs["not-enabled"][0].match, "/enable/i");
    // `quota-exceeded` has no signal → a TODO note.
    assertEquals(rules.slugs["quota-exceeded"][0].kind, "note");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureHealRules — enrichment nudge persists on a no-op re-sync while todos remain", async () => {
  const root = await tempProject();
  try {
    await addSpec(root, "tables", TABLES_SPEC);
    await ensureHealRules(root, []); // create
    // Second sync, nothing changed — the file is not rewritten, but the standing
    // nudge must still fire (a later session inherits the debt).
    const notes = await ensureHealRules(root, []);
    assertEquals(
      notes.some((n) => n.includes("created") || n.includes("updated")),
      false,
    );
    assertEquals(
      notes.some((n) =>
        n.includes("need enrichment") && n.includes("quota-exceeded")
      ),
      true,
    );

    // Enrich BOTH entries (drop todo) → the nudge stops.
    const path = join(root, "fixtures", "heal-rules.json");
    const r = JSON.parse(await Deno.readTextFile(path));
    r.slugs["quota-exceeded"] = [{
      kind: "note",
      label: "raise the quota",
      why: "the table's write quota is exhausted",
    }];
    r.slugs["not-enabled"] = [{
      kind: "run-step",
      match: "/enable/i",
      why: "the table must be enabled first",
    }];
    await Deno.writeTextFile(path, JSON.stringify(r, null, 2) + "\n");
    const after = await ensureHealRules(root, []);
    assertEquals(after.some((n) => n.includes("need enrichment")), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureHealRules — no endpoints / no slugs → no file", async () => {
  const root = await tempProject();
  try {
    // A spec with a [REQ] but no [ENT] → no endpoint, no heal file.
    await addSpec(
      root,
      "lib",
      "[REQ] util.do(InDto): OutDto\n    [NEW] out\n    db:out.save(OutDto): void\n      boom-failure\n    out.toDto(): OutDto\n\n[DTO] InDto: x\n    in\n[DTO] OutDto: y\n    out\n\n[TYP] x: string\n    x\n[TYP] y: string\n    y\n",
    );
    const notes = await ensureHealRules(root, []);
    assertEquals(notes, []);
    assertEquals(
      await exists(join(root, "fixtures", "heal-rules.json")),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureHealRules — merge keeps human edits, appends new, reports stale", async () => {
  const root = await tempProject();
  try {
    await addSpec(root, "tables", TABLES_SPEC);
    await ensureHealRules(root, []);
    const path = join(root, "fixtures", "heal-rules.json");

    // Human curates `not-enabled` and adds a slug the spec doesn't declare.
    const curated = {
      v: 1,
      slugs: {
        "not-enabled": [{ kind: "run-step", target: "enable", why: "HUMAN" }],
        "quota-exceeded":
          JSON.parse(await Deno.readTextFile(path)).slugs["quota-exceeded"],
        "hand-added": [{ kind: "note", label: "mine" }],
      },
    };
    await Deno.writeTextFile(path, JSON.stringify(curated, null, 2) + "\n");

    // Add a new fault to the spec, re-run.
    await addSpec(
      root,
      "tables",
      TABLES_SPEC.replace(
        "      quota-exceeded\n",
        "      quota-exceeded\n      payload-too-large\n",
      ),
    );
    const notes = await ensureHealRules(root, []);

    const rules = JSON.parse(await Deno.readTextFile(path));
    // human edit preserved verbatim
    assertEquals(rules.slugs["not-enabled"], [{
      kind: "run-step",
      target: "enable",
      why: "HUMAN",
    }]);
    // new spec slug appended
    assertEquals("payload-too-large" in rules.slugs, true);
    // hand-added slug not in the spec → kept and reported stale
    assertEquals("hand-added" in rules.slugs, true);
    assertEquals(
      notes.some((n) => n.includes("added 1 new slug(s): payload-too-large")),
      true,
    );
    assertEquals(
      notes.some((n) =>
        n.includes("no longer declared") && n.includes("hand-added")
      ),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureHealRules — a non-heal-rules file is left untouched", async () => {
  const root = await tempProject();
  try {
    await addSpec(root, "tables", TABLES_SPEC);
    const dir = join(root, "fixtures");
    await Deno.mkdir(dir, { recursive: true });
    const path = join(dir, "heal-rules.json");
    await Deno.writeTextFile(path, '{ "unrelated": true }\n');
    const notes = await ensureHealRules(root, []);
    assertEquals(await Deno.readTextFile(path), '{ "unrelated": true }\n');
    assertEquals(
      notes.some((n) => n.includes("not a heal-rules document")),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureHealRules — honors KEEP_FIXTURES_DIR override", async () => {
  const root = await tempProject();
  const prev = Deno.env.get("KEEP_FIXTURES_DIR");
  Deno.env.set("KEEP_FIXTURES_DIR", "keep-fixtures");
  try {
    await addSpec(root, "tables", TABLES_SPEC);
    await ensureHealRules(root, []);
    assertEquals(
      await exists(join(root, "keep-fixtures", "heal-rules.json")),
      true,
    );
    assertEquals(
      await exists(join(root, "fixtures", "heal-rules.json")),
      false,
    );
  } finally {
    if (prev === undefined) Deno.env.delete("KEEP_FIXTURES_DIR");
    else Deno.env.set("KEEP_FIXTURES_DIR", prev);
    await Deno.remove(root, { recursive: true });
  }
});

// ---- alias safety: collisions, illegal chars, commented exports --------------
//
// The rendered registry imports each surface under its alias and lists it in the
// modules array, so every alias must be a UNIQUE, VALID identifier or the file is
// a `Duplicate identifier` / parse error that silently drops a module.

// Parse the import bindings + the modules-array entries out of a rendered
// registry, so a test can assert they line up (no duplicates, no dropped module).
function registryShape(
  out: string,
): { aliases: string[]; arrayEntries: string[] } {
  const aliases: string[] = [];
  for (const m of out.matchAll(/import \{ .* as (\S+) \} from /g)) {
    aliases.push(m[1]);
  }
  const arr = out.slice(out.indexOf("export const modules = ["));
  const arrayEntries: string[] = [];
  for (const line of arr.split("\n")) {
    const t = line.trim().replace(/,$/, "");
    if (
      t && !t.startsWith("//") && !t.startsWith("...") &&
      t !== "export const modules = [" && t !== "]" && t !== "];"
    ) {
      arrayEntries.push(t);
    }
  }
  return { aliases, arrayEntries };
}

// A valid TS identifier (the binding form `import { x as <id> }` requires it).
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

Deno.test("scanSurfaceModules — colliding camel/pascal aliases are disambiguated, no module dropped", async () => {
  const root = await tempProject();
  try {
    // camel('foo-bar')+pascal('http')+'Module' === 'foo'+pascal('bar-http')+'Module'
    // === 'fooBarHttpModule' for both surfaces.
    await addSurface(root, "foo-bar", "http", "httpModule");
    await addSurface(root, "foo", "bar-http", "barHttpModule");
    const found = await scanSurfaceModules(root);
    assertEquals(found.length, 2, "both surfaces are discovered");
    const aliases = found.map((s) => s.alias);
    assertEquals(
      new Set(aliases).size,
      2,
      `aliases must be unique, got ${aliases}`,
    );
    for (const a of aliases) {
      assert(IDENT.test(a), `alias not a valid identifier: ${a}`);
    }

    // The rendered registry imports BOTH (every discovered surface is registered)
    // with no duplicate binding and one array entry per surface.
    const out = renderAppRegistry(found);
    const { aliases: imported, arrayEntries } = registryShape(out);
    assertEquals(new Set(imported).size, 2, "no duplicate import binding");
    assertEquals(arrayEntries.length, 2, "every surface in the modules array");
    assertEquals(
      new Set(arrayEntries).size,
      2,
      "no surface shadowed in the array",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanSurfaceModules — sibling modules differing only by separator get unique aliases", async () => {
  const root = await tempProject();
  try {
    // 'user-api' and 'user_api' both camel to 'userApi' → same alias before dedupe.
    await addSurface(root, "user-api", "rest", "restModule");
    await addSurface(root, "user_api", "rest", "restModule");
    const found = await scanSurfaceModules(root);
    assertEquals(found.length, 2);
    const aliases = found.map((s) => s.alias);
    assertEquals(
      new Set(aliases).size,
      2,
      `aliases must be unique, got ${aliases}`,
    );
    const { aliases: imported } = registryShape(renderAppRegistry(found));
    assertEquals(new Set(imported).size, 2, "no duplicate import binding");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanSurfaceModules — a commented-out export is not read as the export name", async () => {
  const root = await tempProject();
  try {
    const dir = join(root, "src", "checkout", "entrypoints", "http");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "mod.ts"),
      "// export const legacyHttpModule = endpointModule();\n" +
        "export const currentModule = endpointModule();\n",
    );
    const [s] = await scanSurfaceModules(root);
    assertEquals(s.exportName, "currentModule");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanSurfaceModules — a digit-leading module name yields a valid identifier alias", async () => {
  const root = await tempProject();
  try {
    await addSurface(root, "2module", "http", "httpModule");
    const [s] = await scanSurfaceModules(root);
    assert(IDENT.test(s.alias), `alias not a valid identifier: ${s.alias}`);
    // The rendered array entry must also be a valid identifier (it references the alias).
    const { arrayEntries } = registryShape(renderAppRegistry([s]));
    for (const e of arrayEntries) {
      assert(IDENT.test(e), `array entry not valid: ${e}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("renderAppRegistry — a quote in a module name does not break the import string literal", () => {
  const out = renderAppRegistry([
    {
      module: 'my"module',
      surface: "http",
      exportName: "httpModule",
      alias: "myModuleHttpModule",
    },
  ]);
  const importLine = out.split("\n").find((l) => l.startsWith("import "))!;
  // The alias side must be a clean identifier, and the specifier a single closed
  // string literal: exactly two unescaped quotes delimiting it.
  assertStringIncludes(importLine, "as myModuleHttpModule } from ");
  const fromIdx = importLine.indexOf(" from ");
  const specifier = importLine.slice(fromIdx + 6).replace(/;$/, "");
  assertEquals(
    JSON.parse(specifier),
    '@/src/my"module/entrypoints/http/mod.ts',
  );
});

Deno.test("runSync --regen — no success log when the .new write fails", async () => {
  const root = await Deno.makeTempDir();
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    await Deno.mkdir(join(root, "specs"), { recursive: true });
    const runePath = join(root, "specs", "orders.rune");
    await Deno.writeTextFile(runePath, REGEN_SPEC);
    // First sync scaffolds; the spec stays at its staging home (D-durable-home).
    assertEquals(await runSync([runePath, "--root", root, "--no-run"]), 0);
    const target = join(
      "src",
      "orders",
      "domain",
      "business",
      "cart",
      "mod.ts",
    );
    const targetAbs = join(root, target);
    // Hand-edit the body so --regen takes the `.new` branch.
    await Deno.writeTextFile(
      targetAbs,
      await Deno.readTextFile(targetAbs) + "\n// hand edit\n",
    );
    // Make the parent read-only so writing the `.new` sibling fails.
    const parent = join(root, "src", "orders", "domain", "business", "cart");
    await Deno.chmod(parent, 0o500);
    logs.length = 0;
    errs.length = 0;
    const code = await runSync(
      [runePath, "--root", root, "--regen", targetAbs, "--no-run"],
    );
    await Deno.chmod(parent, 0o700); // restore so cleanup can remove it
    assertEquals(code, 2, "a failed regen write exits 2");
    assertEquals(
      await exists(`${targetAbs}.new`),
      false,
      "no .new was written",
    );
    assertEquals(
      logs.some((l) => l.includes("wrote") && l.includes(".new")),
      false,
      `success log must NOT print on a failed write; logs: ${
        JSON.stringify(logs)
      }`,
    );
    assertEquals(
      errs.some((e) => e.includes(".new")),
      true,
      "the error is reported",
    );
  } finally {
    console.log = origLog;
    console.error = origErr;
    await Deno.remove(root, { recursive: true });
  }
});

const REGEN_SPEC = `[MOD] orders
[REQ] orders.place(PlaceDto): OrderDto
    cart.total(): money
    [RET] OrderDto


[NON] cart
    the shopping cart
[TYP] money: number
    a monetary amount

[DTO] PlaceDto: money
    place-order input
[DTO] OrderDto: money
    the resulting order
`;

// ---- S9: a valueless --regen/--root/--artifact must error, not degrade ----
Deno.test("parseSyncArgs — S9: trailing --regen with no value is a usage error", () => {
  // The user forgot to paste the path after --regen. This must NOT silently
  // become a full destructive sync (regen=null skips the non-destructive branch
  // and falls into the prune path).
  assertEquals(
    parseSyncArgs(["src/checkout/checkout.rune", "--force", "--regen"]),
    null,
  );
  // A flag following --regen is also a missing value.
  assertEquals(
    parseSyncArgs(["src/checkout/checkout.rune", "--regen", "--force"]),
    null,
  );
  // --root and --artifact share the same hazard.
  assertEquals(parseSyncArgs(["spec.rune", "--root"]), null);
  assertEquals(parseSyncArgs(["spec.rune", "--artifact"]), null);
  // A well-formed --regen still parses.
  const ok = parseSyncArgs(["spec.rune", "--regen", "src/a/b.ts"]);
  assert(ok !== null);
  assertEquals(ok!.regen, "src/a/b.ts");
});

// ---- S11: BOM stripped; malformed existing deno.json errors, never clobbered ----
Deno.test("ensureImportMap — S11: a BOM-prefixed deno.json is parsed, not clobbered", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = join(root, "deno.json");
    const user = {
      imports: { myalias: "jsr:@me/lib" },
      tasks: { dev: "deno run main.ts" },
    };
    // Write with a leading UTF-8 BOM (what PowerShell Out-File etc. produce).
    await Deno.writeTextFile(path, "﻿" + JSON.stringify(user, null, 2));
    const ioErrors: string[] = [];
    const note = await ensureImportMap(root, ioErrors);
    assertEquals(ioErrors, [], "a BOM must not be a parse failure");
    const after = JSON.parse(
      (await Deno.readTextFile(path)).replace(/^﻿/, ""),
    );
    // The user's keys survive (non-destructive merge).
    assertEquals(after.imports.myalias, "jsr:@me/lib");
    assertEquals(after.tasks.dev, "deno run main.ts");
    // And the report says "updated", not "created".
    assert(note === null || note.includes("updated"), `note: ${note}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureImportMap — S11: a malformed existing deno.json errors, never overwritten", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = join(root, "deno.json");
    const garbage = '{ "imports": { "x": } NOT JSON';
    await Deno.writeTextFile(path, garbage);
    const ioErrors: string[] = [];
    const note = await ensureImportMap(root, ioErrors);
    assertEquals(note, null, "must not report a successful create/update");
    assertEquals(ioErrors.length > 0, true, "the parse failure is reported");
    // The user's (broken) file is untouched — never silently clobbered.
    assertEquals(await Deno.readTextFile(path), garbage);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---- S10: a staging spec is READ IN PLACE (D-durable-home) and still discovered ----
const S10_SPEC = `[MOD] checkout

[ENT] http.start(StartDto): TicketDto

[DTO] StartDto: memberId
    who buys
[DTO] TicketDto: ticketId
    the opened ticket

[TYP:ext] memberId: string
    minted elsewhere
[TYP] ticketId: string
    a ticket id`;

Deno.test("runSync — S10: a staging spec stays in place (D-durable-home) and the ghost stub is still planned", async () => {
  const root = await Deno.makeTempDir();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    await Deno.mkdir(join(root, "specs"), { recursive: true });
    // A finalized spec in a recognized staging dir is the DURABLE CANONICAL
    // HOME — sync reads it there and never relocates it (D-durable-home), and
    // auto-discovery (ghost stubs) must still see it at that path.
    const runePath = join(root, "specs", "flow.rune");
    await Deno.writeTextFile(runePath, S10_SPEC);
    const code = await runSync([runePath, "--root", root, "--no-run"]);
    assertEquals(code, 0);
    // The spec stays at its staging home — never moved into src/.
    assertEquals(
      await exists(runePath),
      true,
      "spec stays at its staging home",
    );
    const oldCanonical = join(root, "src", "checkout", "checkout.rune");
    assertEquals(
      await exists(oldCanonical),
      false,
      "spec is not relocated into src/",
    );
    // And the ghost stub for the unproduced $memberId must have been generated.
    const stub = join(root, "bootstrap", "stubs.ts");
    assertEquals(await exists(stub), true, "ghost stub module was planned");
    const stubText = await Deno.readTextFile(stub);
    assertStringIncludes(stubText, "memberId");
  } finally {
    console.log = origLog;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runSync — D-durable-home: a git-root spec/runes/ spec is read in place across the server/ boundary", async () => {
  const tmp = await Deno.makeTempDir();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    // Composed-app shape: <git>/{.git, spec/runes/, server/} — the shared
    // authoring spec/ is a SIBLING of the codegen root.
    await Deno.mkdir(join(tmp, ".git"), { recursive: true });
    await Deno.mkdir(join(tmp, "spec", "runes"), { recursive: true });
    await Deno.mkdir(join(tmp, "server"), { recursive: true });
    const runePath = join(tmp, "spec", "runes", "checkout.rune");
    await Deno.writeTextFile(runePath, S10_SPEC);
    const serverRoot = join(tmp, "server");
    const code = await runSync([runePath, "--root", serverRoot, "--no-run"]);
    assertEquals(code, 0);
    // The spec stays at the durable home; codegen lands under server/src/.
    assertEquals(await exists(runePath), true, "spec stays at spec/runes/");
    assertEquals(
      await exists(join(serverRoot, "src", "checkout", "checkout.rune")),
      false,
      "spec is not relocated into server/src/",
    );
    assertEquals(
      await exists(
        join(serverRoot, "src", "checkout", "entrypoints", "http", "mod.ts"),
      ),
      true,
      "codegen landed under server/src/checkout/",
    );
    // Sibling-staging auto-discovery: the ghost stub for $memberId was planned,
    // which requires collectProjectSpecs to have crossed the ../ boundary.
    const stubText = await Deno.readTextFile(
      join(serverRoot, "bootstrap", "stubs.ts"),
    );
    assertStringIncludes(stubText, "memberId");
    // Idempotency: a second sync neither moves the spec nor errors.
    assertEquals(
      await runSync([runePath, "--root", serverRoot, "--no-run"]),
      0,
    );
    assertEquals(
      await exists(runePath),
      true,
      "spec still at spec/runes/ after re-sync",
    );
  } finally {
    console.log = origLog;
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---- REQ-004: root-only imports (hoistOnly) never land in a workspace member ----
// coms #rune 20260923T000559Z-w208-103513: in a sprig-composed workspace the
// root deno.json pins @techgoose-labs/bedrock (hoistOnly); every `rune sync`
// put it back into server/deno.json — two composition roots.
const BEDROCK = "@techgoose-labs/bedrock";

async function makeWorkspace(
  rootImports: Record<string, string>,
): Promise<{ tmp: string; server: string }> {
  const tmp = await Deno.makeTempDir({ prefix: "rune-req004-" });
  await Deno.mkdir(join(tmp, ".git"), { recursive: true });
  await Deno.mkdir(join(tmp, "server"), { recursive: true });
  await Deno.writeTextFile(
    join(tmp, "deno.json"),
    JSON.stringify(
      { workspace: ["./ui", "./server"], imports: rootImports },
      null,
      2,
    ) + "\n",
  );
  await Deno.writeTextFile(
    join(tmp, "server", "deno.json"),
    JSON.stringify({ imports: { "@/": "./" } }, null, 2) + "\n",
  );
  return { tmp, server: join(tmp, "server") };
}

Deno.test("ensureImportMap — REQ-004: a workspace member never receives the root-only bedrock import", async () => {
  const { tmp, server } = await makeWorkspace({
    [BEDROCK]: "jsr:@techgoose-labs/bedrock@^1",
  });
  try {
    const ioErrors: string[] = [];
    const note = await ensureImportMap(server, ioErrors);
    assertEquals(ioErrors, []);
    const member = JSON.parse(
      await Deno.readTextFile(join(server, "deno.json")),
    );
    assertEquals(
      BEDROCK in member.imports,
      false,
      "the member's import map must not carry the root-only pin",
    );
    // The rest of the required map still lands in the member.
    assertEquals(
      member.imports["@techgoose-labs/rune"],
      "jsr:@techgoose-labs/rune@^7",
    );
    assert(note !== null && !note.includes(BEDROCK), `note: ${note}`);
    // The root is untouched — it already pinned it.
    const root = JSON.parse(await Deno.readTextFile(join(tmp, "deno.json")));
    assertEquals(root.imports[BEDROCK], "jsr:@techgoose-labs/bedrock@^1");
    assertEquals(root.workspace, ["./ui", "./server"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("ensureImportMap — REQ-004: a workspace root missing the pin gets it there, the member still does not", async () => {
  const { tmp, server } = await makeWorkspace({});
  try {
    const ioErrors: string[] = [];
    const note = await ensureImportMap(server, ioErrors);
    assertEquals(ioErrors, []);
    const member = JSON.parse(
      await Deno.readTextFile(join(server, "deno.json")),
    );
    assertEquals(BEDROCK in member.imports, false);
    const root = JSON.parse(await Deno.readTextFile(join(tmp, "deno.json")));
    assertEquals(root.imports[BEDROCK], "jsr:@techgoose-labs/bedrock@^1");
    // Additive: the root's own keys survive.
    assertEquals(root.workspace, ["./ui", "./server"]);
    assert(
      note !== null && note.includes("root"),
      `note names the root: ${note}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("ensureImportMap — REQ-004: a standalone project still pins bedrock in its own deno.json", async () => {
  const root = await Deno.makeTempDir({ prefix: "rune-req004-solo-" });
  try {
    const ioErrors: string[] = [];
    await ensureImportMap(root, ioErrors);
    assertEquals(ioErrors, []);
    const cfg = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
    assertEquals(cfg.imports[BEDROCK], "jsr:@techgoose-labs/bedrock@^1");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runSync — REQ-004: syncing a workspace member leaves its deno.json without the bedrock import, twice", async () => {
  const { tmp, server } = await makeWorkspace({
    [BEDROCK]: "jsr:@techgoose-labs/bedrock@^1",
  });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    await Deno.mkdir(join(tmp, "spec", "runes"), { recursive: true });
    const runePath = join(tmp, "spec", "runes", "checkout.rune");
    await Deno.writeTextFile(runePath, S10_SPEC);
    for (const pass of [1, 2]) {
      assertEquals(await runSync([runePath, "--root", server, "--no-run"]), 0);
      const member = JSON.parse(
        await Deno.readTextFile(join(server, "deno.json")),
      );
      assertEquals(
        BEDROCK in member.imports,
        false,
        `pass ${pass}: sync re-added the root-only bedrock pin to server/deno.json`,
      );
    }
    const root = JSON.parse(await Deno.readTextFile(join(tmp, "deno.json")));
    assertEquals(root.imports[BEDROCK], "jsr:@techgoose-labs/bedrock@^1");
  } finally {
    console.log = origLog;
    await Deno.remove(tmp, { recursive: true });
  }
});
