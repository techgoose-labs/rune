# Endpoints, the headless runner, and the system map

The runtime view of keep's process layer: the `@Endpoint`/`@EndpointController`
metadata, the `exerciseEndpoints` headless runner, the `/api/docs/_map` system map,
and the `POST /api/docs/_run` HTTP door. Everything here derives from the
`x-keep-process` vendor extension that `@Endpoint` stamps into each module's
OpenAPI doc — the cake, the system map, and `exerciseEndpoints` are three views
of the same metadata.

The *interactive* cake page (`/api/docs/<module>`), its expectations/scenarios/
module-setup, the heal panel, and dev-mode belong to the **`rune:cake`** skill —
this file owns the runtime/code surface (metadata, runner, map, the HTTP doors).

## `@EndpointController(surface, opts?)` / `@Endpoint(opts)`

`@EndpointController("orders", { description: "Orders API" })` declares the
controller surface (the route prefix). `endpointModule("Orders",
[OrdersController])` wraps controllers into a module `bootstrapServer`
accepts. Module docs pages are named after the module class, lowercased,
without the `Module` suffix (`endpointModule("Orders", …)` → `/docs/orders`).

`EndpointOptions`:

| Option | Meaning |
| ------ | ------- |
| `method` | HTTP verb, default `"post"` |
| `path` | route segment, default: the handler method name |
| `input` / `output` | DTO classes (drive the Swagger schema AND the cake's generated request bodies) |
| `order` | process position, ascending |
| `dependsOn` | endpoint id(s) — handler method names — that must succeed first |
| `bind` | request autofill map (three value forms, below) |
| `flows` | named XOR branch(es) this endpoint belongs to |
| `optional` | attempted but never blocks the walk |
| `stub` | generated stand-in minting placeholder values (badged, excluded from "real process" reasoning) |
| `description` | endpoint description for Swagger |

The endpoint **id** is the handler method name — `dependsOn`/`bind`
references use it, and so do cake deep links (`/api/docs/<module>#<id>`).

You rarely write this metadata by hand: `rune sync` derives `order`/`dependsOn`/
`bind` from the spec's DTO field graph (same-named output→input fields chain
automatically). See the **`rune:spec`** skill for how the `.rune` spec expresses
order/deps/flows and the **`rune:build`** skill for `rune sync`. A *stale*
generated entrypoint controller is the classic source of wrong order/deps — the
fix is delete it and re-sync.

`bind` value forms:

- `"otherEndpointId.outputField"` — fill this request field from that
  endpoint's captured response.
- `"$name"` — an **external input** nothing in this module produces. Shows
  under the cake's "Module inputs" card; the runner reads
  `overrides.seeds[name]`; composition auto-satisfies it (below).
- `["a.field", "b.field"]` — alternatives, first-resolvable-wins. This is the
  OR-join after a flow branch: endpoints in different flows produce the same
  field; the consumer binds to all of them.

DTO classes use either `@danet/swagger`'s `@ApiProperty()` or
class-validator decorators (`@IsString()` etc.) — both emit the
`design:type` metadata the schema builder needs. (How DTO classes drive the
Swagger schema and `example=` is the **`rune:docs`** skill.)

## `exerciseEndpoints(opts)` — the headless runner

Discovers endpoints from the bootstrapped app's docs (ALL composed modules),
orders them (`order` + `dependsOn`, topological), runs them chaining outputs
into inputs via `bind`, and loops until green (or `maxIterations`).

```ts
import { exerciseEndpoints } from "@techgoose-labs/rune";
const report = await exerciseEndpoints({ api });
// { passed, failed, optionalFailed, iterations, order, cycles, unresolvedInputs }
// each result row: { id (bare op-id), module, method, path, status, attempts, … }
```

Options:

- `api` — the bootstrapped app. With no `baseUrl`, requests dispatch
  in-process via `backend.fetch` (no port, bypasses auth) — the default for
  tests/CI.
- `baseUrl` — run over real HTTP against a live server. Uses Playwright's
  `APIRequestContext` (HTTP client, not a browser) — Playwright must be
  provisioned (`deno run -A npm:playwright install`) for this path only.
- `flow` — walk one named branch (plus untagged endpoints).
- `overrides.seeds` — literal values by **field name**; the first resolution
  source for both plain fields and `$inputs`. A seed always wins.
- `overrides.byEndpoint` — per-endpoint body overrides by id; win over
  `bind`.
- `overrides.auth` — `{ kind: "in-process" }` (default), or, for network
  (`baseUrl`) runs, a ready **infra session bearer** sent as `Authorization`:
  `{ kind: "token", token }` / `{ kind: "bearer", bearer }`. keep mints nothing
  — obtain the bearer from infra (see `references/auth.md`).
- `rateLimit` — `{ requestsPerSecond?, maxConcurrency? }`.
- `maxIterations` — default 5.
- `retry` — `{ slugs, delayMs?, attempts? }`: a failed response whose
  `body.message` matches a listed slug is re-attempted after a delay (default
  800 ms × 3) instead of failing the walk. `/api/docs/_run` derives the slugs from
  the project's heal rules (`retry` actions / `note` + `retryAfter`) plus the
  built-in transients (`timeout`, `rate-limited`).
- `onResult` — per-attempt streaming callback (what `stream: true` forwards).
- `dryRun` — build `order` / `cycles` / `unresolvedInputs` (external `$inputs`
  with no seed and no producer) without sending a request; the run loop is
  skipped and `passed`/`failed` come back empty.

`$name` resolution order: `seeds[name]` → first captured response (run
order) owning a same-named field → first captured response owning a
same-named **plural collection** (`name + "s"`), whose first scalar element
supplies the value (`$tableName` ← `discover.tableNames[0]` — the list→item
pattern auto-wires). The runner adds a **synthetic dependency edge**
consumer→producer so producers run first and the fallback hits on pass one.
**Echoes never count as producers** — an endpoint that consumes the field it
outputs can't bootstrap a value, so it's excluded from producer matching,
`unresolvedInputs`, the cake's `auto:` index, and map edges. Required fields
with no seed/bind fill from a REAL schema `example` (typed zeros count, the
empty-string placeholder doesn't). `failed` excludes `optional` endpoints
(those land in `optionalFailed`).

Composition acceptance pattern (proves the snap-together contract — this is
keep's own e2e pattern):

```ts
const api = await bootstrapServer("checkout", [membersModule, httpModule]);
const report = await exerciseEndpoints({ api, flow: "card" }); // NO seeds
assertEquals(report.failed.map((r) => r.id), []);
// producer ordered before consumer:
assert(report.order.indexOf("create") < report.order.indexOf("start"));
```

The **`rune:cake`** skill drives this same runner for real-data e2e and the
**`rune:build`** skill calls it as a CI gate; this file owns its option surface.

## The system map — `/api/docs/_map`

One page for the whole composed app: every module's endpoints as nodes in
module lanes, columns by dependency depth. Solid edges = intra-module binds;
**dashed edges** = `$input` contracts satisfied by another module's producer;
an unproduced `$name` renders as an amber badge on its consumer. Flow edges
are tinted; optional/stub endpoints carry chips. The map is **live** — node
dots recolor from cake sessions in `localStorage`, any tab. A **Run all**
button runs the whole composed process server-side via the control-plane-gated
`POST /api/docs/_run` walk (in-process or a `dev`-grant bearer), **module by module,
endpoint by endpoint** (lane
order), under the cake's own defaults: `flow: "__main"` (untagged steps only —
destructive branches never auto-run), the user's typed environment variables
as `seeds`, and each module's per-step skips as `skip`. The run **streams**:
each result is written into that module's cake session as it lands (status,
response body, ms, captures + shared scope) and its node settles green/red
while the rest keep pulsing. Clicking a node deep-links to
`/api/docs/<module>#<endpointId>` with that step expanded. (Underscore-prefixed so
a module named "map" can still own `/docs/map`.) How the map feeds the cake
sessions and lights the heal panel when steps fail is the **`rune:cake`** skill.

## Headless run over HTTP — `POST /api/docs/_run`

The HTTP door to `exerciseEndpoints` — so an agent, CI, a smoke check, or the
map UI can ask a *running* server "does the whole composed process work right
now?" without importing the app. Same trust posture as the rest of the `/api/docs/_*`
control plane: **in-process OR an infra bearer whose app-grants include `dev`
(or `*`)** — no localhost trust; `503` until the in-process backend exists.

- Body (all optional): `{ flow?, seeds?, byEndpoint?, rateLimit?, maxIterations?, dryRun?, scenario?, orderBy?, skip?, stream? }`.
- `orderBy: "module"` walks lane-by-lane (modules in docs order, topological
  within each lane); forward cross-module deps fail that pass and converge on
  a later iteration. `skip: ["<module>:<op>", …]` excludes steps entirely
  (the cake's skip toggle, headless). `stream: true` returns ndjson: one
  `{kind:"result", …row}` line per call as it completes (a retried step
  streams once per attempt), then `{kind:"done", ok, passed, failed[],
  optionalFailed[], cycles, iterations}` — what the map's Run all consumes.
- `200` → `{ ok, passed[], failed[], optionalFailed[], order, cycles, iterations }`,
  where `ok = failed.length === 0 && cycles.length === 0` and every row carries
  its `module` (bare op-ids collide across composed modules) plus the response
  `body` and per-call `ms` — enough to show/replay outcomes, not just verdicts
  (the map's write-back is built on this).
- `scenario: "<name>"` replays a saved `spec/misc/scenarios/` file: its flow
  (an explicit `flow` in the body wins) and each step's literal body fields as
  `byEndpoint` overrides (`{{ref}}`-holding fields are left to bind). Unknown
  name → `404`. (Saving scenarios from the cake is the **`rune:cake`** skill.)
- `dryRun: true` → `{ order, cycles, unresolvedInputs }` with nothing executed —
  a cheap pre-flight that names dependency cycles and unsatisfied `$inputs`.
- `seeds` ride in the request body, not the browser session (a headless caller
  can't see `localStorage`); pass JSON-typed values — the runner doesn't coerce.

## Generated code: validated seams — `#assert`

Generated coordinators validate every seam at runtime via
`import { assert } from "#assert"` — keep's assert runtime; `rune sync` maps
the `#assert` alias in the project's `deno.json`. Context labels use the
REQ's `noun.verb` for input/result and the boundary step's `noun.verb` for
reads/writes:

- the request **input**: `assert(InputDto, input, "task.create input")`,
  first statement of the shell
- every data-adapter **read**: `assert(TDto, await ..., "task.load")`;
  reads whose type resolves to a primitive use
  `assert.string` / `assert.number` / `assert.boolean` / `assert.uint8Array`
- every DTO **write** argument before it leaves:
  `assert(WDto, out.field, "task.save input")`
- the **result**:
  `return assert(OutputDto, out.result, "task.create output")`

A failed contract throws `RuneAssertError`; keep maps it to HTTP 422 with
`{ target, context, failures }` and dotted failure paths (`lines.1.qty`).
Named types with no runtime contract keep an `as` cast plus a trailing
`// unvalidated: <type> has no runtime contract` comment. `RUNE_ASSERT=off`
turns every assert into a passthrough (trusted prod mode). Entrypoint
controllers stay validation-free — validation lives in the coordinator.

## Generated code: faults — `RuneFault`

Every fault a module declares is a class in `src/<module>/dto/faults.ts`
extending keep's `RuneFault` with the fault's name and HTTP status
(`! not-found` → `NotFoundFault`, 404; `! card-expired=402` →
`CardExpiredFault`, 402). A coordinator throws one; keep's bootstrap answers
with that status and `{ name: "RuneFault", fault, status, message }`.
