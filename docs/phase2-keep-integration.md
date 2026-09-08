# Phase 2 — `rune sync` generates keep endpoint controllers

> Status: planned, not started. Phase 1 (the keep building blocks) is complete and green in the
> `keep` package: `@Endpoint`/`@EndpointController`/`endpointModule`, the `x-keep-process` OpenAPI
> extension, the per-module cake at `/docs/<module>`, and the headless
> `exerciseEndpoints` runner.

## Goal

Close the loop so the workflow is **write rune → `rune sync` → fill coordinator bodies → serve keep
→ walk the cake**. Today `[ENT] surface.action(InDto): OutDto` generates a bare
`export async function action(input): Promise<Output> { throw … }` stub
(`src/rune/domain/business/rune-manifest/mod.ts`, `ENTRYPOINT_MOD_TPL` ~L901) with no keep wiring,
no Swagger, no process metadata. Phase 2 generates a real keep controller from the spec.

## Two facts that shape (and simplify) the work

1. **No `deps.json` artifact is needed.** keep derives ordering/chaining at runtime from the
   `@Endpoint` decorator args (surfaced as `x-keep-process` in the OpenAPI doc). rune only needs to
   *compute* `order`/`dependsOn`/`bind` and write them as decorator args. → no canonical-paths
   change, no structure-rule change, no prune change, no parser change.
2. **Multiple `[ENT]`s on one surface currently collide.** `addEntrypoint` runs per-ent and `emit`
   dedupes by path, so a 6-step "cake" module (all `http.*`) drops all but the first. Codegen must
   **group `[ENT]`s by surface into one controller** with one decorated method each. This is the
   core change.

Generated coordinator bodies still `throw "not implemented"`, so the generated e2e test is
**opt-in** (env-gated) — `deno test` stays green right after `sync`; the dev enables it after
filling bodies.

## Verified conventions to reuse

- Coordinator for `[REQ] noun.verb` → `src/<m>/domain/coordinators/<noun-verb>/mod.ts`, exporting
  `export async function <verb>(input): Promise<Output>` (rune-manifest/mod.ts:597). `processName`
  builds `<noun-kebab>-<verb-kebab>`.
- DTO classes (real values, class-validator) at `src/<m>/dto/<file>.ts`; imports resolved via
  `dtoImports([names], nameBinding)` → `{ type, file }` (rune-manifest/mod.ts:563).
- Helpers in rune-manifest/mod.ts: `applyCase`, `toPascal`, `camel`, `processName`, `dtoImports`,
  `nameBinding`, `emit`/`render`/`tpl`, `DEFAULT_TEMPLATES` (L933), `DEFAULT_POLICIES` (L964).
  `renderCoordinator` builds its file with a manual `L[]` line array — the entrypoint renderer
  follows that pattern.
- DTO field normalization (strip `(s)`/`?`, pluralize arrays) is inlined in `renderDto`
  (rune-manifest/mod.ts:438) — factor a shared `dtoFieldNames(dto)` helper.
- `[ENT]` has no captured `[REQ]` link (`EntNode` in rune-parse/mod.ts); match `[ENT]`→`[REQ]` by
  shared `(input, output)` DTO pair among `ast.reqs`.
- Import-map writer: `REQUIRED_IMPORTS` in `src/rune/entrypoints/sync/mod.ts:198`
  (non-destructive merge).
- `external-imports` lint bans only literal `npm:`/`jsr:` specifiers — importing the
  `@techgoose-labs/rune` alias is allowed; no rule change.

## Changes (all in `rune`)

### C1 — group `[ENT]`s by surface; render a keep controller
Replace per-ent `addEntrypoint` with a surface-grouped renderer in `rune-manifest/mod.ts`.
- In `planManifest` (the `for (const ent of ast.ents) addEntrypoint(...)` loop, ~L176): group
  `ast.ents` by `ent.surface`, assign each ent a module-wide `order` (declaration index + 1), and
  call a new `addEntrypointSurface(emit, module, surface, ents, ast, orderMap, runePath)` once per
  surface.
- `renderEntrypointController(...)` (manual `L[]`, mirroring `renderCoordinator`) emits
  `src/<m>/entrypoints/<surface>/mod.ts`:

```ts
import { Endpoint, EndpointController, endpointModule } from "@techgoose-labs/rune";
import { CreateOrderDto } from "@/src/<m>/dto/create-order.ts";   // value imports (DTO classes)
import { OrderDto } from "@/src/<m>/dto/order.ts";
import { place as orderPlace } from "@/src/<m>/domain/coordinators/order-place/mod.ts";

@EndpointController("http")
export class HttpController {
  @Endpoint({ input: CreateOrderDto, output: OrderDto, order: 1, dependsOn: [], bind: {} })
  placeOrder(body: CreateOrderDto): Promise<OrderDto> { return orderPlace(body); }
  // …one method per [ENT] in this surface…
}
export const httpModule = endpointModule("<ModuleTitle>", [HttpController]);
```

- Per ent: match `[REQ]` by `(input, output)`; import its `verb` aliased to `<noun><Verb>` from the
  coordinator path; method name = `ent.action`; body = `return <alias>(body)`. **No match** → emit
  a method that `throw new Error("not implemented")` (preserve today's behavior; no dangling import).
- DTO imports are **value** imports (the class is referenced at runtime in `@Endpoint`), unlike the
  coordinator's `import type`.
- Retire `ENTRYPOINT_MOD_TPL` (keep the `entrypoint-mod` role/policy for `emit`); content now comes
  from the render fn.

### C2 — compute `order` / `dependsOn` / `bind` at generation time
A pure helper over `ast` (the "explicit decorators, values computed by rune" design):
- `order` = ent's module-wide declaration index + 1.
- For each input field `f` (normalized via `dtoFieldNames`) of ent `E`: find another ent `P` whose
  **output** DTO has a field of the same normalized name; pick the earliest-declared producer. →
  add `P.action` to `dependsOn`, set `bind[f] = "<P.action>.<f>"`. Ignore self; dedupe `dependsOn`.
- Serialize into the `@Endpoint({...})` literal from C1.

### C3 — generated e2e test invokes the runner (opt-in)
Replace `ENTRYPOINT_E2E_TPL` content (per surface):

```ts
import { httpModule } from "./mod.ts";
import { bootstrapServer, exerciseEndpoints } from "@techgoose-labs/rune";
import { assertEquals } from "#std/assert";

// Fill the coordinator bodies, then run with RUNE_E2E=1 to drive every endpoint to green.
Deno.test({ name: "<m>/http — endpoints run and chain", ignore: !Deno.env.get("RUNE_E2E"), fn: async () => {
  const api = await bootstrapServer("<m>", httpModule, { swagger: true });
  try {
    const report = await exerciseEndpoints({ api });
    assertEquals(report.failed.map((r) => r.id), []);
  } finally { await api.stop(); }
}});
```

Stays `create-once` (dev tunes seeds/auth).

### C4 — import map gains keep
Add to `REQUIRED_IMPORTS` (sync/mod.ts:198): `"@techgoose-labs/rune": "jsr:@techgoose-labs/rune@^1"`.
(`#std/assert` is already present for C3.) **Gating note:** generated projects only type-check if
`@techgoose-labs/rune` resolves — confirm it's published to JSR at the pinned major, or document the
local override. This is the one external dependency that blocks the phase.

### C5 — fixtures, goldens, tests
- Extend `fixtures/corpus/valid/entrypoint.rune` to **two** `[ENT]`s on one surface that chain
  (e.g. `http.createOrder(NewOrderDto): OrderDto` then `http.payOrder(PayDto): ReceiptDto`, where
  `PayDto` carries the `id` that `OrderDto` produces) — exercises grouping + computed
  `dependsOn`/`bind`.
- Regenerate goldens with `deno task verify --update-goldens`, then **review the diff** — touches
  `fixtures/golden/{parse,manifest,lint}/entrypoint.json` and the materialized
  `fixtures/projects/entrypoint/` tree (also clears the known stale `#zod`/class-validator drift).
  `gateL5` (Studio == engine) holds automatically since both call `planManifest`.
- Update `rune-manifest/test.ts` (the `[ENT]` test, ~L127): now expects an `@EndpointController`
  class with a method + `@Endpoint(...)` per ent (not a bare function); add a case asserting two
  ents on one surface land in **one** controller with computed `order`/`dependsOn`/`bind`.

### Out of scope (verified)
Rust parser / `EntNode`; canonical-paths / `keywords.json` (`mod.ts` + `e2e.test.ts` are existing
slots); structure & `rune-extra-files` rules; `rune-sync` predict/classify (entrypoint folder
already predicted; no new file kinds). `external-imports` (alias import is allowed).

## Verification

- `deno test -A src/` green (esp. the updated `rune-manifest/test.ts`).
- `deno task verify` green (goldens match; Studio == engine); review the `--update-goldens` diff.
- End-to-end: `rune sync fixtures/corpus/valid/entrypoint.rune` into a temp project →
  - generated `entrypoints/http/mod.ts` is an `@EndpointController` with both methods, correct DTO
    + coordinator imports, and `order`/`dependsOn`/`bind` on `payOrder` referencing `createOrder`;
  - `deno check` passes (requires `@techgoose-labs/rune` resolvable — C4);
  - `rune lint` is clean — watch `layer-restrictions` for the entrypoints→coordinators edge; if it
    flags, add that edge to the rule's allowlist (the one possible extra change);
  - fill the two coordinator bodies, serve, open `/docs/<m>` → cake orders create→pay, Emulate
    chains the id, **Run all** greens; `RUNE_E2E=1 deno test` greens the generated e2e.
