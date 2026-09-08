# DX roadmap — rune dev · system map · contract layers

> **Superseded by [`./todos/`](./todos/README.md)** — the agent-dispatchable version
> (progressive disclosure: `todos/README.md` orchestrates; `todos/00-context.md` + one
> `todos/NN-*.md` is a complete, self-contained brief for a zero-context worker agent).
> This file remains as the human-readable overview; the folder is the source of truth.

Sequential. Each item ends with its verification step. keep ships before rune within any item that spans both repos. Repos: `~/Documents/programming/rune/keep` (this one) and `~/Documents/programming/rune`.

- [ ] **1. Layer 1 — `rune sync` generates isolation seeds in the per-surface e2e test** (rune)
  - [ ] In `src/rune/domain/business/rune-manifest/mod.ts`, thread data into the e2e renderer: `addEntrypointSurface` already holds `process: Map<EntNode, EntProcess>`; also pass a `typMap` (name → typeName, built from `ast.typs` in `planManifest`) so placeholders are typed.
  - [ ] In `renderEntrypointE2e`, collect `$name` refs across the surface's ents' binds (string and array values), map each to a placeholder by `[TYP]` type (`string → "<name>-stub"`, `number → 7`, `boolean → true`), and emit `overrides: { seeds: { ... } }` in the generated `exerciseEndpoints` call. Emit nothing when there are no `$` inputs so existing modules regenerate byte-identically.
  - [ ] Add `rune-manifest/test.ts` cases: a `[TYP:ext]` spec yields seeds in the generated e2e; a spec without ext inputs yields the unchanged template.
  - [ ] Run `cd ~/Documents/programming/rune && deno test -A src/rune/domain/business/rune-manifest/`.
  - [ ] **Verify**: in keep, delete `e2e/checkout/src/checkout/entrypoints/http/e2e.test.ts`, regenerate via `deno run -A src/bootstrap/mod.ts manifest e2e/checkout/src/checkout/checkout.rune` (from the rune repo), confirm the regenerated test seeds `memberId`, then `RUNE_E2E=1 deno task test:e2e:checkout` runs it green with zero hand-written glue.

- [ ] **2. Layer 3 — contract auto-wiring at compose time + `stub` metadata** (keep, ships first)
  - [ ] `endpoint-decorator/mod.ts`: add `EndpointOptions.stub?: boolean` → `ProcessMetadata.stub` (default false); update the exact-shape `x-keep-process` assertion in its test.
  - [ ] `endpoint-spec/mod.ts`: `SpecEndpoint.stub` from `process?.stub ?? false`; extend its test.
  - [ ] `bootstrap-server/mod.ts`: before the docs loop, build a producers index from all docs (`field → "module:endpointId"`, first producer wins, stub producers included); change `emulatorShellHtml(title, doc)` to `emulatorShellHtml(title, doc, opts?: { producers?, dev? })` and pass the module-relevant slice (only this module's `$` input names).
  - [ ] `emulator-ui/client.ts`: `$` resolution order becomes explicit value (`globals.vars`) → producer fallback (`globals.captured["module:endpointId"][name]` from `DATA.producers`); the Module-inputs card shows `auto: members:create.memberId` when unset and a producer exists; stub steps get a "stub" chip.
  - [ ] `exercise-harness/mod.ts`: same `$` fallback in `buildValues` (seeds win → scan store for an object owning the field); add synthetic ordering edges (between the flatten at ~line 239 and `processOrder`) so producers run before `$`-consumers in pass one.
  - [ ] Tests: harness (composed two-module app, NO seeds → green with producer ordered first; seeds still win), browser (run producer page → consumer page shows auto + resolves), unit (payload carries producers).
  - [ ] **Verify**: `deno task test` + `deno task test:browser` + `KEEP_BROWSER=1 deno task test:e2e` all green; `deno task check:jsr` dry-run passes.

- [ ] **3. Layer 2 — ghost stub module generation + evaporation** (rune)
  - [ ] New pure module `src/rune/domain/business/rune-stubs/mod.ts`: `planStubs(specs)` parses all project specs, computes union of `[TYP:ext]` names minus union of all modules' ENT output-DTO field names → `[{name, tsType}]`; `renderStubsModule(fields)` emits a header-marked `bootstrap/stubs.ts` (inline class-validator DTOs, `GET mint-<kebab>` endpoints with `stub: true`, deterministic per-process counter values, `endpointModule("Stubs", ...)`). Reuse `dtoFieldNames` (export it from rune-manifest).
  - [ ] `src/rune/entrypoints/sync/mod.ts` `ensureBootstrap`: gather specs via `collectFiles` + `isProjectSpec`, write/refresh `bootstrap/stubs.ts` when unfulfilled inputs exist, header-guarded delete when none remain; skip + note when a real `src/stubs` module exists.
  - [ ] `renderAppRegistry`: when stubs exist, emit the static import + `...(Deno.env.get("DENO_ENV") === "production" ? [] : [stubsModule])`.
  - [ ] Tests: `rune-stubs/test.ts` (unfulfilled / fulfilled / multi-module), sync integration (stub created → a later spec produces the field → stub evaporates; registry gate emitted; real-stubs-module skip).
  - [ ] **Verify**: fresh `/tmp` project from the checkout spec → `bootstrap/stubs.ts` exists; boot, `/docs/stubs` renders as a normal cake page; run the mint step → the consumer module's `$memberId` auto-resolves (via item 2's fallback); add a members spec producing `memberId` → re-sync → stubs.ts gone; `DENO_ENV=production` boot serves no `/docs/stubs`.

- [ ] **4. Lifecycle acceptance fixture** (keep e2e — the committed proof)
  - [ ] Add a members module beside checkout (hand-written, mirroring rune output: `create` outputs `memberId`) in `e2e/checkout`.
  - [ ] New test stages: composed `[MembersModule, CheckoutModule]` runs green with **no seeds** (auto-wired, members ordered first); isolated checkout still green via seeds; browser stage asserts checkout's Module-inputs card shows `auto: members:create.memberId` and resolves after running members' step.
  - [ ] **Verify**: `KEEP_BROWSER=1 deno task test:e2e` green including the new stages.

- [ ] **5. `rune dev` — the live loop** (keep parts first, then rune)
  - [ ] keep `emulator-ui/client.ts`: exported `devReloadJs` (no backticks/`${`): poll relative `"_dev"` every 1.5s while visible; on network failure tighten to 500ms and after 2 failures show an owned "server restarting…" banner (never clobber run-all banners — ownership flag); reload **only** on a changed bootId; 404 → stop permanently.
  - [ ] keep `emulator-ui/mod.ts`: append the dev script when `opts.dev` (same opts param introduced in item 2).
  - [ ] keep `bootstrap-server/mod.ts`: when `KEEP_DEV` env is set, mint `bootId = crypto.randomUUID()`, register `GET /docs/_dev` (tolerant read of the status file named by `KEEP_DEV`; returns `{ bootId }` alone on parse failure), pass `dev: true` into the page registrations. Int test for the route.
  - [ ] rune `sync/mod.ts`: skip byte-identical writes everywhere (kills watcher self-trigger at the source); add an optional written-paths collector to `runSync`/`ensureBootstrap` covering generated files, `deno.json`, `bootstrap/*`, and both sides of the spec move.
  - [ ] rune `src/rune/entrypoints/dev/mod.ts` (new) `runDev`: normalize root via `resolveRoot` (accepts a spec path); status.json in `Deno.makeTempDir()` written atomically (tmp+rename); spawn `deno run -A bootstrap/mod.ts` with `KEEP_DEV=<status path>`; `Deno.watchFs([src, specs, bootstrap, deno.json])`; 200ms trailing debounce, single-flight cycles with coalesced follow-up, written-set suppression + 2s tail; `.rune` event → check → errors? status-only : sync + restart; other src event → restart-only; SIGINT/SIGTERM → TERM child, 2s, KILL, rm temp, exit; child crash → `{ok:false}` status, no auto-restart loop.
  - [ ] rune: export from `mod-root.ts`, dispatch block + help text in `src/bootstrap/mod.ts`; unit tests for the pure pieces (event filtering, suppression, cycle planning).
  - [ ] **Verify**: on a `/tmp` project, `rune dev .` → add an `[ENT]` to the spec, the page shows the new step within ~3s with session variables intact; break the spec → banner shows `rune check` errors while the old server keeps serving; Ctrl-C leaves no orphan process (`pgrep`).

- [ ] **6. System map at `/docs/_map`** (keep)
  - [ ] New `src/foundation/domain/business/map-ui/` (mod.ts + client.ts string assets, emulator-ui conventions): nodes = endpoints in module lanes (verb/path/flows/optional/stub), edges = binds + dashed `$input → producer` edges (from item 2's index) + OR-bind multi-edges; columns = topo rank from `processOrder` over the flattened endpoints (computed server-side); SVG, flow color legend.
  - [ ] Cake deep-links: `/docs/<module>#<endpointId>` expands + scrolls to the step on load; map nodes link there.
  - [ ] Live state: map client reads each module's session key (`keep:cake:/docs/<module>`) + globals, recolors on `storage` events.
  - [ ] `bootstrap-server`: register `GET /docs/_map`; link it from the docs index (`index-page-builder`) and the cake headers.
  - [ ] Tests: unit (map HTML carries nodes/edges payload), browser (renders N nodes; clicking a node lands on the cake with the step expanded; a dot recolors after running that step on its module page).
  - [ ] **Verify**: boot the composed e2e fixture, open `/docs/_map`, screenshot; click through to a step; run it; watch the map dot turn green; full keep suites stay green.

- [ ] **7. Docs, skill, and the cross-repo verification sweep**
  - [ ] keep README: auto-wiring lifecycle, stub badge, `/docs/_map`, `KEEP_DEV` + `/docs/_dev`, `emulatorShellHtml` opts.
  - [ ] rune `lang/docs/spec.md`: `rune dev` section + stub lifecycle; `skills/rune/SKILL.md` updated (dev loop, ghost stubs, snap-together) and copied to `~/.claude/skills/rune/SKILL.md`; CLI help text.
  - [ ] keep sweep: `deno task test`, `deno task test:browser`, `KEEP_BROWSER=1 deno task test:e2e`, `deno fmt --check src/`, lint on touched scope, `deno task check:jsr`.
  - [ ] rune sweep: unit tests on touched modules; `deno run -A scripts/verify.ts` gate pattern identical to a stashed-baseline run (5 gates fail on clean develop today — no new failures allowed).
  - [ ] Release sequencing: publish keep (minor) first; rune's generated code targets `jsr:@techgoose-labs/rune@^1` so no pin change.
  - [ ] **Verify**: drive each of the four demo surfaces once (dev loop edit, stubs page mint, compose-and-snap, system map) with screenshots; `git status` review in both repos.
