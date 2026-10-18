# The cake page — behavior, expectations, fixtures, scenarios

The full reference for the interactive cake at `/api/docs/<module>`: how the walk
resolves and coerces values, the expectations contract, durable module setup,
the `spec/misc/cake.json` and scenario artifacts, response-diff, and the flow
selector. The cake, the system map, and `exerciseEndpoints` are three views of
the same `x-keep-process` metadata that `@Endpoint` stamps into each module's
OpenAPI doc. (The `@Endpoint`/`@EndpointController` option tables and the
`exerciseEndpoints` runner option surface are owned by the `rune:framework` skill;
the heal panel + heal-rules schema live in `references/heal-rules.md`.)

## The three pages

With Swagger on (the default), each module gets:

| Path | What |
| ---- | ---- |
| `/api/docs/<module>` | the cake — a guided, ordered walk of the chain |
| `/api/docs/<module>/swagger` | standard Swagger UI (→ `rune:docs`) |
| `/api/docs/<module>/json` | the raw OpenAPI spec (**token-gated**; → `rune:docs`) |

Module docs pages are named after the module class, lowercased, without the
`Module` suffix (`endpointModule("Orders", …)` → `/docs/orders`). The endpoint
**id** is the handler method name — `dependsOn`/`bind` references use it, and so
do cake deep links (`/api/docs/<module>#<id>`).

## Cake behavior worth knowing when debugging

- **Request bodies are generated from the input DTO schema.** Bound fields hold
  **`{{step.field}}` references resolved at send time** — hand edits are never
  overwritten by a capture; the reference just resolves when sent.
- **Reference forms:** `{{step.field}}` (this page's captures), `{{name}}` (a
  shared user variable), `{{$name}}` (a declared module input),
  `{{module:step.field}}` (another module's capture), `{{a || b}}`
  (alternatives). Resolution is recursive (depth-capped).
- **Resolved body fields are coerced to their declared schema type.** After
  substitution, a top-level field whose DTO type is integer/number/boolean/object
  is coerced from a clean string form — so `"qbId": "{{$qbId}}"` is sent as a
  number however the value arrived (typed input, capture, env var), and the
  template stays strict JSON (refs stay quoted). The **Module inputs** card
  renders a number widget (storing a real number) for `$inputs` whose consumers
  are all numeric. **The headless runner and `seeds` are NOT coerced** — pass
  JSON-typed values there.
- Every successful run **captures outputs** into a live variables panel and also
  publishes them cross-module (`{{module:step.field}}`). Variables and captures
  are shared across all docs pages via `localStorage`, and a `storage` listener
  live-updates other open tabs.
- **Run all in order** walks the active flow and stops at the first failure with
  a banner naming the step and reason; fix and re-run to resume. The walk
  **scrolls the active (and any stopped) step into view but leaves every box
  collapsed** — nothing auto-expands, so the run is easy to follow; open a box
  yourself to inspect it. **Skipped** steps are excluded from the walk entirely —
  each step has a `skip` toggle, and a skipped step's state stays exactly where
  you parked it (the row renders dimmed). **Run from here** (in a step's Request
  panel) clears that step and every later step in the walk, then runs from it.
- A failed step whose failure the heal rules can name gets a yellow **⚠** dot
  instead of red and a **heal** panel of one-click fixes — see
  `references/heal-rules.md`.
- Declared `$inputs` appear in the **Module inputs** card. Unset inputs show
  amber; a composed producer flips the row to a dim
  **`auto: <module>:<endpoint>`** note — satisfied from that producer's shared
  capture, no typing. A typed value overrides; clearing returns to auto.
- `stub: true` endpoints carry an amber **`stub`** chip.
- Dependency cycles are reported in a banner instead of leaving steps locked.
- Each step shows the concrete request it will send, the response, a paste-ready
  curl, and a **copy** button on the address bar that copies the route's full
  resolved URL. **Reset session** clears the page's state.

## The flow selector

A module with `flows` gets a **flow selector** that defaults to **main** — the
untagged-only walk — so destructive branches (a teardown flow) never run unless
explicitly selected. **"All"** runs everything; a named flow runs that branch
plus untagged steps. Off-flow steps are hidden and don't gate. (The headless
runner is unchanged: an unset `flow` option still means every endpoint.)

## Expectations — the contract per step

Each step's **Expect** block pins an exact HTTP status and body checks:

- `path` `==` / `!=` / `contains` / `exists` `value` — and values may hold
  `{{refs}}`.
- With expectations pinned, **green means the response meets them** — a 200 with
  a wrong body goes **red** (`expect ✗`). Each check's verdict shows with the
  actual value, and run-all stops naming the failed expectation.
- Expectations persist with the session and ride **Save fixtures** into
  `spec/misc/cake.json` — the committable contract-test layer.

## Response diff

Re-running a step shows changed/added/removed paths vs the previous response
(`old → new`, capped), or an explicit "unchanged vs previous run". Useful when a
walk is green but a downstream consumer suddenly breaks — diff tells you which
field of the producer's response moved.

## Module setup + the `spec/misc/cake.json` artifact

The cake's working session lives in `localStorage` (per page path) — ephemeral
and browser-local. Two surfaces make the deliberate configuration **durable**:

- **Module setup** — a rail card of calls that put the system in a known state
  **before** the process runs (seed a tenant, flip a flag, create a
  prerequisite). Steps can target **any composed module's endpoint**, not just
  this page's: the card's picker lists the whole app (grouped by module); picking
  a foreign endpoint generates a body whose bind refs are module-qualified
  (`{{mint:create.id}}`) so they resolve from the shared scope. Alternatively
  press **`+ setup`** in any step's Request panel to snapshot that request. Steps
  are editable in place (frozen body + params), reorderable, and individually
  runnable. **Run all** runs the setup steps first (in order, stopping with a
  banner on the first failure), then the normal process walk; **Run setup** fires
  them on their own. A local step runs through the page's normal send (main row
  updates); a **cross-module step writes its result into that module's session +
  the shared capture scope** (the map-write-back shape), so its outputs feed
  `$inputs` and cross-module refs immediately. In the artifact, a foreign step
  carries `module` (`{ module, id, body?, params? }`; absent = the slice's own
  module).
- **persist** — each environment variable in the Variables card has a
  **`persist`** checkbox. Ticked variables are written to the artifact.

**Save fixtures** writes `spec/misc/cake.json`: this module's setup steps, its
pinned **expectations**, plus every persisted variable. It's plain, prettified
JSON meant to be committed, so a process's required setup and contract travel
with the repo. On load the cake fetches it and applies it as the baseline —
restoring setup + expectations + persisted variables even in a fresh browser with
empty `localStorage` (the saved config wins for the keys it carries). The door is
`GET`/`POST /api/docs/_fixtures`, on the **`/api/docs/_*` control-plane gate** (same
posture as `/api/docs/_run`): **in-process OR an infra bearer whose app-grants
include `dev`** — no localhost trust; the file defaults to
`<cwd>/spec/misc/cake.json` when the project has a
`spec/` dir (else the legacy `<cwd>/fixtures/cake.json`), and `KEEP_FIXTURES_DIR`
overrides the directory. The server needs `--allow-write`; without it, **Save
fixtures** reports a 500 with the reason.

## Scenarios — `spec/misc/scenarios/<name>.json`

The Scenarios rail card freezes the whole walk (active flow, every step's body
text + params with refs intact, skips) under a name — one committable file per
scenario. **load** applies one over the page (overwrites editor state); **run** is
load + Run all. Saved/listed through the control-plane-gated `GET`/`POST
/api/docs/_scenarios` (in-process or a `dev`-grant bearer; same-name saves overwrite
— that's updating). CI replays one
headlessly with `POST /api/docs/_run {"scenario":"<name>"}`: the saved flow runs with
each step's **literal** body fields as `byEndpoint` overrides; fields holding
`{{refs}}` are dropped so the runner's own bind machinery (which the refs mirror)
fills them.

## `POST /api/docs/_run` — driving the walk headlessly

`POST /api/docs/_run` is the control-plane-gated HTTP door to `exerciseEndpoints` —
**in-process OR an infra bearer whose app-grants include `dev`** (no localhost
trust) — how the map's **Run all** and a headless agent/CI ask a *running* server
"does the whole composed process work right now?" without importing the app. A
headless caller presents the bearer as `Authorization: Bearer <bearer>`. The two
uses that matter
for an e2e/fix-cake session:

- **`scenario: "<name>"`** replays a saved `spec/misc/scenarios/` file (above); unknown
  name → `404`. This is how a committed scenario becomes a one-call regression check.
- **`dryRun: true`** → `{ order, cycles, unresolvedInputs }` with nothing executed — a
  cheap pre-flight that names dependency cycles and unsatisfied `$inputs` *before* you
  spend a real walk diagnosing a red cake.

`seeds` ride in the request body (a headless caller can't see `localStorage`) and are
**not coerced** — pass JSON-typed values. **The full request/response contract** (every
body field, `orderBy`/`skip`/`stream` ndjson shape, the `200` result row, the trust
posture) lives in the **`rune:framework`** skill's `references/endpoints.md`, beside the
`exerciseEndpoints` options it fronts — read it there, not here, so the contract has one
home.

## Dev mode — `KEEP_DEV` and `/api/docs/_dev`

`rune dev` drives a reload channel so open cake/map pages refresh themselves on a
new process. Set `KEEP_DEV=<status-file path>` and `bootstrapServer`:

- serves `GET /api/docs/_dev` → JSON `{ bootId, ...statusFileContents }` (any
  read/parse failure degrades to `{ bootId }` alone);
- injects a poller into every cake/map page: polls `_dev` while the page is
  visible, **reloads on a changed `bootId`** (a new process is serving), renders
  status-file `errors` in the page banner, shows "server restarting…" while
  unreachable, and stops permanently on a 404 (prod guard).

Session state lives in `localStorage`, so statuses/captures/edits survive the
reload. `rune dev` watches → re-checks/re-syncs the spec → restarts the app under
`KEEP_DEV` → pages reload themselves. (`rune dev` does **not** run `deno test`; it
is the app reloader — the unit loop belongs to `rune:build`.)
