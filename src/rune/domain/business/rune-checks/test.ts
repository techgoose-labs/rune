import { assert, assertEquals } from "#std/assert";
import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import { checkSpec, EMITS } from "./mod.ts";
import { planManifest } from "@rune/domain/business/rune-manifest/mod.ts";

/** The ids the checks (and the parser) report for a spec, as `line:id`. */
function ids(text: string): string[] {
  const ast = parse(text);
  return [
    ...ast.errors.map((e) => `${e.line + 1}:${e.id}`),
    ...checkSpec(ast, text).map((f) => `${f.line}:${f.id}`),
  ].sort();
}

const TAIL = `
[NON] task
    a todo item
[DTO] CreateTaskDto: title
    input to create a task
[DTO] TaskDto: id, title
    a persisted task
[TYP:example=buy-milk] title: string
    the title
[TYP] id: string
    the id
`;

Deno.test("REQ-018: a fault is well-known (status from the registry) or carries =NNN, else fault-status", () => {
  const spec = `[REQ] task.create(CreateTaskDto): TaskDto
    [NEW] task
    task.fill(title): task
      ! not-found invalid-title
    task.toDto(): TaskDto
      ! card-expired=402 wobbly
` + TAIL;
  const ast = parse(spec);
  assertEquals(ast.faultStatuses, { "card-expired": 402 });
  assertEquals(ids(spec).filter((x) => x.endsWith("fault-status")), ["6:fault-status"]);
  const f = checkSpec(ast, spec).find((x) => x.id === "fault-status")!;
  assert(f.message.includes('"wobbly"'), f.message);
  assert(f.fix!.includes("! wobbly=<HTTP status>"), f.fix);
});

Deno.test("REQ-019: an [ENT] without a body [REQ] is ent-delegate-required and the fix names the signature match", () => {
  const spec = `[MOD] tasks
[ENT] http.createTask(CreateTaskDto): TaskDto
[ENT] http.makeTask(CreateTaskDto): TaskDto
    [REQ] task.create(CreateTaskDto): TaskDto

[REQ] task.create(CreateTaskDto): TaskDto
    [NEW] task
    task.fill(title): task
    task.toDto(): TaskDto
` + TAIL;
  const plan = planManifest("src/tasks/tasks.rune", spec, new Set());
  const required = plan.findings.filter((f) => f.id === "ent-delegate-required");
  assertEquals(required.map((f) => f.line), [2]);
  assertEquals(
    required[0].fix,
    "add `    [REQ] task.create(CreateTaskDto): TaskDto` under the [ENT]",
  );
  assertEquals(plan.findings.some((f) => f.id === "ent-ambiguous"), false);
  // The controller wires only the body-named coordinator; the bare [ENT] is a stub.
  const ctrl = plan.toCreate.find((f) => f.path.endsWith("entrypoints/http/mod.ts"))!;
  assert(ctrl.content.includes("makeTask(body: CreateTaskDto)"));
  assert(ctrl.content.includes("return taskCreate(body);"));
  assert(ctrl.content.includes("No [REQ] matches"), "the bare [ENT] gets a stub, not a guessed delegate");
  // A body naming an undefined [REQ].
  const undefinedSpec = spec.replace("    [REQ] task.create(CreateTaskDto): TaskDto", "    [REQ] task.build(CreateTaskDto): TaskDto");
  const plan2 = planManifest("src/tasks/tasks.rune", undefinedSpec, new Set());
  assertEquals(plan2.findings.filter((f) => f.id === "ent-delegate-undefined").map((f) => f.line), [3]);
});

Deno.test("REQ-020: a second live value of one type must be named with `as`, and the name resolves in params and [RET]", () => {
  const dup = `[REQ] task.copy(TaskRefDto): TaskDto
    db:task.load(id): TaskDto
      ! not-found
    db:task.load(id): TaskDto
    [RET] TaskDto

[DTO] TaskRefDto: id
    a reference
[DTO] TaskDto: id, title
    a persisted task
[TYP] title: string
    the title
[TYP] id: string
    the id

[SRV] (SIDECAR)db: DB_URL
    the store
    @docs https://docs.example.com/db
`;
  assertEquals(ids(dup).filter((x) => x.includes("value-duplicate")), ["4:value-duplicate"]);
  const named = dup.replace("    db:task.load(id): TaskDto\n    [RET] TaskDto", "    db:task.load(id): TaskDto as twin\n    db:task.save(twin): void\n    [RET] twin");
  assertEquals(ids(named).filter((x) => /value-duplicate|param-scope|last-step/.test(x)), []);
  // The input DTO's fields and the input itself are the initial scope; a fluent
  // step on a [NEW] noun yields the same value.
  const fluent = `[REQ] task.create(CreateTaskDto): TaskDto
    [NEW] task
    task.fill(title): task
    task.toDto(): TaskDto
` + TAIL;
  assertEquals(ids(fluent), []);
});

Deno.test("REQ-020: the five registry scope rules fire under their ids", () => {
  const spec = `[REQ] task.create(CreateTaskDto): TaskDto
    task.fill(title): task
    id::mint(nonce): id
    [NEW] task
    task.fill(title, title): task
    task.toDto(): WidgetDto
` + TAIL;
  const got = ids(spec);
  assert(got.includes("2:noun-in-scope"), got.join(" "));
  assert(got.includes("3:param-scope"), got.join(" "));
  assert(got.includes("5:signature-consistency"), got.join(" "));
  assert(got.includes("6:undefined-ref"), got.join(" "));
  assert(got.includes("6:last-step-returns-output"), got.join(" "));
  // The one declared in constraints.md for years and never enforced (todos/08).
  const sig = `[REQ] card.open(OpenDto): CardDto
    card::toDto(pan): CardDto
[REQ] card.charge(ChargeDto): CardDto
    card::toDto(pan, cvv): CardDto

[NON] card
    a card
[DTO] OpenDto: pan
    open
[DTO] ChargeDto: pan, cvv
    charge
[DTO] CardDto: pan
    a card
[TYP:example=4111] pan: string
    the pan
[TYP:example=123] cvv: string
    the cvv
`;
  assertEquals(ids(sig).filter((x) => x.includes("signature")), ["4:signature-consistency"]);
});

Deno.test("REQ-021: [CTR], Class, from=path and a redundant [RET] are findings with fixes", () => {
  const spec = `[REQ] task.create(CreateTaskDto): TaskDto
    [CTR] task
    task.toDto(): TaskDto
    [RET] TaskDto
[TYP] widget: Class
    a widget
[TYP:from=path] slug: string
    a slug
` + TAIL;
  const got = ids(spec);
  assert(got.includes("2:ctr-retired"), got.join(" "));
  assert(got.includes("4:ret-redundant"), got.join(" "));
  assert(got.includes("5:class-retired"), got.join(" "));
  assert(got.includes("7:from-path-retired"), got.join(" "));
  const ast = parse(spec);
  assert(ast.errors.find((e) => e.id === "ctr-retired")!.fix!.includes("rune fmt"));
  assert(ast.errors.find((e) => e.id === "class-retired")!.fix!.includes("[NON] widget"));
  assert(ast.errors.find((e) => e.id === "from-path-retired")!.fix!.includes("{slug}"));
  assert(checkSpec(ast, spec).find((f) => f.id === "ret-redundant")!.fix!.includes("delete"));
});

Deno.test("REQ-023: the four prose rules are lints with ids", () => {
  const spec = `[MOD] tasks
[ENT] http.editTask @ PATCH /tasks/{id}(TaskDto): TaskDto
    [REQ] task.edit(TaskDto): TaskDto
[ENT] http.createTask(CreateTaskDto): TaskDto
    [REQ] task.delete(CreateTaskDto): TaskDto

[REQ] task.edit(TaskDto): TaskDto
    [NEW] task
    task.toDto(): TaskDto
[REQ] task.delete(CreateTaskDto): TaskDto
    [NEW] task
    task.toDto(): TaskDto
[REQ] task.delete(CreateTaskDto): TaskDto
    [NEW] task
    task.toDto(): TaskDto

[NON] task
    a todo item
[DTO] CreateTaskDto: title
    input to create a task
[DTO] TaskDto: id, title
    a persisted task
[TYP] title: string
    the title
[TYP] id: string
    the id
`;
  const got = ids(spec);
  assert(got.includes("2:edit-record-endpoint"), got.join(" "));
  assert(got.includes("2:unbound-input-needs-example"), got.join(" "));
  assert(got.includes("10:reserved-verb"), got.join(" "));
  assert(got.includes("13:duplicate-req-signature"), got.join(" "));
  const f = checkSpec(parse(spec), spec).find((x) => x.id === "reserved-verb")!;
  assertEquals(f.severity, "error");
  assert(f.fix!.includes("remove"), f.fix);
  assertEquals(EMITS.includes("unbound-input-needs-example"), true);
});
