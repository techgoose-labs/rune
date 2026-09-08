import { assertEquals } from "#std/assert";
import {
  type HealRules,
  mergeHealRules,
  planHealRules,
  readHealRules,
  renderHealRules,
  todoSlugs,
} from "./mod.ts";

// A module with two endpoints. `table.write` dispatches via [REQ] table.write and
// declares `not-enabled` + `quota-exceeded`; `table.enable` is the precondition
// endpoint whose id the slug `not-enabled` should match for a run-step.
const TABLES = `[MOD] tables

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
    a row id`;

// A REQ with faults that NO endpoint dispatches to → its slugs are not endpoint
// faults and must be excluded.
const ORPHAN_REQ = `[MOD] orphan

[ENT] http.ping(PingDto): PongDto

[REQ] ping.do(PingDto): PongDto
    [NEW] pong
    pong.toDto(): PongDto

[REQ] secret.work(SecretDto): SecretOutDto
    db:secret.load(SecretDto): SecretOutDto
      never-surfaces
    secret.toDto(): SecretOutDto

[DTO] PingDto: ping
    a ping
[DTO] PongDto: pong
    a pong
[DTO] SecretDto: s
    secret in
[DTO] SecretOutDto: o
    secret out

[TYP] ping: string
    p
[TYP] pong: string
    p
[TYP] s: string
    s
[TYP] o: string
    o`;

Deno.test("planHealRules — collects endpoint-attributed slugs, drops timeout", () => {
  const plan = planHealRules([{
    path: "src/tables/tables.rune",
    text: TABLES,
  }]);
  // `timeout` is keep's reserved generic → excluded; the rest are kept.
  assertEquals(plan.slugs, ["not-enabled", "quota-exceeded"]);
  assertEquals(plan.raisedBy["not-enabled"], ["write"]);
});

Deno.test("planHealRules — `not-enabled` pre-fills a run-step matching the enable endpoint", () => {
  const plan = planHealRules([{
    path: "src/tables/tables.rune",
    text: TABLES,
  }]);
  const sugg = plan.scaffold["not-enabled"];
  assertEquals(sugg.length, 1);
  assertEquals(sugg[0].kind, "run-step");
  assertEquals(sugg[0].match, "/enable/i");
  assertEquals(sugg[0].todo, true);
});

Deno.test("planHealRules — no signal falls back to a TODO note", () => {
  const plan = planHealRules([{
    path: "src/tables/tables.rune",
    text: TABLES,
  }]);
  const sugg = plan.scaffold["quota-exceeded"];
  assertEquals(sugg.length, 1);
  assertEquals(sugg[0].kind, "note");
  assertEquals(sugg[0].todo, true);
});

Deno.test("planHealRules — faults on a REQ no endpoint reaches are excluded", () => {
  const plan = planHealRules([{
    path: "src/orphan/orphan.rune",
    text: ORPHAN_REQ,
  }]);
  assertEquals(plan.slugs, []);
});

Deno.test("planHealRules — a parse error contributes nothing", () => {
  const plan = planHealRules([{ path: "bad.rune", text: "[REQ] broken(" }]);
  assertEquals(plan.slugs, []);
});

Deno.test("mergeHealRules — creates from scaffold when no file exists", () => {
  const { result, added, stale, changed } = mergeHealRules(null, {
    "not-found": [{ kind: "note", label: "x", todo: true }],
  });
  assertEquals(changed, true);
  assertEquals(added, ["not-found"]);
  assertEquals(stale, []);
  assertEquals(Object.keys(result.slugs), ["not-found"]);
  assertEquals(result.v, 1);
});

Deno.test("mergeHealRules — never clobbers an existing slug's suggestions", () => {
  const existing: HealRules = {
    v: 1,
    slugs: {
      "not-found": [{ kind: "run-step", target: "create", why: "hand-edited" }],
    },
  };
  const { result, added, changed } = mergeHealRules(existing, {
    "not-found": [{ kind: "note", label: "scaffold", todo: true }],
    "new-slug": [{ kind: "note", label: "fresh", todo: true }],
  });
  // existing entry preserved verbatim, new slug appended
  assertEquals(result.slugs["not-found"], existing.slugs["not-found"]);
  assertEquals(added, ["new-slug"]);
  assertEquals(changed, true);
  assertEquals(Object.keys(result.slugs), ["not-found", "new-slug"]);
});

Deno.test("mergeHealRules — preserves existing key order, appends new sorted", () => {
  const existing: HealRules = {
    v: 1,
    slugs: { "zeta": [], "alpha": [] },
  };
  const { result } = mergeHealRules(existing, {
    "zeta": [],
    "alpha": [],
    "mid": [{ kind: "note" }],
    "beta": [{ kind: "note" }],
  });
  assertEquals(Object.keys(result.slugs), ["zeta", "alpha", "beta", "mid"]);
});

Deno.test("mergeHealRules — re-merge with no new slugs is a no-op (changed=false)", () => {
  const existing: HealRules = {
    v: 1,
    slugs: { "not-found": [{ kind: "note", todo: true }] },
  };
  const { changed, added } = mergeHealRules(existing, {
    "not-found": [{ kind: "note", todo: true }],
  });
  assertEquals(changed, false);
  assertEquals(added, []);
});

Deno.test("mergeHealRules — slug no longer declared is kept and reported stale", () => {
  const existing: HealRules = {
    v: 1,
    slugs: { "gone": [{ kind: "note" }], "stays": [{ kind: "note" }] },
  };
  const { result, stale, changed } = mergeHealRules(existing, {
    "stays": [{ kind: "note" }],
  });
  // never deleted
  assertEquals(Object.keys(result.slugs).sort(), ["gone", "stays"]);
  assertEquals(stale, ["gone"]);
  assertEquals(changed, false); // kept-as-is, nothing added
});

Deno.test("readHealRules — leniently reads a slugs map", () => {
  const r = readHealRules({ v: 1, slugs: { "a-b": [{ kind: "note" }] } });
  assertEquals(r?.slugs["a-b"][0].kind, "note");
});

Deno.test("readHealRules — rejects a non-heal-rules document", () => {
  assertEquals(readHealRules({ unrelated: true }), null);
  assertEquals(readHealRules([1, 2, 3]), null);
  assertEquals(readHealRules("string"), null);
  assertEquals(readHealRules(null), null);
});

Deno.test("readHealRules — a `v`-only document reads as empty slugs", () => {
  assertEquals(readHealRules({ v: 1 }), { v: 1, slugs: {} });
});

Deno.test("renderHealRules — stable JSON with trailing newline", () => {
  const text = renderHealRules({ v: 1, slugs: { "a-b": [{ kind: "retry" }] } });
  assertEquals(text.endsWith("\n"), true);
  assertEquals(JSON.parse(text).v, 1);
});

Deno.test("todoSlugs — only slugs with a todo:true suggestion, sorted", () => {
  const rules: HealRules = {
    v: 1,
    slugs: {
      "zeta-fault": [{ kind: "note", todo: true }],
      "enriched": [{ kind: "run-step", match: "/x/i", why: "real" }],
      "alpha-fault": [{ kind: "run-step", match: "/y/i", todo: true }],
      "mixed": [{ kind: "run-step", why: "real" }, {
        kind: "note",
        todo: true,
      }],
    },
  };
  assertEquals(todoSlugs(rules), ["alpha-fault", "mixed", "zeta-fault"]);
});

Deno.test("todoSlugs — empty when every entry is enriched", () => {
  const rules: HealRules = {
    v: 1,
    slugs: { "a-b": [{ kind: "retry", why: "transient" }] },
  };
  assertEquals(todoSlugs(rules), []);
});

Deno.test("planHealRules — [PLY] case faults are collected", () => {
  const PLY = `[MOD] notify

[ENT] http.send(SendDto): SentDto

[REQ] channel.deliver(SendDto): SentDto
    [PLY] channel.deliver(SendDto): SentDto
        [CSE] email
        ex:channel.sendEmail(SendDto): SentDto
          bad-address
        [CSE] push
        ex:channel.sendPush(SendDto): SentDto
          token-expired
    channel.toDto(): SentDto

[DTO] SendDto: to, body
    a message
[DTO] SentDto: receiptId
    proof of send

[TYP] to: string
    recipient
[TYP] body: string
    contents
[TYP] receiptId: string
    a receipt`;
  const plan = planHealRules([{ path: "src/notify/notify.rune", text: PLY }]);
  assertEquals(plan.slugs, ["bad-address", "token-expired"]);
});
