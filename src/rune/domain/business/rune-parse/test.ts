import { assert, assertEquals, assertExists } from "#std/assert";
import { EMITS, parse } from "./mod.ts";

const ids = (text: string) => parse(text).errors.map((e) => `${e.line + 1}:${e.id}`);

Deno.test("parse — empty string yields empty AST", () => {
  const ast = parse("");
  assertEquals(ast.module, null);
  assertEquals(ast.reqs, []);
  assertEquals(ast.dtos, []);
  assertEquals(ast.errors, []);
});

Deno.test("parse — [MOD] sets module name, with an optional description", () => {
  assertEquals(parse("[MOD] recording").module, "recording");
  const ast = parse("[MOD] recording: the recordings module\n    and more prose");
  assertEquals(ast.module, "recording");
  assertEquals(ast.moduleDescription, "the recordings module and more prose");
  assertEquals(ast.errors, []);
});

Deno.test("parse — duplicate [MOD] is mod-duplicate", () => {
  const ast = parse("[MOD] one\n[MOD] two");
  assertEquals(ast.module, "one");
  assertEquals(ids("[MOD] one\n[MOD] two"), ["2:mod-duplicate"]);
  assertEquals(ast.errors[0].message, 'duplicate [MOD]: already set to "one"');
});

Deno.test("parse — [MOD] accepts kebab-case; a digit-leading or punctuated name is mod-name-shape", () => {
  assertEquals(parse("[MOD] user-api").errors, []);
  assertEquals(ids("[MOD] 2module"), ["1:mod-name-shape"]);
  assertEquals(ids('[MOD] my"module'), ["1:mod-name-shape"]);
  assertEquals(ids("[MOD]"), ["1:mod-name"]);
});

Deno.test("parse — bare [REQ]", () => {
  const ast = parse("[REQ] recording.set(GetRecordingDto): RecordingSetResponseDto");
  assertEquals(ast.reqs.length, 1);
  assertEquals(ast.reqs[0].noun, "recording");
  assertEquals(ast.reqs[0].verb, "set");
  assertEquals(ast.reqs[0].input, "GetRecordingDto");
  assertEquals(ast.reqs[0].output, "RecordingSetResponseDto");
  assertEquals(ast.reqs[0].isOpen, false);
});

Deno.test("parse — [REQ:core] and an unknown [REQ] modifier are findings; the [REQ] still parses", () => {
  const core = parse("[REQ:core] a.b(InDto): OutDto\n    x::y(InDto): OutDto");
  assertEquals(core.errors.map((e) => e.id), ["req-core"]);
  assertEquals(core.reqs.length, 1, "the requirement is kept so its steps do not cascade");
  const unknown = parse("[REQ:public] a.b(InDto): OutDto");
  assertEquals(unknown.errors.map((e) => e.id), ["req-modifier"]);
  assertEquals(unknown.errors[0].message, '[REQ] unknown modifier "public" — the only one is :open');
});

Deno.test("parse — [REQ:open] is the openness marker", () => {
  const ast = parse("[REQ:open] health.check({}): HealthDto");
  assertEquals(ast.errors, []);
  assertEquals(ast.reqs[0].isOpen, true);
  assertEquals(ast.reqs[0].input, "{}");
});

Deno.test("parse — a malformed [REQ] names the tag's syntax", () => {
  const ast = parse("[REQ] this is not a valid signature");
  assertEquals(ast.errors.map((e) => e.id), ["req-signature"]);
  assert(ast.errors[0].message.includes("[REQ] noun.verb(InputDto): OutputDto"), ast.errors[0].message);
});

Deno.test("parse — steps, boundary steps and the service prefix", () => {
  const ast = parse(`[REQ] a.b(InDto): OutDto
    id::create(name): id
    provider.get(id): data
    db:store.save(OutDto): void
    Noun::stat(): x`);
  assertEquals(ast.errors, []);
  const [s1, s2, s3, s4] = ast.reqs[0].steps;
  assertEquals(s1, { kind: "step", noun: "id", verb: "create", params: ["name"], output: "id", isStatic: true, faults: [], line: 1 });
  assertEquals(s2.kind === "step" && s2.isStatic, false);
  assertEquals(s3.kind === "boundary" && s3.service, "db");
  assertEquals(s4.kind === "step" && s4.isStatic, true);
});

Deno.test("REQ-018: a fault line is `! name name`; a custom fault carries its status", () => {
  const ast = parse(`[REQ] a.b(InDto): OutDto
    db:store.save(InDto): OutDto
      ! timeout network-error
      ! card-expired=402
    x::y(OutDto): OutDto
      ! not-found`);
  assertEquals(ast.errors, []);
  const first = ast.reqs[0].steps[0];
  assertEquals(first.kind === "boundary" && first.faults, ["timeout", "network-error", "card-expired"]);
  assertEquals(ast.faultStatuses, { "card-expired": 402 });
  // Indentation is cosmetic: a fault at any column belongs to the step above it.
  const flat = parse("[REQ] a.b(InDto): OutDto\n    x::y(InDto): OutDto\n! timeout");
  assertEquals(flat.errors, []);
  assertEquals(flat.reqs[0].steps[0].kind === "step" && flat.reqs[0].steps[0].faults, ["timeout"]);
  // A pre-marker bare fault line is a finding with the rewrite as its fix.
  const bare = parse("[REQ] a.b(InDto): OutDto\n    x::y(InDto): OutDto\n      timeout network-error");
  assertEquals(bare.errors.map((e) => e.id), ["fault-marker"]);
  assertEquals(bare.errors[0].fix, "prefix the line with `! ` (`rune fmt` does this)");
  // A fault before any step, and a name that is not a slug.
  assertEquals(ids("[REQ] a.b(InDto): OutDto\n    ! timeout"), ["2:fault-outside-step"]);
  assertEquals(ids("[REQ] a.b(InDto): OutDto\n    x::y(InDto): OutDto\n      ! Timeout"), ["3:fault-shape"]);
});

Deno.test("REQ-020: a step names its value with `as`", () => {
  const ast = parse("[REQ] a.b(InDto): OutDto\n    db:task.load(id): TaskDto as stored\n    task::fromDto(stored): task as t");
  assertEquals(ast.errors, []);
  const [s1, s2] = ast.reqs[0].steps;
  assertEquals(s1.kind === "boundary" && s1.output, "TaskDto");
  assertEquals(s1.kind === "boundary" && s1.valueName, "stored");
  assertEquals(s2.kind === "step" && s2.valueName, "t");
});

Deno.test("parse — [SRV] declares transport + name + env vars + description + @docs", () => {
  const ast = parse(`[SRV] (SIDECAR)db: DB_URL, DB_POOL
    the primary datastore
    @docs https://docs.example.com/db
[SRV] (NATIVE)fs
    the filesystem
    @docs https://docs.example.com/fs`);
  assertEquals(ast.errors, []);
  assertEquals(ast.srvs[0], { transport: "SIDECAR", name: "db", envVars: ["DB_URL", "DB_POOL"], description: "the primary datastore", docsLink: "https://docs.example.com/db", line: 0 });
  assertEquals(ast.srvs[1].envVars, []);
});

Deno.test("parse — [SRV] findings: unknown transport, missing/empty/duplicate @docs, malformed", () => {
  const unknown = parse("[SRV] (CARRIER)db: X\n    d\n    @docs https://x");
  assertEquals(unknown.errors.map((e) => e.id), ["srv-transport"]);
  assertEquals(unknown.errors[0].message, '[SRV] unknown transport "CARRIER" — expected SDK/HTTP/WEBSOCKET/SIDECAR/NATIVE');
  assertEquals(ids("[SRV] (HTTP)ex: X\n    d"), ["1:srv-docs-required"]);
  assertEquals(ids("[SRV] (HTTP)ex: X\n    d\n    @docs"), ["1:srv-docs-required", "3:srv-docs-url"]);
  assertEquals(ids("[SRV] (HTTP)ex: X\n    d\n    @docs https://a\n    @docs https://b"), ["4:srv-docs-duplicate"]);
  assertEquals(ids("[SRV] db: X"), ["1:srv-shape"]);
});

Deno.test("parse — @docs under a [DTO] stays plain prose (SRV-only)", () => {
  const ast = parse("[DTO] XDto: a\n    see\n    @docs https://x\n[TYP] a: string\n    a");
  assertEquals(ast.errors, []);
  assertEquals(ast.dtos[0].description, "see @docs https://x");
});

Deno.test("parse — [PLY] with two [CSE] cases; a case step past the block closes it", () => {
  const ast = parse(`[REQ] a.b(InDto): OutDto
    [PLY] provider.get(x): data
        [CSE] genie
        ex:provider.search(x): SearchDto
          ! not-found
        [CSE] fiveNine
        ex:provider.search(x): SearchDto
    [NEW] metadata
    metadata.toDto(): OutDto`);
  assertEquals(ast.errors, []);
  const ply = ast.reqs[0].steps[0];
  assert(ply.kind === "ply");
  assertEquals(ply.cases.map((c) => c.name), ["genie", "fiveNine"]);
  assertEquals(ply.cases[0].steps.length, 1);
  assertEquals(ply.cases[0].steps[0].kind === "boundary" && ply.cases[0].steps[0].faults, ["not-found"]);
  assertEquals(ast.reqs[0].steps.map((s) => s.kind), ["ply", "ctr", "step"]);
});

Deno.test("parse — [CSE] outside a [PLY], a nested [PLY], a [PLY] with no signature", () => {
  assertEquals(ids("[REQ] a.b(I): O\n    [CSE] stray"), ["2:cse-outside-ply"]);
  assertEquals(ids("[REQ] a.b(I): O\n    [PLY] p.get(x): d\n        [CSE] a\n        [PLY] q.open(x): d"), ["4:ply-nested"]);
  assertEquals(ids("[REQ] a.b(I): O\n    [PLY] nonsense"), ["2:ply-signature"]);
});

Deno.test("REQ-021: [CTR] is retired with a fix; [NEW] stays", () => {
  const ast = parse("[REQ] a.b(I): O\n    [CTR] metadata\n    [NEW] storage");
  assertEquals(ast.errors.map((e) => `${e.line + 1}:${e.id}`), ["2:ctr-retired"]);
  assertEquals(ast.errors[0].message, "[CTR] is retired — write `[NEW] metadata`");
  assertEquals(ast.reqs[0].steps, [{ kind: "ctr", className: "storage", line: 2 }]);
  assertEquals(ids("[REQ] a.b(I): O\n    [NEW]"), ["2:new-name"]);
});

Deno.test("parse — [RET] step, and [RET] with no value", () => {
  const ast = parse("[REQ] a.b(I): O\n    x::y(I): O\n    [RET] O");
  assertEquals(ast.reqs[0].steps[1], { kind: "ret", value: "O", line: 2 });
  assertEquals(ids("[REQ] a.b(I): O\n    [RET]"), ["2:ret-value"]);
});

Deno.test("parse — [DTO] with description; :core, :open; a typo'd modifier; missing props", () => {
  const ast = parse("[DTO] GetRecordingDto: providerName, externalId\n    input for retrieving\n    a recording\n[TYP] providerName: string\n    p\n[TYP] externalId: string\n    e");
  assertEquals(ast.errors, []);
  assertEquals(ast.dtos[0].properties, ["providerName", "externalId"]);
  assertEquals(ast.dtos[0].description, "input for retrieving a recording");
  assertEquals(parse("[DTO:core] XDto: a\n    d\n[TYP] a: string\n    a").dtos[0].isCore, true);
  assertEquals(parse("[DTO:open] XDto: a\n    d\n[TYP] a: string\n    a").dtos[0].isOpen, true);
  assertEquals(ids("[DTO:opne] XDto: a\n    d\n[TYP] a: string\n    a"), ["1:dto-modifier"]);
  const missing = parse("[DTO] FooDto\n    a DTO declaration with no properties");
  assertEquals(missing.errors.map((e) => e.id), ["dto-props"], "the prose under a malformed declaration does not cascade");
});

Deno.test("parse — a [DTO] property with no [TYP] or [DTO] is dto-prop-undefined with a fix", () => {
  const ast = parse("[DTO] ThingDto: id, extra\n    a thing\n[TYP] id: string\n    an id");
  assertEquals(ast.errors.map((e) => e.id), ["dto-prop-undefined"]);
  assertEquals(ast.errors[0].fix, "declare `[TYP] extra: <type>`");
  // `(s)`, `(s?)`, `?` and a nested DTO by convention all resolve.
  assertEquals(parse("[DTO] ADto: url(s), tag(s?), note?, b\n    a\n[DTO] BDto: url\n    b\n[TYP] url: string\n    u\n[TYP] tag: string\n    t\n[TYP] note: string\n    n").errors, []);
});

Deno.test("parse — [TYP] with description, modifiers in source order, missing type", () => {
  const ast = parse("[TYP] storage: string\n    a class representing\n    the storage\n[TYP:ext,uuid] memberId: string\n    m\n[TYP:min=0,max=100] qty: number\n    q\n[TYP:core,nonempty] name: string\n    n");
  assertEquals(ast.errors, []);
  assertEquals(ast.typs[0].description, "a class representing the storage");
  assertEquals(ast.typs[1].modifiers, ["ext", "uuid"]);
  assertEquals(ast.typs[1].isExternal, true);
  assertEquals(ast.typs[2].modifiers, ["min=0", "max=100"]);
  assertEquals(ast.typs[3].isCore, true);
  assertEquals(ids("[TYP] price\n    a type with no primitive"), ["1:typ-type"]);
});

Deno.test("parse — [TYP] modifier findings carry their own ids and registry messages", () => {
  const unknown = parse("[TYP:bogus] id: string\n    d");
  assertEquals(unknown.errors.map((e) => e.id), ["typ-modifier-unknown"]);
  assert(unknown.errors[0].message.startsWith('[TYP] unknown modifier "bogus" (allowed: core, ext, uuid'), unknown.errors[0].message);
  const base = parse("[TYP:uuid] count: number\n    d");
  assertEquals(base.errors[0].id, "typ-modifier-base");
  assertEquals(base.errors[0].message, '[TYP] modifier "uuid" requires a string type, but "count" is number');
  assertEquals(parse("[TYP:min] qty: number\n    d").errors[0].message, '[TYP] modifier "min" requires a numeric value (e.g. min=0)');
  assertEquals(parse("[TYP:min=x] qty: number\n    d").errors[0].id, "typ-modifier-value");
  assertEquals(parse("[TYP:uuid=1] id: string\n    d").errors[0].message, '[TYP] modifier "uuid" does not take a value');
  assertEquals(parse("[TYP:from=body] q: string\n    d").errors[0].message, '[TYP] modifier "from" must be one of query, header (got "body")');
  assertEquals(parse("[TYP:example] q: string\n    d").errors[0].id, "typ-modifier-value");
  // A text value may carry spaces.
  assertEquals(parse("[TYP:example=Buy groceries] title: string\n    t").typs[0].modifiers, ["example=Buy groceries"]);
});

Deno.test("REQ-021: [TYP:from=path] and `[TYP] x: Class` are retired with fixes", () => {
  const from = parse("[TYP:from=path] target: string\n    t");
  assertEquals(from.errors.map((e) => e.id), ["from-path-retired"]);
  assert(from.errors[0].fix!.includes("{target}"), from.errors[0].fix);
  assertEquals(from.typs[0].modifiers, []);
  const cls = parse("[TYP] task: Class\n    a task");
  assertEquals(cls.errors.map((e) => e.id), ["class-retired"]);
  assertEquals(cls.errors[0].fix, "replace it with `[NON] task` and a description");
});

Deno.test("parse — a blank line ends a description; [NON] with description", () => {
  const ast = parse("[TYP] a: string\n    first\n\n    not part of it\n[NON] storage\n    the storage\n    system");
  assertEquals(ast.typs[0].description, "first");
  assertEquals(ast.errors.map((e) => e.id), ["unrecognized-line"]);
  assertEquals(ast.nons[0], { name: "storage", description: "the storage system", line: 4 });
  assertEquals(ids("[NON]\n    a noun with no name"), ["1:non-name"]);
});

Deno.test("parse — descriptions are free text (periods, @, parentheticals, uppercase, code-like words)", () => {
  const ast = parse("[DTO] FragmentDto: service\n    One tier's fragment, posted to the collector (e.g. web, backend).\n    Mail rafac@example.com; note(s) are kept.\n[TYP] service: string\n    s");
  assertEquals(ast.errors, []);
  assertEquals(ast.dtos[0].description, "One tier's fragment, posted to the collector (e.g. web, backend). Mail rafac@example.com; note(s) are kept.");
});

Deno.test("REQ-019: [ENT] with its body [REQ]; a body with a modifier or a bad signature", () => {
  const ast = parse("[ENT] http.postRecording(GetRecordingDto): IdDto\n    [REQ] recording.set(GetRecordingDto): IdDto\n[REQ] recording.set(GetRecordingDto): IdDto\n    x::y(GetRecordingDto): IdDto");
  assertEquals(ast.errors, []);
  assertEquals(ast.ents[0].delegate, { noun: "recording", verb: "set" });
  assertEquals(ast.reqs.length, 1, "the body [REQ] is a reference, not a second requirement");
  assertEquals(ids("[ENT] http.a(I): O\n    [REQ:open] a.b(I): O"), ["2:ent-body-modifier"]);
  assertEquals(ids("[ENT] http.a(I): O\n    [REQ] nonsense"), ["2:ent-body-signature"]);
  assertEquals(ids("[ENT] nonsense"), ["1:ent-signature"]);
});

Deno.test("parse — [ENT] @ METHOD /template; a bad method", () => {
  const ast = parse("[ENT] http.getTask @ GET /tasks/{id}(TaskRefDto): TaskDto\n    [REQ] task.get(TaskRefDto): TaskDto");
  assertEquals(ast.errors, []);
  assertEquals(ast.ents[0].method, "get");
  assertEquals(ast.ents[0].pathTemplate, "/tasks/{id}");
  assertEquals(ids("[ENT] http.a @ FETCH /x(I): O"), ["1:ent-method"]);
  assertEquals(parse("[ENT:card] http.pay(PayDto): PaymentDto").ents[0].modifier, "card");
});

Deno.test("parse — [ENT:ws] socket header + topics with their body [REQ]s", () => {
  const ast = parse(`[MOD] chat
[ENT:ws] chat @ /rooms/{room}
    join(JoinDto): JoinedDto
        [REQ] room.join(JoinDto): JoinedDto
    leave(): void
[ENT] http.ping({}): PongDto`);
  assertEquals(ast.errors, []);
  assertEquals(ast.ents.length, 3);
  assertEquals(ast.ents[0], { surface: "chat", action: "join", input: "JoinDto", output: "JoinedDto", modifier: null, line: 2, method: null, pathTemplate: "/rooms/{room}", kind: "ws", delegate: { noun: "room", verb: "join" } });
  assertEquals(ast.ents[1].input, "");
  assertEquals(ast.ents[2].kind, undefined);
  assertEquals(parse("[ENT:ws] chat\n    join(JoinDto): JoinedDto").ents[0].pathTemplate, null);
});

Deno.test("parse — [ENT:ws] findings: no topics (dedent and EOF), a malformed topic, a header with a signature", () => {
  assertEquals(ids("[ENT:ws] chat @ /r\n[DTO] XDto: a\n    d\n[TYP] a: string\n    a"), ["1:ws-no-topics"]);
  assertEquals(ids("[ENT:ws] chat @ /r"), ["1:ws-no-topics"]);
  assertEquals(ids("[ENT:ws] chat @ /r\n    notavalidtopic"), ["1:ws-no-topics", "2:ws-topic-shape"]);
  assertEquals(ids("[ENT:ws] chat.send(ChatDto): EchoDto"), ["1:ws-header-signature"]);
});

Deno.test("parse — comments are stripped, pure-comment lines ignored, URLs survive", () => {
  const ast = parse("// header\n[REQ] a.b(I): O // trailing\n    // inside\n    x::y(I): O\n[SRV] (HTTP)ex: X\n    d\n    @docs https://docs.example.com/ex");
  assertEquals(ast.errors, []);
  assertEquals(ast.reqs[0].steps.length, 1);
  assertEquals(ast.srvs[0].docsLink, "https://docs.example.com/ex");
});

Deno.test("parse — a step outside a [REQ], and an unrecognized line", () => {
  assertEquals(ids("[RET] FooDto"), ["1:step-outside-req"]);
  assertEquals(ids("x::y(I): O"), ["1:step-outside-req"]);
  const ast = parse("this is nothing");
  assertEquals(ast.errors.map((e) => e.id), ["unrecognized-line"]);
  assertEquals(ast.errors[0].message, 'unrecognized line: "this is nothing"');
});

Deno.test("REQ-015: a line over 80 characters is a line-length finding", () => {
  const long = `[TYP] ${"x".repeat(90)}: string\n    d`;
  const ast = parse(long);
  assertEquals(ast.errors.map((e) => e.id), ["line-length"]);
  assertEquals(ast.errors[0].message, "line exceeds 80 characters (104)");
});

Deno.test("REQ-013: parse errors carry a stable registry id", () => {
  for (const e of parse("[MOD] one\n[MOD] two\n[TYP] price\n    d").errors) {
    assert((EMITS as readonly string[]).includes(e.id), e.id);
  }
});

Deno.test("REQ-031: the engine parses through the grammar wasm and the valid corpus lowers with no findings", async () => {
  const dir = new URL("../../../../../fixtures/corpus/valid/", import.meta.url);
  let n = 0;
  for await (const e of Deno.readDir(dir)) {
    if (!e.name.endsWith(".rune")) continue;
    n++;
    const ast = parse(await Deno.readTextFile(new URL(e.name, dir)));
    assertEquals(ast.errors, [], e.name);
  }
  assert(n > 15, "the corpus is there");
  // Multi-line parameter lists are one step (the grammar spans rows; the lowering follows).
  const multi = parse("[REQ] a.b(I): O\n    x::y(\n      I,\n      J\n    ): O");
  assertEquals(multi.errors, []);
  assertEquals(multi.reqs[0].steps[0].kind === "step" && multi.reqs[0].steps[0].params, ["I", "J"]);
});

Deno.test("REQ-034: a malformed line yields an id'd finding from its shape", () => {
  // The tag it opens with maps to that tag's shape rule, with the tag's syntax.
  const cases: [string, string, string][] = [
    ["[REQ] nope", "req-signature", "[REQ] noun.verb(InputDto): OutputDto"],
    ["[ENT] nope", "ent-signature", "[ENT] surface.action(InputDto): OutputDto"],
    ["[DTO] FooDto", "dto-props", "[DTO] NameDto: prop1, prop2"],
    ["[TYP] price", "typ-type", "[TYP:mod,mod] name: primitive"],
    ["[NON]", "non-name", "[NON] noun"],
    ["[REQ] a.b(I): O\n    [PLY] nope", "ply-signature", "[PLY] noun.verb(args): type"],
    ["[REQ] a.b(I): O\n    [CSE]", "cse-name", "[CSE] caseName"],
    ["[REQ] a.b(I): O\n    [NEW]", "new-name", "[NEW] noun"],
    ["[REQ] a.b(I): O\n    [RET]", "ret-value", "[RET] value"],
    ["[SRV] nope", "srv-shape", "(TRANSPORT)<name>"],
  ];
  for (const [text, id, syntax] of cases) {
    const errs = parse(text).errors;
    assertExists(errs.find((e) => e.id === id), `${text} → ${id}, got ${errs.map((e) => e.id)}`);
    assert(errs.find((e) => e.id === id)!.message.includes(syntax), errs.find((e) => e.id === id)!.message);
  }
  // A tag nobody knows, and a retired one.
  assertEquals(ids("[XYZ] thing"), ["1:unrecognized-line"]);
  assertEquals(ids("[REQ] a.b(I): O\n    [CTR] x"), ["2:ctr-retired"]);
});
