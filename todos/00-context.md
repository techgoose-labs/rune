# Shared context — read before your task file

You are working across one or both of these local repos:

- **keep** — `/Users/raphaelcastro/Documents/programming/rune/keep`. A Deno backend framework
  (`@techgoose-labs/rune` on JSR, built on `@danet/core`): DI bootstrap, auth, auto Swagger docs,
  an in-process API client, and a per-module **cake** UI. Main branch: `main`.
- **rune** — `/Users/raphaelcastro/Documents/programming/rune`. A DSL toolchain: you write a
  small `.rune` spec; `rune sync` generates a typed Deno/TS module whose HTTP entrypoints are
  keep controllers. Branch: `develop`. Run the CLI from the repo as
  `deno run -A src/bootstrap/mod.ts <cmd> [args]` (commands: `check`, `sync`, `manifest`,
  `lint`, `validate`).

## How the two repos connect (the contract)

`rune sync` generates entrypoint controllers that use keep's `@Endpoint` decorator. The
decorator stamps **process metadata** onto each endpoint, which travels in the module's OpenAPI
doc as the `x-keep-process` vendor extension. Both keep's cake UI and its headless runner
consume it. The metadata (defined in keep `src/foundation/domain/business/endpoint-decorator/mod.ts`,
type `ProcessMetadata`; spec-side view in `src/foundation/domain/business/endpoint-spec/mod.ts`,
type `SpecEndpoint`):

- `order: number` — process position (ascending).
- `dependsOn: string[]` — endpoint ids (handler method names) that must succeed first.
- `bind: Record<string, string | string[]>` — request autofill wiring. Three value forms:
  - `"otherEndpointId.outputField"` — fill from a captured response;
  - `"$name"` — an **external input** nothing in the module produces (cake shows it under a
    "Module inputs" card; the headless runner reads `overrides.seeds[name]`);
  - an array — alternatives, first-resolvable-wins (the join after a branch).
- `flows: string[]` — named branches. Untagged endpoints belong to every flow; within an active
  flow, dependencies on endpoints outside it don't gate.
- `optional: boolean` — attempted but never blocks a run.

Rune derives all of this from the spec: `[ENT:card]` → `flows: ["card"]`, `[ENT:optional]` →
`optional: true`, `[TYP:ext] name` → `bind: {name: "$name"}` for unproduced fields, and
same-named output→input DTO fields → `dependsOn`/`bind` edges (producers in different flows →
OR-bind arrays).

## keep — what you need to know

- Run things from the repo root. Tasks: `deno task test` (unit suite), `deno task test:browser`
  (headless-chromium cake tests; needs `deno run -A npm:playwright install chromium chromium-headless-shell`
  once), `KEEP_BROWSER=1 deno task test:e2e` (the cake + checkout fixtures, browser stages
  included), `deno task test:e2e:checkout`, `deno task check:jsr` (publish dry-run).
  Quality bars: `deno fmt --check src/`, `deno lint <touched dirs>`.
- **The cake UI** lives in `src/foundation/domain/business/emulator-ui/`:
  - `mod.ts` assembles a self-contained HTML page per module (`emulatorShellHtml(title, doc)`),
    inlining a JSON payload as `window.__KEEP_EMULATOR__` (with `<` escaped to `<`).
  - `client.ts` exports the CSS and client JS as **`String.raw` template strings**. HARD RULE:
    no backtick and no `${` may appear inside those strings — they would terminate/interpolate
    the literal. Client code uses string concatenation, ES5-flavored, `var`/`function`.
  - Client state: per-page session in `localStorage["keep:cake:" + pagePath]` (statuses,
    captured outputs, edited bodies, expanded set); a **shared scope** in
    `localStorage["keep:cake:globals"]` (`{v:1, vars:{...}, captured:{"module:endpointId": {...}}}`)
    written on every successful run and read cross-page; a `storage` event listener live-updates
    other tabs. Reference resolution in bodies: `{{step.field}}` (page captures), `{{name}}`
    (shared vars), `{{$name}}` (declared module input), `{{module:step.field}}` (another
    module's capture), `{{a || b}}` (alternatives); resolution is recursive, depth-capped.
  - DOM/selector contract relied on by tests — do not rename: `ul#app > li[data-id]`,
    `button.emulate`, `.dot.ok/.fail`, `.path`, `.resolved`, `.curl`, `textarea`, `#runall`,
    `#banner` (classes `err|ok|info`), `#flows button[data-flow]`, `#inputs-card`,
    `#inputs input[data-gvar]`, `#vars`, `li.offflow` (hidden by flow filter).
- **Route registration** happens in `src/foundation/domain/coordinators/bootstrap-server/mod.ts`
  (`BootstrapServer.create`): a loop over `docs` (ALL modules' OpenAPI docs are in scope there)
  registers `/docs/<module>` (cake), `/docs/<module>/swagger`, `/docs/<module>/json`, plus
  `/docs` (index) — via `adapter.registerRoute(method, path, handler)`. Module doc paths come
  from the danet module class name lowercased without the `Module` suffix.
- **The headless runner** `exerciseEndpoints` lives in
  `src/foundation/domain/coordinators/exercise-harness/mod.ts`: flattens ALL module docs
  (`opts.api.docs.flatMap(endpointsFromDoc)`), optionally filters by `opts.flow`, orders with
  `processOrder` (topological; `order` tie-break), then loops until green. `buildValues`
  assembles each request: `overrides.seeds` by field name → `bind` resolution (`$name` →
  `seeds[name]`; arrays first-hit-wins) → `overrides.byEndpoint` wins last. Report:
  `{passed, failed, optionalFailed, iterations, order, cycles}` — `failed` excludes optional.
- **e2e fixtures**: `e2e/cake` (linear 6-step chain) and `e2e/checkout` (flows card/cash,
  OR-join, `$memberId` external input, optional survey step). Each has its own `deno.json`
  that maps `@techgoose-labs/rune` to the LOCAL checkout (`../../src/bootstrap/mod.ts`). They are
  rune-generated (spec committed at `e2e/<name>/src/<name>/<name>.rune`); coordinator bodies are
  dev-owned and hand-filled with deterministic values.

## rune — what you need to know

- Tests: `deno test -A src/rune/domain/business/<module>/` per module. Full gate:
  `deno run -A scripts/verify.ts` — **5 gates (L1–L4, L6) already fail on clean `develop`**;
  the bar is "no NEW failures", established by stashing your changes and comparing.
- Parser of record: `src/rune/domain/business/rune-parse/mod.ts` (`parse`: text → AST). Node
  shapes: `EntNode {surface, action, input, output, modifier, line}`,
  `TypNode {name, typeName, description, isCore, isExternal, line}`, `DtoNode {name, properties, ...}`.
  Bracket modifiers (`[TAG:modifier]`) parse for req/ent/dto/typ/non.
- Codegen: `src/rune/domain/business/rune-manifest/mod.ts`. Key functions: `planManifest`
  (entry; builds `dtoByName`, `externalTypes`, calls `computeEntProcess(ents, dtoByName, externalTypes)`,
  groups ents by surface, calls `addEntrypointSurface`), `computeEntProcess` (derives
  order/dependsOn/bind/flows/optional from the DTO field graph), `renderEntrypointController`
  (emits the keep controller), `renderEntrypointE2e` (emits the per-surface e2e test),
  `dtoFieldNames(dto)` (generated field names: strips `(s)`/`?`, pluralizes arrays).
  Entrypoint `mod.ts` and `e2e.test.ts` are **create-once** (dev-owned, only written if absent).
- Sync CLI: `src/rune/entrypoints/sync/mod.ts` (`runSync`): writes planned files, maintains the
  project `deno.json` import map (`REQUIRED_IMPORTS` incl. `"@techgoose-labs/rune": "jsr:@techgoose-labs/rune@^1"`),
  then `ensureBootstrap(root)`: scans `src/*/entrypoints/*/mod.ts` for `export const <x>Module`
  (regex), regenerates `bootstrap/modules.ts` (header `// Generated by rune sync — DO NOT EDIT.`),
  creates-once `bootstrap/mod.ts` (`export const api = await bootstrapServer("<app>", modules, { port: config.port })`)
  and `bootstrap/config.ts`. Project specs are recognized by `isProjectSpec` in
  `src/rune/domain/business/rune-bindings/mod.ts` (`specs/<n>.rune`, `src/<m>/spec.rune`,
  `src/<m>/<m>.rune`).
- New CLI commands follow a 3-file pattern: handler at `src/rune/entrypoints/<cmd>/mod.ts`,
  export from `src/rune/mod-root.ts`, dispatch block in `src/bootstrap/mod.ts`.
- Do NOT run `deno fmt` in this repo. Match surrounding style manually.

## Cross-repo rules

- keep is published to JSR; generated rune projects pin `jsr:@techgoose-labs/rune@^1`. Any keep
  feature that rune's generated code depends on must exist in keep FIRST. For local verification
  of unpublished keep features, remap `"@techgoose-labs/rune"` in the test project's `deno.json`
  to `/Users/raphaelcastro/Documents/programming/rune/keep/src/bootstrap/mod.ts` (the committed e2e
  fixtures already do this).
- Scratch projects for verification go under `/tmp`, never inside either repo.
- `MANUAL_KEY=<anything>` env silences keep's signing-key warning when booting test servers.
- Report results honestly: paste failing output if something fails; never claim green without
  having run the command.
