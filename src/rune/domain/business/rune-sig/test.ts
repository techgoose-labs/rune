import { assert, assertEquals, assertStringIncludes } from "#std/assert";
import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import { bindings } from "@rune/domain/business/rune-bindings/mod.ts";
import { collectNounMethods, renderImpl, renderParams } from "./mod.ts";

// ---- L1: param identifier dedup must stay collision-free ----
// The empty/duplicate fallback must NOT itself collide. When an earlier real
// param already produced `arg1` and a later param at index 1 collapses (empty
// or junk), the fallback `arg${i}` would reuse `arg1`, emitting a signature
// like `run(arg1: unknown, arg1: unknown)` that fails `deno check` (TS2300
// Duplicate identifier). Each rendered identifier must be DISTINCT.

function identsOf(rendered: string): string[] {
  return rendered
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.split(":")[0].trim());
}

Deno.test("renderParams — empty param colliding with a real argN stays distinct", () => {
  // `arg1` is a real param at index 0; the empty param at index 1 must NOT
  // also collapse to `arg1`.
  const rendered = renderParams(["arg1", ""]);
  const idents = identsOf(rendered);
  assertEquals(idents.length, 2);
  assertEquals(new Set(idents).size, 2, `duplicate identifier in: ${rendered}`);
});

Deno.test("renderParams — junk param colliding with a real argN stays distinct", () => {
  // `@` sanitises to "" then would collapse to `arg1`, colliding with the real
  // `arg1` at index 0.
  const rendered = renderParams(["arg1", "@"]);
  const idents = identsOf(rendered);
  assertEquals(idents.length, 2);
  assertEquals(new Set(idents).size, 2, `duplicate identifier in: ${rendered}`);
});

const SPEC = `[MOD] m
[REQ] m.run(InDto): OutDto
    id::create(providerName): id
    id.toDto(): OutDto
    [RET] OutDto
`;

Deno.test("collectNounMethods groups static + instance per noun", () => {
  const methods = collectNounMethods(parse(SPEC));
  const id = methods.get("id");
  assert(id);
  assertEquals(id.length, 2);
  assert(id.some((m) => m.verb === "create" && m.isStatic));
  assert(id.some((m) => m.verb === "toDto" && !m.isStatic));
});

Deno.test("collectNounMethods carries each step's declared output", () => {
  const methods = collectNounMethods(parse(SPEC));
  const id = methods.get("id");
  assert(id);
  assertEquals(id.find((m) => m.verb === "create")?.output, "id");
  assertEquals(id.find((m) => m.verb === "toDto")?.output, "OutDto");
});

Deno.test("renderImpl emits a plain concrete class (no base, no override)", () => {
  const impl = renderImpl("id", [
    {
      verb: "create",
      params: ["providerName"],
      output: "",
      isStatic: true,
      faults: [],
    },
    { verb: "toDto", params: [], output: "", isStatic: false, faults: [] },
  ]);
  assertStringIncludes(impl, "export class Id {");
  assertStringIncludes(impl, "static create(providerName: unknown): unknown {");
  assertStringIncludes(impl, "  toDto(): unknown {");
  // No abstract base, no override modifier, no sig import, no satisfies.
  assert(!impl.includes("extends"));
  assert(!impl.includes("override"));
  assert(!impl.includes("./sig.ts"));
  assert(!impl.includes("satisfies"));
});

// ---- typed stubs: params/returns resolve through the spec's [DTO]/[TYP] ----

const TYPED_SPEC = `[MOD] tasks
[REQ] task.create(CreateTaskDto): TaskDto
    db:task.load(id): TaskDto
    db:task.save(TaskDto): void
    db:task.count(): total
    task.normalize(): task
    task.mystery(ghost): spirit

[DTO] CreateTaskDto: title
    input
[DTO] TaskDto: id, title
    the task
[DTO:core] AuditDto: id
    shared audit record

[TYP] id: string
    an id
[TYP] title: string
    a title
[TYP] total: number
    how many
`;

function typedOpts(spec: string) {
  const ast = parse(spec);
  return {
    typMap: new Map(ast.typs.map((t) => [t.name, t])),
    dtoByName: new Map(ast.dtos.map((d) => [d.name, d])),
    module: "tasks",
    nameBinding: bindings["<name>"],
  };
}

Deno.test("renderImpl — adapter signatures: typed params, Promise returns", () => {
  const ast = parse(TYPED_SPEC);
  const methods = collectNounMethods(ast).get("task")!;
  const impl = renderImpl("task", methods, {
    async: true,
    ...typedOpts(TYPED_SPEC),
  });
  // db:task.save(TaskDto): void → save(taskDto: TaskDto): Promise<void>
  assertStringIncludes(impl, "save(taskDto: TaskDto): Promise<void> {");
  // db:task.load(id): TaskDto → load(id: string): Promise<TaskDto>
  assertStringIncludes(impl, "load(id: string): Promise<TaskDto> {");
  // [TYP] total: number → Promise<number>
  assertStringIncludes(impl, "count(): Promise<number> {");
  // output equals the noun → the class's own name
  assertStringIncludes(impl, "normalize(): Promise<Task> {");
  // unresolvable param/output stay unknown
  assertStringIncludes(impl, "mystery(ghost: unknown): Promise<unknown> {");
  // the referenced DTO class is imported (module path — not :core)
  assertStringIncludes(
    impl,
    'import { TaskDto } from "@/src/tasks/dto/task.ts";',
  );
  // bodies still throw
  assertStringIncludes(impl, 'throw new Error("not implemented");');
});

Deno.test("renderImpl — business classes stay sync (no Promise)", () => {
  const impl = renderImpl("task", [
    {
      verb: "load",
      params: ["id"],
      output: "TaskDto",
      isStatic: false,
      faults: [],
    },
  ], typedOpts(TYPED_SPEC));
  assertStringIncludes(impl, "load(id: string): TaskDto {");
  assert(!impl.includes("Promise<"));
});

Deno.test("renderImpl — :core DTO imports from src/core/dto", () => {
  const impl = renderImpl("audit", [
    {
      verb: "record",
      params: ["AuditDto"],
      output: "void",
      isStatic: false,
      faults: [],
    },
  ], { async: true, ...typedOpts(TYPED_SPEC) });
  assertStringIncludes(impl, "record(auditDto: AuditDto): Promise<void> {");
  assertStringIncludes(
    impl,
    'import { AuditDto } from "@/src/core/dto/audit.ts";',
  );
});

Deno.test("renderImpl — empty output stays unknown; no opts stays legacy", () => {
  const typed = renderImpl("id", [
    { verb: "mint", params: [], output: "", isStatic: true, faults: [] },
  ], typedOpts(TYPED_SPEC));
  assertStringIncludes(typed, "static mint(): unknown {");
  // Without options nothing resolves and no import is emitted.
  const legacy = renderImpl("task", [
    {
      verb: "load",
      params: ["id"],
      output: "TaskDto",
      isStatic: false,
      faults: [],
    },
  ]);
  assertStringIncludes(legacy, "load(id: unknown): unknown {");
  assert(!legacy.includes("import"));
});

// ---- enrichment: provenance header, [NON] doc, @param/@returns, @throws ----

const NON_BY_NOUN = new Map([
  ["task", { name: "task", description: "a single todo item", line: 0 }],
]);

Deno.test("collectNounMethods unions faults across calls of the same method", () => {
  const spec = `[MOD] tasks
[REQ] task.create(InDto): OutDto
    db:task.save(InDto): void
      timeout
[REQ] task.update(InDto): OutDto
    db:task.save(InDto): void
      conflict
`;
  const save = collectNounMethods(parse(spec)).get("task")!
    .find((m) => m.verb === "save")!;
  assertEquals(save.faults.sort(), ["conflict", "timeout"]);
});

Deno.test("renderImpl — business: provenance, [NON] doc, @param, @throws", () => {
  const impl = renderImpl("task", [
    {
      verb: "fill",
      params: ["title"],
      output: "task",
      isStatic: false,
      faults: ["timeout"],
    },
  ], {
    ...typedOpts(TYPED_SPEC),
    runePath: "src/tasks/tasks.rune",
    nonByNoun: NON_BY_NOUN,
  });
  assertStringIncludes(
    impl,
    "// Generated by rune manifest from src/tasks/tasks.rune.",
  );
  assertStringIncludes(impl, "// a single todo item\nexport class Task {");
  assertStringIncludes(impl, "@param title a title"); // [TYP] title desc
  assertStringIncludes(impl, "@throws timeout");
  // output === noun → no @returns line
  assert(!impl.includes("@returns"));
});

Deno.test("renderImpl — adapter announces its I/O-boundary role + [NON]", () => {
  const impl = renderImpl("task", [
    {
      verb: "save",
      params: ["TaskDto"],
      output: "void",
      isStatic: false,
      faults: ["timeout"],
    },
  ], { async: true, ...typedOpts(TYPED_SPEC), nonByNoun: NON_BY_NOUN });
  assertStringIncludes(impl, "// Data adapter for `task` — the I/O boundary.");
  assertStringIncludes(impl, "// a single todo item");
  assertStringIncludes(impl, "@throws timeout");
});

Deno.test("renderImpl — adapter method documents its [SRV] service (E20)", () => {
  const srvByName = new Map([
    ["firebase", {
      transport: "SDK",
      name: "firebase",
      envVars: ["FIREBASE_API_KEY", "FIREBASE_PROJECT_ID"],
      description: "Firebase callable; charge() idempotent",
      docsLink: "https://firebase.google.com/docs/functions",
      line: 0,
    }],
  ]);
  const impl = renderImpl("order", [
    {
      verb: "save",
      params: ["OrderDto"],
      output: "void",
      isStatic: false,
      faults: ["timeout"],
      service: "firebase",
    },
  ], {
    async: true,
    module: "checkout",
    nameBinding: bindings["<name>"],
    srvByName,
    sharedSrvNames: new Set(["firebase"]),
  });
  assertStringIncludes(
    impl,
    "service: firebase (transport SDK) — env: FIREBASE_API_KEY, FIREBASE_PROJECT_ID",
  );
  assertStringIncludes(impl, "Firebase callable; charge() idempotent");
  assertStringIncludes(impl, "@see https://firebase.google.com/docs/functions");
  assertStringIncludes(impl, "@throws timeout");
  // Shared service: the adapter imports the core client and constructs it, so
  // the import is used and the dev has it in hand.
  assertStringIncludes(
    impl,
    'import { FirebaseService } from "@/src/core/data/firebase/mod.ts";',
  );
  assertStringIncludes(
    impl,
    "constructor(private readonly firebase = new FirebaseService()) {}",
  );
});

Deno.test("renderImpl — no shared-service import when service is unresolved", () => {
  // A boundary whose [SRV] isn't in srvByName (no core.rune): keep the legacy
  // "no [SRV] declared" doc and emit NO import/constructor (would be unused).
  const impl = renderImpl("order", [
    {
      verb: "save",
      params: ["OrderDto"],
      output: "void",
      isStatic: false,
      faults: [],
      service: "firebase",
    },
  ], { async: true, module: "checkout", nameBinding: bindings["<name>"] });
  assertStringIncludes(impl, "service: firebase (no [SRV] declared)");
  assert(!impl.includes("src/core/data/"));
  assert(!impl.includes("constructor("));
});

Deno.test("renderImpl — multiple services: one import + ctor param each, sorted", () => {
  const srvByName = new Map([
    ["db", {
      transport: "SIDECAR",
      name: "db",
      envVars: ["DB_URL"],
      description: "",
      docsLink: "https://x",
      line: 0,
    }],
    ["ex", {
      transport: "HTTP",
      name: "ex",
      envVars: ["EX_URL"],
      description: "",
      docsLink: "https://y",
      line: 0,
    }],
  ]);
  const impl = renderImpl("task", [
    {
      verb: "save",
      params: ["TaskDto"],
      output: "void",
      isStatic: false,
      faults: [],
      service: "db",
    },
    {
      verb: "notify",
      params: ["TaskDto"],
      output: "void",
      isStatic: false,
      faults: [],
      service: "ex",
    },
  ], {
    async: true,
    module: "tasks",
    nameBinding: bindings["<name>"],
    srvByName,
    sharedSrvNames: new Set(["db", "ex"]),
  });
  assertStringIncludes(
    impl,
    'import { DbService } from "@/src/core/data/db/mod.ts";',
  );
  assertStringIncludes(
    impl,
    'import { ExService } from "@/src/core/data/ex/mod.ts";',
  );
  assertStringIncludes(
    impl,
    "constructor(private readonly db = new DbService(), private readonly ex = new ExService()) {}",
  );
});
