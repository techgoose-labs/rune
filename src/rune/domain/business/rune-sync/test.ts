import { assert, assertEquals } from "#std/assert";
import { parseBarrelTarget, planSync, polyBarrelNote } from "./mod.ts";

const SPEC = `[MOD] orders
[REQ] orders.place(PlaceDto): OrderDto
    cart.total(): money
    db:store.save(OrderDto): void
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

Deno.test("planSync scaffolds the canonical layout for a fresh module", () => {
  const plan = planSync("specs/orders.rune", SPEC, new Set<string>());
  assertEquals(plan.module, "orders");
  assertEquals(plan.errors, []);

  const created = new Set(plan.toCreate.map((f) => f.path));
  assert(created.has("src/orders/domain/coordinators/orders-place/mod.ts"));
  assert(created.has("src/orders/domain/business/cart/mod.ts"));
  assert(created.has("src/orders/domain/data/store/mod.ts"));
  // <name> binding strips the "Dto" suffix: PlaceDto → dto/place.ts
  assert(created.has("src/orders/dto/place.ts"));
  assert(created.has("src/orders/dto/money.ts"));
  assertEquals(plan.toPrune, []);
});

Deno.test("planSync preserves existing files and prunes orphans", () => {
  const existing = new Set<string>([
    // a filled-in feature the spec still declares → preserved, not pruned
    "src/orders/domain/business/cart/mod.ts",
    // an orphan business feature the spec no longer declares → pruned (folder)
    "src/orders/domain/business/legacy/mod.ts",
    "src/orders/domain/business/legacy/test.ts",
    // an orphan dto file → pruned (file)
    "src/orders/dto/old-dto.ts",
    // an unrelated module → untouched
    "src/billing/domain/business/invoice/mod.ts",
  ]);

  const plan = planSync("specs/orders.rune", SPEC, existing);

  // cart is predicted → skipped (preserved), never pruned
  assert(
    plan.toSkip.some((f) =>
      f.path === "src/orders/domain/business/cart/mod.ts"
    ),
  );
  assert(!plan.toPrune.includes("src/orders/domain/business/cart"));

  // orphans pruned: folder-level for features, file-level for dto
  assert(plan.toPrune.includes("src/orders/domain/business/legacy"));
  assert(plan.toPrune.includes("src/orders/dto/old-dto.ts"));

  // other modules are never touched
  assert(!plan.toPrune.some((p) => p.startsWith("src/billing/")));
});

Deno.test("planSync reports parse errors and plans nothing destructive", () => {
  const plan = planSync(
    "specs/broken.rune",
    "[REQ] no good",
    new Set<string>(),
  );
  assert(plan.errors.length > 0);
  assertEquals(plan.toPrune, []);
});

// ---- WO-8: registry-driven prune policy + dev-owned safety ----

Deno.test("planSync — prunable:false protects a role's orphans from deletion", () => {
  const existing = new Set<string>([
    "src/orders/domain/business/legacy/mod.ts", // dev-owned orphan
    "src/orders/dto/old-dto.ts", // spec-owned orphan
  ]);
  // Forbid pruning business features; dto stays prunable.
  const plan = planSync("specs/orders.rune", SPEC, existing, {
    policies: { "business-impl": { prunable: false } },
  });
  assert(!plan.toPrune.includes("src/orders/domain/business/legacy"));
  assert(plan.toPrune.includes("src/orders/dto/old-dto.ts"));
});

Deno.test("planSync — splits dev-owned orphans into toPruneOwned", () => {
  const existing = new Set<string>([
    "src/orders/domain/business/legacy/mod.ts", // dev-owned feature dir
    "src/orders/dto/old-dto.ts", // spec-owned dto file
  ]);
  const plan = planSync("specs/orders.rune", SPEC, existing);
  // dev-owned feature dir needs --force; dto file is safe to prune
  assert(plan.toPruneOwned.includes("src/orders/domain/business/legacy"));
  assert(!plan.toPruneOwned.includes("src/orders/dto/old-dto.ts"));
  // toPrune still lists both (back-compat)
  assert(plan.toPrune.includes("src/orders/domain/business/legacy"));
  assert(plan.toPrune.includes("src/orders/dto/old-dto.ts"));
});

const PLY_SPEC = `[MOD] recording

[REQ] recording.set(InDto): OutDto
    [PLY] provider.getRecording(id): data
        [CSE] genie
        ex:provider.search(id): SearchDto
        [CSE] fiveNine
        ex:provider.search(id): SearchDto`;

Deno.test("planSync — a removed [CSE] arm's implementations/<case>/ is a dev-owned orphan", () => {
  const base = "src/recording/domain/business/provider";
  const existing = new Set([
    `${base}/base/mod.ts`,
    `${base}/poly-mod.ts`,
    `${base}/implementations/genie/mod.ts`,
    `${base}/implementations/genie/test.ts`,
    `${base}/implementations/five-nine/mod.ts`,
    // a [CSE] arm the spec no longer declares — must become an orphan:
    `${base}/implementations/legacy/mod.ts`,
    `${base}/implementations/legacy/test.ts`,
  ]);
  const plan = planSync("specs/recording.rune", PLY_SPEC, existing);
  assertEquals(plan.errors, []);

  const legacy = `${base}/implementations/legacy`;
  // The removed arm is pruned — and dev-owned, so the entrypoint holds it back until --force.
  assert(
    plan.toPrune.includes(legacy),
    "removed [CSE] folder must be an orphan",
  );
  assert(
    plan.toPruneOwned.includes(legacy),
    "removed [CSE] folder is dev-owned (--force gated)",
  );

  // Declared arms and the structural files must survive.
  assert(!plan.toPrune.includes(`${base}/implementations/genie`));
  assert(!plan.toPrune.includes(`${base}/implementations/five-nine`));
  assert(!plan.toPrune.includes(base), "the [PLY] feature dir itself is kept");
  assert(
    !plan.toPrune.some((p) =>
      p === `${base}/base` || p.endsWith("/poly-mod.ts")
    ),
    "base/ and the poly-mod barrel are not swept",
  );
});

Deno.test("parseBarrelTarget — reads the generated re-export, null on hand-rewrites", () => {
  assertEquals(
    parseBarrelTarget(
      'export { default } from "./implementations/wyn/mod.ts";',
    ),
    "wyn",
  );
  assertEquals(
    parseBarrelTarget(
      "export { default } from './implementations/five-nine/mod.ts'",
    ),
    "five-nine",
  );
  // A hand-rewritten runtime-switch barrel can't be read statically — skip, don't guess.
  assertEquals(
    parseBarrelTarget("export default pick(process.env.PROVIDER);"),
    null,
  );
  // A commented-out old generated line must NOT be read as the live re-export (false warning).
  assertEquals(
    parseBarrelTarget(
      '// export { default } from "./implementations/legacy/mod.ts";\nexport default pick(genie);',
    ),
    null,
  );
  assertEquals(
    parseBarrelTarget(
      '/* old: export { default } from "./implementations/legacy/mod.ts"; */\nimport g from "./implementations/genie/mod.ts";\nexport default g;',
    ),
    "genie",
  );
});

Deno.test("polyBarrelNote — warns on an absent or undeclared variant, silent when fine", () => {
  const dir = "src/recording/domain/business/provider";
  const cases = new Set(["genie", "five-nine"]);
  // points at a current, declared, existing variant → no warning
  assertEquals(polyBarrelNote(dir, "genie", cases, true), null);
  // points at a variant whose folder is gone (e.g. --force just pruned it) → warn
  const gone = polyBarrelNote(dir, "wyn", cases, false);
  assert(gone && gone.includes("no longer exists"), "absent folder must warn");
  // folder still on disk but no [CSE] declares it → warn to repoint
  const undeclared = polyBarrelNote(dir, "wyn", cases, true);
  assert(
    undeclared && undeclared.includes("no [CSE] declares"),
    "undeclared variant must warn",
  );
});

// ---- create-once growth (bug report 2026-07-01, infra, issue #2) -------------
//
// Incremental sync: a spec that GROWS an existing green module generated
// coordinators calling adapter methods / DTO fields / @Endpoint bindings that
// the preserved create-once files never received — silently. Growth appends the
// missing members exactly as the generator would have emitted them.

import { planCreateOnceGrowth } from "./mod.ts";
import { planManifest } from "@rune/domain/business/rune-manifest/mod.ts";
import { assertStringIncludes } from "#std/assert";

const WIDGETS_V1 = `[MOD] widgets

[REQ] widget.define(DefineWidgetDto): WidgetDto
    widget::newId(): widgetId
    widget::build(DefineWidgetDto, widgetId): WidgetDto
    kv:widget.set(widgetId, WidgetDto): void
      timeout
    log:audit.widgetDefined(WidgetDto): void
    [RET] WidgetDto


[ENT] widgets.widgetDefine(DefineWidgetDto): WidgetDto


[TYP] widgetId: string
    unique identifier of a widget
[TYP:example=gizmo] name: string
    human-facing name of the widget

[DTO] WidgetDto: widgetId, name
    a stored widget record
[DTO] DefineWidgetDto: name
    input to define a new widget

[NON] widget
    builds and persists widget records
[NON] audit
    writes audit-log entries for mutating requests
`;

// The module GROWS: a new [REQ] (widget.attach), a new [ENT], a new noun (part),
// a new audit event, and WidgetDto gains a field.
const WIDGETS_V2 = WIDGETS_V1
  .replace(
    "[ENT] widgets.widgetDefine(DefineWidgetDto): WidgetDto",
    `[REQ] widget.attach(WidgetPartDto): WidgetDto
    kv:widget.get(widgetId): WidgetDto
      not-found
    kv:part.get(partId): PartDto
      not-found
    kv:widget.addPart(widgetId, partId): WidgetDto
      timeout
    log:audit.widgetPartAttached(WidgetDto): void
    [RET] WidgetDto


[ENT] widgets.widgetDefine(DefineWidgetDto): WidgetDto
[ENT] widgets.widgetAttach(WidgetPartDto): WidgetDto`,
  )
  .replace(
    "[TYP] widgetId: string",
    `[TYP] partId: string
    unique identifier of a widget part
[TYP] widgetId: string`,
  )
  .replace(
    "[DTO] WidgetDto: widgetId, name",
    `[DTO] PartDto: partId, name
    a stored widget part record
[DTO] WidgetPartDto: widgetId, partId
    input attaching a part to a widget
[DTO] WidgetDto: widgetId, name, partId?`,
  );

/** The two plans of the incremental repro: phase-1 content is what exists on
 * disk (create-once), phase-2 content is what the grown spec freshly predicts. */
function phases(): { v1: Map<string, string>; v2: Map<string, string> } {
  const p1 = planManifest("src/widgets/widgets.rune", WIDGETS_V1, new Set());
  const p2 = planManifest("src/widgets/widgets.rune", WIDGETS_V2, new Set());
  const flat = (p: typeof p1) =>
    new Map([...p.toCreate, ...p.toRegenerate].map((f) => [f.path, f.content]));
  assertEquals(p1.errors, []);
  assertEquals(p2.errors, []);
  return { v1: flat(p1), v2: flat(p2) };
}

Deno.test("growth — appends the new audit method to the preserved adapter (stub body, imports merged)", () => {
  const { v1, v2 } = phases();
  const path = "src/widgets/domain/data/audit/mod.ts";
  const result = planCreateOnceGrowth(path, v1.get(path)!, v2.get(path)!);
  assert(result && "grown" in result, "audit adapter must grow");
  const { content, added } = result.grown;
  // the phase-1 method is untouched, the phase-2 method is appended as a stub
  assertStringIncludes(content, "widgetDefined(");
  assertStringIncludes(
    content,
    "widgetPartAttached(widgetDto: WidgetDto): Promise<void>",
  );
  assertStringIncludes(content, 'throw new Error("not implemented");');
  assertEquals(added.includes("method widgetPartAttached"), true);
  // still exactly one class, closed once
  assertEquals(content.match(/export class Audit \{/g)!.length, 1);
});

Deno.test("growth — appends new kv methods the new coordinator calls (get, addPart)", () => {
  const { v1, v2 } = phases();
  const path = "src/widgets/domain/data/widget/mod.ts";
  const result = planCreateOnceGrowth(path, v1.get(path)!, v2.get(path)!);
  assert(result && "grown" in result, "widget adapter must grow");
  const { content, added } = result.grown;
  assertStringIncludes(content, "get(widgetId: string): Promise<WidgetDto>");
  assertStringIncludes(
    content,
    "addPart(widgetId: string, partId: string): Promise<WidgetDto>",
  );
  // set() exists from phase 1 — not duplicated
  assertEquals(content.match(/\n {2}set\(/g)!.length, 1);
  assertEquals(added.includes("method get"), true);
  assertEquals(added.includes("method addPart"), true);
});

Deno.test("growth — appends the new @Endpoint delegator + its coordinator import", () => {
  const { v1, v2 } = phases();
  const path = "src/widgets/entrypoints/widgets/mod.ts";
  const result = planCreateOnceGrowth(path, v1.get(path)!, v2.get(path)!);
  assert(result && "grown" in result, "controller must grow");
  const { content, added } = result.grown;
  // the new endpoint method, decorated, delegating to the new coordinator
  assertStringIncludes(content, "@Endpoint({");
  assertStringIncludes(
    content,
    "widgetAttach(body: WidgetPartDto): Promise<WidgetDto>",
  );
  assertStringIncludes(
    content,
    'import { attach as widgetAttach } from "@/src/widgets/domain/coordinators/widget-attach/mod.ts";',
  );
  assertStringIncludes(
    content,
    'import { WidgetPartDto } from "@/src/widgets/dto/widget-part.ts";',
  );
  assertEquals(added.includes("@Endpoint widgetAttach"), true);
  // the phase-1 endpoint is untouched and not duplicated
  assertEquals(
    content.match(/widgetDefine\(body: DefineWidgetDto\)/g)!.length,
    1,
  );
});

Deno.test("growth — appends the new DTO field with its decorator stack", () => {
  const { v1, v2 } = phases();
  const path = "src/widgets/dto/widget.ts";
  const result = planCreateOnceGrowth(path, v1.get(path)!, v2.get(path)!);
  assert(result && "grown" in result, "WidgetDto must grow");
  const { content, added } = result.grown;
  assertStringIncludes(content, "partId?: string;");
  assertStringIncludes(content, "@IsOptional()");
  assertEquals(added.includes("field partId"), true);
});

Deno.test("growth — hand-filled bodies survive; nothing to add returns null", () => {
  const { v1, v2 } = phases();
  const path = "src/widgets/domain/data/audit/mod.ts";
  // the dev filled the phase-1 body: growth must append around it, not touch it
  const filled = v1.get(path)!.replace(
    'throw new Error("not implemented");',
    "await this.log.write(widgetDto); return;",
  );
  const result = planCreateOnceGrowth(path, filled, v2.get(path)!);
  assert(result && "grown" in result);
  assertStringIncludes(
    result.grown.content,
    "await this.log.write(widgetDto); return;",
  );
  // identical spec → nothing missing → null
  assertEquals(planCreateOnceGrowth(path, v1.get(path)!, v1.get(path)!), null);
  // non-growable roles (tests, coordinators) are never touched
  assertEquals(
    planCreateOnceGrowth(
      "src/widgets/domain/data/audit/smk.test.ts",
      "x",
      "y",
    ),
    null,
  );
  assertEquals(
    planCreateOnceGrowth(
      "src/widgets/domain/coordinators/widget-define/mod.ts",
      v1.get("src/widgets/domain/coordinators/widget-define/mod.ts")!,
      v2.get("src/widgets/domain/coordinators/widget-define/mod.ts")!,
    ),
    null,
  );
});

Deno.test("growth — a class that can't be located is reported as owed, never written", () => {
  const { v1, v2 } = phases();
  const path = "src/widgets/domain/data/audit/mod.ts";
  // the dev renamed the class — growth must refuse to guess an insertion point
  const renamed = v1.get(path)!.replace(/class Audit/g, "class AuditLog");
  const result = planCreateOnceGrowth(path, renamed, v2.get(path)!);
  assert(result && "owed" in result, "renamed class must fall back to owed");
  assertEquals(result.owed, ["method widgetPartAttached"]);
});

// ---- honest ownership: the prune gate's marker test (infra 2026-09-03) -------

import { isRuneGenerated } from "./mod.ts";

Deno.test("isRuneGenerated — rune banners prove ownership; anything else is foreign", () => {
  // every banner rune's generators emit
  assert(
    isRuneGenerated(
      "// Generated by rune manifest from src/apps/apps.rune.\nexport class A {}\n",
    ),
  );
  assert(
    isRuneGenerated(
      "// Generated by rune manifest from ../spec/runes/apps.rune:382.\n",
    ),
  );
  assert(
    isRuneGenerated(
      "// Generated by rune manifest — DO NOT EDIT (regenerated on every `rune sync`).\n",
    ),
  );
  assert(isRuneGenerated("// Generated by rune sync — DO NOT EDIT.\n"));
  // hand-authored files — including the exact infra header — are foreign
  assert(
    !isRuneGenerated(
      "// Hand-authored (not rune-generated): input to `apps/ship`.\nexport class ShipDto {}\n",
    ),
  );
  assert(!isRuneGenerated("export class ShipDto {}\n"));
  assert(!isRuneGenerated(""));
  // the phrase buried deep in a hand-written file does not hand rune ownership
  assert(
    !isRuneGenerated(
      "// mine\n\n\n\n\n// Generated by rune manifest from x.rune.\n",
    ),
  );
});

// ---- growth never retrofits inferred infrastructure (bug report 2026-09-03,
// infra: access.rune) ---------------------------------------------------------
//
// Syncing a spec that GREW (new REQs NOT touching an existing adapter's
// boundary) appended `constructor(private readonly firebase = new
// FirebaseService()) {}` + the import to the preserved create-once Claims
// adapter — a class whose methods never reference the service, against a
// service whose real constructor requires a mandatory argument. Extending a
// create-once file must append the new SPEC-DRIVEN members only; a constructor
// is inferred wiring and rides along only when an appended member references a
// property it binds.

import { parse } from "@rune/domain/business/rune-parse/mod.ts";

const ACCESS_CORE = `[MOD] core

[SRV] (SIDECAR)firebase: FIREBASE_KEY
    the firebase identity service
    @docs https://example.com/firebase
`;

const ACCESS_V1 = `[MOD] access

[REQ] member.allow(MemberGrantDto): MemberDto
    firebase:claims.allow(ClaimKeyDto): void
      timeout
    [RET] MemberDto


[TYP] userId: string
    unique identifier of a user

[DTO] MemberGrantDto: userId
    input granting a member a claim
[DTO] ClaimKeyDto: userId
    the claim key to write
[DTO] MemberDto: userId
    a member record
`;

// The module GROWS with a REQ whose steps do NOT touch the claims boundary.
const ACCESS_V2 = ACCESS_V1
  .replace(
    "[TYP] userId: string",
    `[REQ] member.list(MemberFilterDto): MemberListDto
    kv:member.list(MemberFilterDto): MemberListDto
      timeout
    [RET] MemberListDto


[TYP] userId: string`,
  )
  .replace(
    "[DTO] MemberDto: userId",
    `[DTO] MemberFilterDto: userId
    filter for listing members
[DTO] MemberListDto: userId
    a page of member records
[DTO] MemberDto: userId`,
  );

// The module GROWS with a REQ that DOES add a new claims-boundary method.
const ACCESS_V3 = ACCESS_V1.replace(
  "[TYP] userId: string",
  `[REQ] member.deny(MemberGrantDto): MemberDto
    firebase:claims.deny(ClaimKeyDto): void
      timeout
    [RET] MemberDto


[TYP] userId: string`,
);

const CLAIMS_PATH = "src/access/domain/data/claims/mod.ts";

/** Fresh generated content per spec version, with the shared firebase [SRV]
 * resolved (that's what makes the generator emit the service constructor). */
function accessFresh(spec: string): Map<string, string> {
  const srvs = new Map(parse(ACCESS_CORE).srvs.map((s) => [s.name, s]));
  const p = planManifest("src/access/access.rune", spec, new Set(), {}, srvs);
  assertEquals(p.errors, []);
  return new Map(
    [...p.toCreate, ...p.toRegenerate].map((f) => [f.path, f.content]),
  );
}

/** The dev-owned on-disk state of the infra bug: the claims adapter exists with
 * its methods filled, but WITHOUT the service constructor or its import (the
 * dev rewrote the bodies against another store). */
function devClaims(fresh: string): string {
  return fresh.split("\n").filter((l) => !l.includes("FirebaseService")).join(
    "\n",
  );
}

Deno.test("growth — never appends a constructor no newly appended member references (infra 2026-09-03)", () => {
  const v1 = accessFresh(ACCESS_V1);
  const v2 = accessFresh(ACCESS_V2);
  // Repro premise: the fresh adapter DOES carry the inferred service constructor.
  assertStringIncludes(
    v1.get(CLAIMS_PATH)!,
    "constructor(private readonly firebase = new FirebaseService()) {}",
  );
  const existing = devClaims(v1.get(CLAIMS_PATH)!);
  // The grown spec owes claims NOTHING (its new REQ never touches the boundary):
  // growth must be a no-op — not a retrofitted constructor + import.
  assertEquals(
    planCreateOnceGrowth(CLAIMS_PATH, existing, v2.get(CLAIMS_PATH)!),
    null,
  );
});

Deno.test("growth — a new boundary method appends WITHOUT dragging the inferred constructor in", () => {
  const v1 = accessFresh(ACCESS_V1);
  const v3 = accessFresh(ACCESS_V3);
  const existing = devClaims(v1.get(CLAIMS_PATH)!);
  const result = planCreateOnceGrowth(
    CLAIMS_PATH,
    existing,
    v3.get(CLAIMS_PATH)!,
  );
  assert(
    result && "grown" in result,
    "the new claims.deny method must be appended",
  );
  const { content, added } = result.grown;
  // The spec-driven member lands…
  assertStringIncludes(
    content,
    "deny(claimKeyDto: ClaimKeyDto): Promise<void>",
  );
  assertEquals(added, ["method deny"]);
  // …the inferred infrastructure does not: no member of this class references
  // the service, and its zero-arg default may not even compile.
  assert(
    !content.includes("constructor("),
    "no constructor may be retrofitted",
  );
  assert(
    !content.includes("FirebaseService"),
    "no unused service import may be added",
  );
});

Deno.test("growth — braces inside strings/templates/comments don't break the class scan", () => {
  const { v1, v2 } = phases();
  const path = "src/widgets/domain/data/audit/mod.ts";
  const tricky = v1.get(path)!.replace(
    'throw new Error("not implemented");',
    'const s = "}"; const t = `a${JSON.stringify({ b: "}" })}`; /* } */ // }\n    throw new Error(s + t);',
  );
  const result = planCreateOnceGrowth(path, tricky, v2.get(path)!);
  assert(result && "grown" in result, "scanner must survive brace noise");
  // appended INSIDE the class: the new method comes before the final close
  const c = result.grown.content;
  assert(
    c.indexOf("widgetPartAttached(") < c.lastIndexOf("}"),
    "method must land inside the class",
  );
  assertStringIncludes(c, 'const s = "}";');
});
