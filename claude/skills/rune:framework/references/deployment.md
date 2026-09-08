# Deployment, the in-process client, logging, and releasing

## One bootstrap, one composition root

`bootstrapServer` **initializes only** (no socket), so bootstrap once in a
shared module and import it everywhere:

```ts
// server/bootstrap/mod.ts
import { bootstrapServer } from "@techgoose-labs/rune";
import { modules } from "./modules.ts";
export const api = await bootstrapServer("my-api", modules);
```

No `import "reflect-metadata"` needed — the package loads the polyfill itself.

### `bootstrapServer` returns a UNIT

Since keep 7.0 it resolves to a **bedrock `Unit`** — the backend half of an app
— plus keep's own surface (`listen`, `stop`, `backend`, `docs`, `mount`,
`policy`). keep is no longer a composition root: it does not own a socket, a
logger, an env table, a request id, or a guard. Those belong to
`@techgoose-labs/bedrock`, once, for the whole app.

### The composition root

ONE call composes the app, in the git-root `serve.ts` that both toolchains
generate identically (D-18 — same bytes whichever `init` ran first):

```ts
// serve.ts  (git root — GENERATED, carries BEDROCK_SERVE_MARKER)
import { Bedrock } from "@techgoose-labs/bedrock";
import { Frontend } from "@techgoose-labs/sprig/bedrock";
import { Infra } from "@techgoose-labs/infra";
import { api } from "./server/bootstrap/mod.ts";
export default Bedrock({ ui: Frontend(), backend: api, auth: Infra() });
```

Every slot is optional and every subset serves:

```ts
Bedrock({ backend: api })                    // backend alone
Bedrock({ ui: Frontend(), backend: api })    // full-stack
Bedrock({ ui: Frontend() })                  // frontend alone
```

Slot defaults: `ui` → `/`, open; `backend` → `/api`, authenticated for every
route not declared open; `auth` → `/auth`, open. Namespaces must be disjoint or
composition fails loud. `Bedrock(...)` returns a callable `App` — a handler with
`client`, `listen`, `stop` and `units` on it — so the runtime's serve command,
`Deno.serve(app)` and `export default app` all work unchanged.

### Standalone

```ts
await Bedrock({ backend: api }).listen();   // or api.listen(), which IS that
```

`api.listen()` / `api.stop()` / `api.backend` are adapters over a PRIVATE
`Bedrock({ backend: api })` — so even "just the backend" runs through the same
instrumented root, the same guard, and the same one client. `info` is forwarded
by the root, so `remoteAddr` reaches capture and tracing without you threading
it.

### Wire paths — one client, both scopes

The in-process client takes the SAME paths a browser would (D-7):

```ts
bag.fetch("/api/users")        // NOT "/users"
bag.fetch("/auth/me")
```

No implicit mount, and no route-space/wire-path split to remember. A unit
receives its client in the **bag** — the third handler argument,
`{ fetch, app, policy }`; outside a request, `app.client` is the scope-less one.
In scope the client is request-bound: SSR reads carry the incoming request's own
cookies, and `Set-Cookie` from those calls is collected onto the outer browser
response. Islands call `/api/*` over the wire; the two channels are
byte-identical by contract — the parity suite gates it, in bedrock and against a
real keep backend.

Every cross-unit call goes through this client (D-13) — never a direct handler
call, a cross-unit import, or a self-addressed network `fetch`.

### Auth is a slot, not a wrapper

keep still ships zero auth of its own, but "wrap the composition in your own
guard" is retired: an auth **unit** goes in the third slot, and bedrock runs its
`verify` above every unit on every channel — network, in-process and scope-less
alike, which is the placement no app-side wrapper could achieve. A controller
reads the result with `identity(ctx)` and cannot forge it (the envelope is
stripped inbound at the root).

Which routes need a credential comes from the spec: `[REQ:open]` marks an
endpoint reachable without one; everything unmarked is authenticated. That
travels as `x-bedrock-auth` on the operation's OpenAPI into the policy table
keep's unit hands bedrock — there is no guard decorator to hand-apply to
generated code any more.

`bootstrapServer` is bundler-safe (lazy-loads the Swagger builder and its CJS
`handlebars` dep), so importing the backend into a bundled SSR frontend works in
both dev and production builds.

`rune init` scaffolds the whole app: the git-root `serve.ts` composition root, a
`ui/` sprig UI package, the `server/` keep backend, and a git-root workspace
`deno.json` (`["./ui","./server"]`) wired with `@techgoose-labs/sprig`,
`@techgoose-labs/rune` and `@techgoose-labs/bedrock` — the last hoisted to the root
only, so the app can never resolve two bedrock copies and end up with two roots.

### Mounting under any host

To mount the app under a prefix inside another host, use
`withBasePath(prefix, handler)` from bedrock: it dispatches `prefix`-rooted
requests with the prefix stripped and 404s the rest. A unit that strips its own
prefix declares `mountsSelf` instead — which is how keep is mounted, and what
makes a WebSocket upgrade through `/api` work at all (the route must receive the
ORIGINAL request).

**Deno Deploy:** signal listeners are skipped there (the platform owns process
lifetime). Configure observability as needed: `DD_API_KEY`,
`POSTMARK_SERVER_TOKEN`/`POSTMARK_FROM` (+ optional `ALERT_RECIPIENTS`). Every
one of those is read once, by bedrock, from its single env registry.

## Logging

Observability is bedrock's, at ONE boundary: a dispatch is captured once, on
every channel, and the `requestId` minted there joins the capture entry, the log
lines and the trace. keep's own ingress/egress middleware is gone with the
double-counting it caused.

`log.<debug|info|warn|error>(message, data?)` from anywhere — inside a request
it is auto-tagged with the scope's request id and `data` becomes structured
attributes. Calls are synchronous (never await the network); each entry is
stamped at call time.

The correlation id is NOT adopted from an inbound header, and is not echoed on
the response: the envelope's `x-bedrock-*` headers are stripped at the root
precisely so a caller cannot choose the id its lines are filed under. Read it
inside a handler with `requestId(ctx)`.

Delivery: each log fires its Datadog request immediately (fire-and-forget) and
the boundary awaits them all before the response is returned — delivery is
guaranteed. A failed send never throws into your code: it falls back to console
and raises a throttled Postmark alert (coalescing the suppressed count). The
Datadog site is fixed to `us5.datadoghq.com`.

## Smaller exports

- `identity(ctx)` / `channel(ctx)` / `requestId(ctx)` — read the envelope a
  controller was reached with.
- `setupWithSwagger(server)` — configure an existing `Server` with Swagger
  routes, without starting it.
- `@SwaggerDescription(text)` — module-level Swagger description.
- `Server`, `DanetDocumentBuilder` — the lower-level registry / OpenAPI builder.
- `InjectValue`, `InjectFactory`, `InjectClass` — DI container builders.
- `checkBody` + `MAX_BODY_BYTES`/`MAX_JSON_DEPTH` — the request-validation
  gateway keep's unit applies (415 on a non-JSON body, 400 on oversized,
  over-nested, or unparseable).

Deprecated for one release, removed in keep 8: `api.compose({ frontend })` and
`Backend(appName, modules, { frontend })` — both are thin adapters over
`Bedrock({ ui, backend })` and log a one-time notice. The lifted runtime
(`withBasePath`, `RequestJar`, `collectSetCookies`, `log`, `tracer`, the
contract stamp) is re-exported from keep for the same one release; import it
from `@techgoose-labs/bedrock` in new code.

## Testing and releasing the keep repo itself

- Unit tests: `deno task test`. Browser (cake/map) tests:
  `deno task test:browser` (needs chromium:
  `deno run -A npm:playwright install chromium chromium-headless-shell`).
  E2E fixtures: `KEEP_BROWSER=1 deno task test:e2e`. Publish dry-run:
  `deno task check:jsr`.
- Every push to `main` publishes to JSR via `.github/workflows/publish.yml`:
  preflight emulates JSR's server-side dependency validation locally; the
  version auto-bumps from the latest published (patch default, minor on
  `feat:`, major on a breaking marker) and the bump is committed back.
- **Never cancel a publish run that looks hung** — JSR's backend keeps the
  package lock when the client disconnects (jsr-io/jsr#1448), wedging the
  next attempt too. Server-side processing alone has taken ~22 minutes; a
  real task failure surfaces its error within ~20s via the task API the
  workflow polls.
