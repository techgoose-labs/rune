# Phase 2 — end-to-end verification ("cake" acceptance)

> Status: planned. Runs **after** the Phase 2 build (`docs/phase2-keep-integration.md`). This is
> the acceptance gate for the whole flow:
> `write cake.rune → rune sync → fill coordinator bodies → serve keep → open /docs/cake →
> Emulate down the list (chained, checkmarked) → Run all → green`, plus the headless runner.

## Why

Phase 1 unit tests cover decorators→routes/Swagger (Stage 1), the dependency graph (Stage 2), the
in-process runner (Stage 5), and Swagger gating (Stage 7). They do **not** cover the headline
**interactive cake click-through (Stage 4)**, the **Playwright HTTP path (Stage 6, gated)**, or
**rune generating the controller (Stage 8)**. This plan closes those with a single realistic
fixture exercised through the real flow.

## Fixture — `examples/cake/`

A spec whose DTO field names chain so Phase 2 auto-derivation yields a **linear**
`dependsOn`/`bind`:

| # | `[ENT] http.<action>(In): Out` | In field (from) | Out field (produces) |
|---|---|---|---|
| 1 | `driveToStore(DriveDto): ArrivalDto` | `destination` (seed) | `storeId` |
| 2 | `groceryShop(ShopDto): CartDto` | `storeId` ← #1 | `cartId` |
| 3 | `checkout(CheckoutDto): ReceiptDto` | `cartId` ← #2 | `ingredientsId` |
| 4 | `mixIngredients(MixDto): BatterDto` | `ingredientsId` ← #3 | `batterId` |
| 5 | `bake(BakeDto): CakeDto` | `batterId` ← #4 | `cakeId` |
| 6 | `cut(CutDto): SlicesDto` | `cakeId` ← #5 | `sliceCount` |

Each `[ENT]` has a matching `[REQ] noun.verb` with the same `(input, output)` DTO pair (unique per
step ⇒ unambiguous match). Step 1's `destination` has no producer ⇒ it stays unlocked first and is
seeded/typed.

Commit (hand-written, not generated):
- `server.ts` — `bootstrapServer("cake", httpModule).listen()`.
- `deno.json` — maps `@techgoose-labs/rune` → the **local keep checkout** (path import) so the example
  resolves without a published JSR release (overrides the build plan's `jsr:` default for local dev).

## Execution (the flow under test)

1. `rune sync examples/cake/src/cake/cake.rune` → generated `entrypoints/http/mod.ts`
   (`@EndpointController` + 6 `@Endpoint` methods with computed `order`/`dependsOn`/`bind`), DTOs,
   coordinators, opt-in e2e test.
2. Confirm the synced `deno.json` carries `experimentalDecorators`/`emitDecoratorMetadata` +
   `reflect-metadata` (sync already does this — `src/rune/entrypoints/sync/mod.ts:209`) and the
   local keep mapping.
3. Fill the 6 coordinator bodies with deterministic chaining values.
4. `deno check` (from the project) + `rune lint` → clean.
5. `deno task serve` → keep serves `/docs/cake`.

## Acceptance checks (stage → method)

- **1/2 spec + ordering:** `GET /docs/cake/json` → 6 paths, DTO schemas, `x-keep-process` with the
  expected `order`/`dependsOn`/`bind`; `processOrder` returns the cake sequence, `cycles: []`.
- **5 in-process runner:** `exerciseEndpoints({ api })` → all 6 passed; chained ids flow (a step
  throwing on a missing bound field would fail — proves chaining).
- **4 interactive cake (live, Playwright MCP):** open `/docs/cake`; only step 1 enabled; click
  Emulate → checkmark + response + step 2 unlocks **pre-filled from the captured `storeId`**; walk
  to 6 checkmarks; reload → **Run all** → 6 green. Screenshots as evidence.
- **4 committed regression:** `keep` browser test (`emulator-ui/browser.test.ts`, gated `KEEP_BROWSER=1`,
  `npm:playwright` chromium) asserting locked→unlocked, autofill, checkmark, Run-all greens.
- **6 Playwright HTTP path:** with Playwright provisioned, run the gated
  `exercise-harness/smk.test.ts` (`KEEP_PLAYWRIGHT_SMOKE=1`) + `exerciseEndpoints({ api, baseUrl })`
  against the served app → green.
- **7 Swagger gating:** `/docs/cake/swagger` loads; `/docs/cake/json` 401 without a token, 200 with
  a valid token / loopback.
- **8 codegen matches:** the rune golden (`fixtures/golden/manifest/entrypoint.json`) locks the
  generated shape; the generated cake controller compiling, linting clean, and driving green through
  Stages 4–6 proves "exactly as described."

## Provisioning

Add `playwright` as an optional dev peer in `keep`; document `deno run -A npm:playwright install
chromium` (or `PLAYWRIGHT_BROWSERS_PATH`). keep tasks `test:browser` (`KEEP_BROWSER=1`) and
`test:smoke` (`KEEP_PLAYWRIGHT_SMOKE=1`); default `deno task test` stays browser-free (README + CI note).

## Risks / checkpoints (what this e2e is designed to catch)

- **reflect-metadata skew:** synced project pins `reflect-metadata@^0.2`, keep uses `0.1.13`, danet
  uses `@dx/reflect`. Mixed polyfill copies can blank out `@Endpoint`/DTO metadata. Confirm
  `x-keep-process` + DTO schemas actually appear in `/docs/cake/json`; align ranges if broken.
- **`@techgoose-labs/rune` resolution:** local path for the example; `jsr:` for real projects — both
  must resolve.
- **`layer-restrictions` lint:** the entrypoints→coordinators import edge must pass `rune lint`; add
  the edge to the rule's allowlist if it flags.
- **Cake base-path:** the page derives the app root by stripping `/docs/<module>`; verify
  standalone serving (mounted-under-Fresh is out of scope this pass).

## Exit criteria

All eight stages verified; MCP screenshots captured; committed browser + smoke tests pass with
Playwright provisioned; full `keep` and `rune` suites green; the cake example committed and
reproducible from `cake.rune` via `rune sync`.
