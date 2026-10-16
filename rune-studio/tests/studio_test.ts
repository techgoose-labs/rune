// deno-lint-ignore-file no-explicit-any
// The Rune Studio's engine door (REQ-035). Run: `deno task test`.
import { assert, assertEquals } from "@std/assert";
import {
  check,
  generate as engineGenerate,
  lintGenerated,
  reqCount,
  ruleTypes,
} from "../lib/engine.ts";

const reg: any = JSON.parse(
  await Deno.readTextFile(new URL("../../lang/keywords.json", import.meta.url)),
);

const EXAMPLE = `[REQ] registerRecording(GetRecordingDto): IdDto
    id::create(providerName, externalId): id
    provider::pick(providerName): provider
      ! not-found
    [PLY] provider.getRecording(externalId): data
        [CSE] genie
        ex:provider.search(externalId): SearchDto
          ! not-found timeout
        ex:provider.download(urls): data
        [CSE] fiveNine
        ex:provider.fetch(externalId): data
          ! timeout
    [NEW] metadata
    metadata.toDto(): MetadataDto
    id.toDto(): IdDto
    db:metadata.set(IdDto, MetadataDto): void
      ! timeout
    [RET] IdDto


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

// ---------- parse + check (the grammar wasm, through the engine) ----------
Deno.test("REQ-035: the studio parses and checks through the engine", async () => {
  // A clean spec: no findings, and the engine's AST counts its requirements.
  assertEquals(check(EXAMPLE, reg), []);
  assertEquals(reqCount(EXAMPLE), 1);
  // A broken spec: the engine's findings, with the registry's ids and messages.
  const broken = EXAMPLE.replace("      ! not-found\n", "      not-found\n").replace(
    "[TYP] url: string",
    "[TYP] url",
  );
  const diags = check(broken, reg);
  const ids = diags.map((d) => `${d.line}:${d.ruleId}`);
  assert(ids.includes("4:fault-marker"), ids.join(" "));
  assert(ids.includes("21:typ-type"), ids.join(" "));
  const marker = diags.find((d) => d.ruleId === "fault-marker")!;
  assertEquals(marker.severity, "error");
  assertEquals(marker.fix, "prefix the line with `! ` (`rune fmt` does this)");
  // The generated-code rules run over the engine's own output in memory.
  const files = engineGenerate(EXAMPLE, reg);
  assert(files.some((f) => f.path === "src/spec/domain/coordinators/recording-register/mod.ts"), files.map((f) => f.path).join("\n"));
  // (A standalone studio spec has no core.rune, so the service-presence rule
  // rightly asks for one; everything else is clean.)
  const gen = await lintGenerated([...files, { path: "specs/spec.rune", content: EXAMPLE }], reg);
  assertEquals(gen.filter((d) => d.severity === "error" && d.ruleId !== "rune-service-presence"), []);
  // A template that emits a relative import is caught by the same rules `rune lint` runs.
  const bad = structuredClone(reg);
  bad.codegen.templates["adapter-smk-test"] = 'import { x } from "../oops.ts";\n' +
    bad.codegen.templates["adapter-smk-test"];
  const badFiles = engineGenerate(EXAMPLE, bad);
  const badGen = await lintGenerated([...badFiles, { path: "specs/spec.rune", content: EXAMPLE }], bad);
  assert(badGen.some((d) => d.ruleId === "import-aliases"), badGen.map((d) => d.ruleId).join(" "));
});

Deno.test("engine: hexagonal paths + per-case files", () => {
  const files = engineGenerate(EXAMPLE, reg);
  const paths = files.map((f) => f.path);
  for (
    const p of [
      "src/spec/domain/coordinators/recording-register/mod.ts",
      "src/spec/domain/business/provider/base/mod.ts",
      "src/spec/domain/business/provider/implementations/genie/mod.ts",
      "src/spec/domain/business/provider/implementations/five-nine/mod.ts",
      "src/spec/domain/data/provider/mod.ts",
      "src/spec/dto/get-recording.ts",
      "src/spec/dto/faults.ts",
    ]
  ) {
    assert(paths.includes(p), `missing ${p} in\n${paths.join("\n")}`);
  }
});

Deno.test("engine: the rule editor's types are the registry's generated-code rule types", () => {
  const types = ruleTypes(reg);
  assert(types.includes("no-relative-import"));
  assert(types.includes("layer-restrictions"));
  assertEquals(types.includes("max-line-length"), false, "spec rules are the engine's, not toggles");
});
