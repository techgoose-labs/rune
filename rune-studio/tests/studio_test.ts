// deno-lint-ignore-file no-explicit-any
// Automated tests for the Rune Studio core libs. Run: `deno task test`.
import { assert, assertEquals } from "@std/assert";
import { parseSpec } from "../lib/parse.ts";
import { generate as engineGenerate } from "../lib/engine.ts";
import { lint, lintAll, lintFiles } from "../lib/lint.ts";

const reg: any = JSON.parse(
  await Deno.readTextFile(new URL("../../keywords.json", import.meta.url)),
);

const EXAMPLE = `[REQ] registerRecording(GetRecordingDto): IdDto
    id::create(providerName, externalId): id
    provider::pick(providerName): provider
      ! not-found
    [PLY] provider.getRecording(externalId): data
        [CSE] genie
        ex:provider.search(externalId): SearchDto
          ! not-found timeout
        [CSE] fiveNine
        ex:provider.fetch(externalId): data
          ! timeout
    [NEW] metadata
    metadata.toDto(): MetadataDto
    db:metadata.set(IdDto, MetadataDto): void
      ! timeout
    id.toDto(): IdDto


[TYP] url: string
    a url
[TYP] providerName: "genie" | "fiveNine"
    name
[TYP] externalId: string
    id
[TYP] data: Uint8Array
    bytes

[DTO] GetRecordingDto: providerName, externalId
    in
[DTO] SearchDto: url(s)
    urls
[DTO] IdDto: providerName, externalId
    id
[DTO] MetadataDto: providerName
    meta
[NON] id
    n
[NON] provider
    n
[NON] metadata
    n
`;

// ---------- parse ----------
Deno.test("parse: requirement steps + faults", () => {
  const m = parseSpec(EXAMPLE, reg);
  const req = m.byTag.req[0];
  assertEquals(req.verb, "register");
  assert(req.steps.length > 0);
  const boundary = req.steps.find((s: any) => s.boundary === "db");
  assert(boundary, "db boundary step captured");
  assert(boundary.faults.includes("timeout"), "fault captured on step");
});

Deno.test("parse: DTO props (array, optional, decl, validator)", () => {
  const m = parseSpec(EXAMPLE, reg);
  const search = m.byTag.dto.find((d: any) => d.name === "SearchDto");
  const urls = search.props[0];
  assertEquals(urls.name, "urls");
  assertEquals(urls.type, "url[]");
  assert(urls.isArray);
  assert(urls.validator.includes("@IsArray"), "array prop gets @IsArray");
});

Deno.test("parse: poly cases linked to interface", () => {
  const m = parseSpec(EXAMPLE, reg);
  assertEquals(m.byTag.ply[0].cases.map((c: any) => c.name), [
    "genie",
    "fiveNine",
  ]);
  const genie = m.byTag.cse.find((c: any) => c.name === "genie");
  assertEquals(genie.noun, "provider");
});

Deno.test("parse: purity from boundary usage", () => {
  const m = parseSpec(EXAMPLE, reg);
  // provider + metadata cross boundaries -> impure; id does not -> pure
  assert(m.impureNouns.includes("provider"));
  assert(m.impureNouns.includes("metadata"));
  assert(!m.impureNouns.includes("id"));
});

Deno.test("parse: [MOD], inline DTO, :core", () => {
  const m = parseSpec(
    `[MOD] billing\n\n[REQ] set({a:x, b:y}): OutDto\n    t.run(a): OutDto\n[NON] t\n  n\n[TYP:core] x: string\n  c\n[DTO] OutDto: x\n  o\n[TYP] y: string\n  d\n`,
    reg,
  );
  assertEquals(m.module, "billing");
  assert(m.byTag.typ.find((t: any) => t.name === "x").isCore, ":core flag set");
});

// ---------- generation (via the shared engine) ----------
Deno.test("engine: hexagonal paths + per-case files", () => {
  const files = engineGenerate(EXAMPLE, reg).map((f) => f.path);
  assert(files.some((p) => p.includes("/domain/coordinators/")));
  assert(
    files.some((p) => p.includes("/implementations/genie/mod.ts")),
  );
  assert(
    files.some((p) => p.includes("/implementations/five-nine/mod.ts")),
  );
  assert(files.some((p) => /\/dto\/.+\.ts$/.test(p)));
});

// ---------- lint ----------
Deno.test("lint: valid example is clean (no spec diagnostics)", () => {
  assertEquals(lint(EXAMPLE, reg).length, 0);
});

Deno.test("lint: catches spec violations", () => {
  const bad =
    `[REQ] doIt(Thing): Result\n    a.run(ghost): Bogus\n[NON] a\n  n\n[DTO] X: y\n  d\n[TYP] y: string\n  t\n`;
  const ids = new Set(lint(bad, reg).map((d) => d.ruleId));
  assert(ids.has("req-input-dto"), "input not a DTO");
  assert(ids.has("req-output-dto"), "output not a DTO");
  assert(
    ids.has("param-scope") || ids.has("undefined-ref"),
    "scope/undefined caught",
  );
});

Deno.test("lint: generated dto-validation passes on real output", () => {
  const gen = lintAll(EXAMPLE, reg).generated.filter((d) =>
    d.ruleId === "dto-validation"
  );
  assertEquals(gen.length, 0);
});

Deno.test("lint: generated import rules catch a bad codegen template", () => {
  const r: any = structuredClone(reg);
  // Inject a relative import into the engine's adapter smoke-test template (a
  // tpl()-honoring role); the generated-code rules (run over engine output)
  // should flag it.
  r.codegen.templates["adapter-smk-test"] =
    'import { x } from "../oops.ts";\nDeno.test("{{step.noun}} — connectivity", () => {});\n';
  const hits = lintAll(EXAMPLE, r).generated.filter((d) =>
    d.ruleId === "import-aliases"
  );
  assert(hits.length > 0, "relative import in generated code flagged");
});

Deno.test("lint: typ-modifier validates constraint modifiers with exact messages", () => {
  const spec = `[TYP:uuid] id: string\n    a uuid\n` +
    `[TYP:fancy] a: string\n    bad\n` +
    `[TYP:uuid] n: number\n    wrong base\n` +
    `[TYP:min] qty: number\n    missing value\n` +
    `[TYP:int=3] count: number\n    stray value\n`;
  const hits = lint(spec, reg).filter((d) => d.ruleId === "typ-modifier");
  const messages = hits.map((d) => d.message);
  assert(
    messages.includes(
      '[TYP] unknown modifier "fancy" (allowed: ext, core, uuid, email, url, nonempty, json, int, min=<n>, max=<n>, positive, example=<value>)',
    ),
    "unknown modifier flagged",
  );
  assert(
    messages.includes(
      '[TYP] modifier "uuid" requires a string type, but "n" is number',
    ),
    "wrong base flagged",
  );
  assert(
    messages.includes(
      '[TYP] modifier "min" requires a numeric value (e.g. min=0)',
    ),
    "missing value flagged",
  );
  assert(
    messages.includes('[TYP] modifier "int" does not take a value'),
    "stray value flagged",
  );
  // the valid declaration produces no diagnostic
  assert(!hits.some((d) => d.line === 1), "valid [TYP:uuid] is clean");
});

Deno.test("lint: typ-modifier accepts composed + valued modifiers", () => {
  const spec = `[TYP:ext,uuid] id: string\n    external uuid\n` +
    `[TYP:min=0,max=100] qty: number\n    bounded\n`;
  assertEquals(lint(spec, reg).filter((d) => d.ruleId === "typ-modifier"), []);
});

Deno.test("lint: no-dto-cast flags a coordinator DTO cast in generated files", () => {
  const files = [
    {
      path: "src/app/domain/coordinators/place/mod.ts",
      content: "const order = load() as OrderDto;\n",
    },
    {
      path: "src/app/domain/business/cart/mod.ts",
      content: "const x = y as OtherDto;\n", // not a coordinator — ignored
    },
  ];
  const hits = lintFiles(files, reg, { byTag: {} }).filter((d: any) =>
    d.ruleId === "no-dto-cast"
  );
  assertEquals(hits.length, 1);
  assertEquals(
    hits[0].message,
    'coordinator casts to "OrderDto" — validate the seam with assert(OrderDto, ...) instead of a blind cast',
  );
});

Deno.test("lint: filesystem rules over a file list (forbidden-dirs, module-fragmentation)", () => {
  const files = [
    { path: "src/app/lib/x.ts", content: "export const x = 1;" },
    { path: "src/tiny/domain/business/a/mod.ts", content: "export class A {}" },
  ];
  const ids = new Set(
    lintFiles(files, reg, { byTag: {} }).map((d: any) => d.ruleId),
  );
  assert(ids.has("forbidden-dirs"), "lib/ dir flagged");
  assert(ids.has("module-fragmentation"), "tiny module flagged");
});
