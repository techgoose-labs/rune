# @techgoose-labs/rune

An opinionated Deno backend framework built on
[`@danet/core`](https://jsr.io/@danet/core). It bundles server bootstrapping
with automatic OpenAPI/Swagger docs, an infra-only auth layer (verifies
infra-signed session bearers offline against a published JWKS, with app-scoped
grants), an in-process API client with a private-key trust channel,
request-scoped structured logging to Datadog, and first-class sprig frontend
hosting.

> This package is the **runtime layer** of
> [rune](https://github.com/mrg-keystone/rune) — rune-generated projects target it.
> It also runs perfectly well standalone; this README documents that standalone
> surface.

## Quick Start

```typescript
import "reflect-metadata";
import { bootstrapServer, log, SwaggerDescription } from "@techgoose-labs/rune";
import { Controller, Get, Module } from "@danet/core";

@Controller("health")
class HealthController {
  @Get()
  check() {
    return { status: "ok" };
  }
}

@SwaggerDescription("Users API")
@Controller("users")
class UsersController {
  @Get()
  list() {
    return [{ id: 1, name: "Alice" }];
  }
}

@Module({ controllers: [HealthController] })
class HealthModule {}

@Module({ controllers: [UsersController] })
class UsersModule {}

@Module({ imports: [HealthModule, UsersModule] })
class AppModule {}

const server = await bootstrapServer("my-api", AppModule, { port: 3000 });
await server.listen();
```

This starts a server on port 3000 with:

- `/health` and `/users` endpoints
- `/docs` landing page with links to per-module Swagger specs
- ingress/egress logging for every request, shipped to Datadog (when
  `DD_API_KEY` is set)
- infra-bearer authorization on every **network** request (in-process callers
  are exempt) — see
  [Access tokens & authorization](#access-tokens--authorization)

## API

### `bootstrapServer(appName, module, options?)`

Creates and configures a server with optional Swagger documentation and request
logging.

- `appName` — used in every log line and as the Datadog `service`
- `module` — root application module class, or an **array of modules** (composed
  into one root internally via `appModule`; each keeps its own `/docs/<module>` page)
- `options.port` — port number (default: 3000)
- `options.swagger` — `true` (default), `false`, or `{ filters: string[] }` to
  exclude modules
- `options.onStart` — called **once** when the server goes live, with
  `{ backend, port }`. The first-class home for a background loop (an orchestrator
  heartbeat, a queue drainer) that `deno serve` can't host itself — it never runs
  `import.meta.main`. It fires from `listen()`, or lazily on the first request under
  the handler path (`deno serve` / `Deno.serve(app.handler)`), whichever comes
  first, and is **guarded to run at most once per server**, so a `--watch` reload
  or a double `listen()` can't start two intervals. Return a disposer
  (`() => clearInterval(id)`) and `stop()` runs it for you — no more hand-guarding
  a top-level `setInterval` with a `globalThis` symbol.
- `options.onStop` — called once during `stop()`, after the `onStart` disposer,
  with the same `{ backend, port }` — symmetric teardown.

```ts
const server = await bootstrapServer("my-api", AppModule, {
  onStart: ({ backend }) => {
    const id = setInterval(
      () => backend.fetch("/http/orchestrator-tick", { method: "POST" }),
      1000,
    );
    return () => clearInterval(id); // stop() disposes it
  },
});
```

Returns `{ listen(), stop(), backend, handler }`:

- `listen()` / `stop()` — start/stop the server on the configured port
- `backend` — in-process HTTP client (see
  [`backend`](#backend--in-process-http-client))
- `handler` — the raw `(Request) => Response` dispatcher (the same pipeline
  `listen()` serves); use it to serve without binding a port
  (`Deno.serve(handler)`) or to compose the backend into another app (see
  [Deployment](#deployment))

#### Logging environment variables

Logging is driven entirely by environment variables — nothing is passed in code:

| Variable                | Enables              | If missing                                                   |
| ----------------------- | -------------------- | ------------------------------------------------------------ |
| `DD_API_KEY`            | Datadog logging      | warns once, logs to console only                             |
| `POSTMARK_SERVER_TOKEN` | failure-alert emails | warns once, failures fall back to console                    |
| `POSTMARK_FROM`         | failure-alert emails | (required with the token) must be a verified Postmark sender |
| `POSTMARK_TO`           | —                    | alert recipient; defaults to `POSTMARK_FROM`                 |

The Datadog site is fixed to `us5.datadoghq.com`, and alert emails use a
5-minute cooldown.

#### Authorization environment variable

| Variable    | Enables                                                                                | Default / if blank                                                                               |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `INFRA_URL` | verifying infra-signed session bearers offline (JWKS) and polling the revoke-all flag  | defaults to the keystone infra when unset; set it empty (`INFRA_URL=`) to opt out (in-proc only) |

`INFRA_URL` is the base URL of the **infra** service; keep reaches
`<INFRA_URL>/authz/jwks` (infra's Ed25519 public keys, which it verifies bearers
against) and `<INFRA_URL>/authz/status` (the break-glass revoke-all flag it
polls). keep signs and mints nothing — infra does. **When `INFRA_URL` is unset it
defaults to the keystone infra (`https://infra.mrg-keystone.deno.net`)** so a keep
app authorizes out of the box; point a fork at its own infra by exporting
`INFRA_URL`, or opt out entirely with an explicit empty value (`INFRA_URL=`), in
which case no network request can authorize and only in-process callers do. See
[Access tokens & authorization](#access-tokens--authorization).

> **⚠️ Upgrading from 3.x → 4.x — the `INFRA_URL` default flipped.** On 3.x, infra
> bearer verification was **off** unless you set `INFRA_URL`. On 4.x it is **on by
> default** (unset now falls back to the keystone infra), so an app that authorized
> fine on 3.x may start rejecting bearers, or a local-dev flow that relied on the
> lax posture may behave differently. If you want the old "no infra, everything
> local" behavior — the local-dev `@Public` posture — set an **explicit empty**
> value: `INFRA_URL=`. Unsetting it is no longer the opt-out; it is now the opt-in.
> Boot logs a one-time warning on the empty-opt-out path so the choice is visible.

### Access tokens & authorization

The model is **deny-by-default, infra-only trust**: keep recognizes exactly two
things and denies everything else. It mints and signs nothing — infra does.

| Caller                            | How it's recognized                                               | Credential required?                       |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| In-process (`backend.fetch(...)`) | a process-private key stamped on the request (`x-danet-internal`) | **No** — trusted                           |
| Network with an infra session bearer | the bearer verifies **offline** against infra's published JWKS | **Yes** — the bearer                       |
| Anything else                     | neither of the above                                              | **Denied** — `401`                         |

There is **no localhost trust** — a request from `127.0.0.1` with no bearer is
denied like any other. The Swagger docs and the `/docs/_*` control
plane are gated to in-process **or** an infra bearer carrying the `dev` grant —
see [Docs access](#docs-access).

The in-process key is a random value minted at boot (`crypto.randomUUID()`),
shared only between the `backend` client and the auth middleware. It never
leaves the process — not an env var, not sent over the network, and redacted
from logs — so a network client cannot forge it. It's compared in constant time,
and is regenerated every boot.

> ### ⚠️ Security: the in-process bypass and how to mount safely
>
> `backend.fetch(...)` is a **trusted channel** — anything dispatched through it
> skips auth (that's how SSR calls your own API without a token). This is
> correct for _originating_ your own calls, but it is a footgun if you use it to
> **proxy inbound network traffic**: routing external requests through
> `backend.fetch` would serve them auth-exempt. **Never route inbound requests
> through `backend.fetch`.** To expose the API over the network, mount
> **`api.handler`** (via `Deno.serve` or `withBasePath`) — that's the network
> entry point.
>
> The framework makes the safe path safe by construction:
>
> - **`api.handler` strips the in-process trust header** from every inbound
>   request. So a network request — whatever it sends, however it's mounted or
>   proxied — can **never** impersonate an in-process call. In-process trust is
>   only granted to `backend.fetch`, which dispatches through a separate
>   non-stripping path.
> - **The OpenAPI spec requires the `dev` grant from the network.** The spec
>   (`/docs/<module>/json`) and the `/docs/_*` control plane are served to the
>   in-process client or an infra bearer whose app-grants include `dev` (or
>   `*`). Because `api.handler` strips the in-process trust header, a network
>   caller can never pose as in-process — so the API surface stays gated behind
>   the `dev` grant.
> - The in-process key is unguessable, never sent to the network, and redacted
>   from logs.
>
> Net: if you mount with `api.handler`, an integrator **cannot** accidentally
> expose the API or the docs. The only way to bypass auth is to deliberately
> pipe inbound traffic through `backend.fetch` — don't.

A network caller authorizes by sending its infra session bearer in the
`Authorization` header:

```
Authorization: Bearer <bearer>
```

The same bearer is also accepted as a **`?token=<bearer>`** query param. That's
for callers that can't set a header — a plain link, a first browser navigation,
or a WebSocket upgrade. Prefer the header where you can: a token in a URL can
leak via history and `Referer`, so the query value is **redacted from request
logs**, and the sprig frontend pattern below seeds it once from `?token=` then
sends it as a header thereafter.

**How a caller gets a bearer — all at infra.** keep never mints or exchanges
anything. A **Firebase user** signs in at infra (`POST /session/login`, Google
sign-in), and an **opaque infra token** is exchanged at infra (`POST
/authz/exchange`, public); either way infra returns an infra-signed session
bearer carrying the caller's per-app grants, which the client then presents to
keep. keep only **verifies** it offline (below).

The resolved identity is attributed to every log emitted during the request (it
appears as a `source` attribute alongside `requestId`): the bearer's `source`,
whose `creator` is a Firebase email or a machine token's creator.

#### `@Public()` — opt a route out of auth

Auth is enforced as a **global guard**, so it's **deny-by-default** on every
controller route. Mark a controller or a single handler `@Public()` to make a
credential optional there:

```ts
import { Public } from "@techgoose-labs/rune";

@Controller("inbound")
class WebhookController {
  @Public() // gated by its own webhook secret, not an infra bearer
  @Post()
  receive() {/* ... */}
}
```

- Class-level `@Public()` exempts every route on the controller; method-level
  exempts one.
- **Public means auth-optional, not auth-ignored**: a valid bearer on a
  `@Public` route is still verified and its `source` attached for logging — it
  just isn't required (an invalid one is ignored rather than rejected).
- It only covers **controllers** (DI routes). The framework's own direct routes
  (`/docs`, the `/docs/_*` control plane) aren't controllers — they self-gate,
  so they don't need `@Public`.
- Grep `@Public` to enumerate every unauthenticated route.

`@Public` is about **authentication** (is a credential required). For
**authorization** by identity domain or grant, use `@LoggedIn` / `@Grant`
(below).

#### `@LoggedIn()` and `@Grant()` — authorize by identity domain and grant

Authorization runs in the same global guard, right after authentication, and is
**fail-closed**. Two decorators, which stack with **AND**:

```ts
import { Grant, LoggedIn } from "@techgoose-labs/rune";

@Controller("users")
class UsersController {
  @LoggedIn("monsterrg.com") // identity email must be under this domain
  @Grant("admin") // AND the caller must hold this app's `admin` grant
  @Delete(":id")
  remove() {}
}
```

- **`@LoggedIn("monsterrg.com", …)`** — the caller's identity (`creator`, a
  Firebase email) must be under one of the listed email domains. A **machine
  token** (a non-email `creator`) never satisfies `@LoggedIn`.
- **`@Grant("developer", …)`** — the caller must hold **at least one** of the
  listed grants (**any-of**), scoped to **this app**. The dynamic form
  `@Grant("::key")` looks up `key` in the request (path param → query → header →
  JSON body) and requires the **found value** to be a grant the caller holds (an
  absent key → deny).
- Both **imply authentication** and override `@Public`: no bearer → `401`; a
  valid bearer that fails the domain/grant check → `403`. Method-level overrides
  class-level; the in-process client bypasses them like all auth.
- A controller route with **neither** `@LoggedIn` nor `@Grant` (and not
  `@Public`) is **closed to everyone** but the `*` universal ("skeleton") grant.

> `@Grants` (plural) is a **deprecated alias** of `@Grant`, kept only so existing
> `@Grants(...)` call sites keep working. Teach `@Grant`.

**Grants are app-scoped, namespaced `owner/repo:grant`** (e.g.
`mrg-keystone/rune:admin`). infra carries a user's per-app grants in the verified
bearer's `claims` map; the guard knows its own `appName` and checks **bare
names** against **this app's** grants (`claims[appName]`, a comma-separated
value). `*` is the skeleton key — a caller holding `*` holds all grants.

The resolved caller is attached to the request; read it in a handler with
`getIdentity(ctx)` → `{ creator, source, claims, grants }` (`grants` = this
app's grants).

#### `@Internal()` — an in-process-only route (silences the boot audit)

Boot runs a **route audit** that names every controller route declaring neither
`@Public` nor `@Grant`/`@LoggedIn` — deny-by-default leaves such a route reachable
only by the `*` skeleton grant, which is safe but indistinguishable from a route
someone _forgot_ to gate. For a route that is genuinely meant to be reached **only
by the in-process client** (`api.backend.fetch`) — an orchestrator tick endpoint, a
self-dispatched job — mark it `@Internal()` (alias: `@InProcessOnly()`):

```ts
@Controller("http")
class OrchestratorController {
  @Internal() // called only by the in-process tick loop — bare, but deliberately so
  @Post("orchestrator-tick")
  tick() {}
}
```

`@Internal()` changes **nothing about enforcement** — the route stays fail-closed
to external callers exactly as a bare one does. It only records that the bareness is
_intentional_, so the audit stops flagging it. Use it precisely when the right
posture is "no external caller, reached in-process" — not to skip gating a route
outsiders actually call. `KEEP_ROUTE_AUDIT=off` silences the whole audit.

#### The session bearer and offline verification

The bearer is **not a JWT** — it is infra's Ed25519-signed envelope:

```ts
interface BearerEnvelope {
  creator: string; // the identity — a Firebase email, or a machine token's creator
  source: string; // log-attribution label for this request
  sessionExpiry: string; // ISO-8601; short-lived (~1h), rejected once passed
  claims: Array<{ key: string; value: string }>; // per-app grants: key = app, value = "grant1,grant2"
  signature: string; // detached Ed25519 signature over canonicalize({creator, source, sessionExpiry, claims})
  kid: string; // selects infra's signing key (enables zero-downtime rotation)
}
```

keep accepts the bearer as raw JSON **or** base64url(JSON) on the wire, and
verifies it **offline** against infra's published JWKS — no shared secret,
nothing to leak:

- `GET <INFRA_URL>/authz/jwks` → `{ JwkKeyDtos: [{ kid, alg: "EdDSA", publicKey }] }`,
  fetched and cached; an unknown `kid` forces one refresh.
- `GET <INFRA_URL>/authz/status` → `{ revokeAll }`, polled ~every 60s.

`verifyToken(bearer, verifier)` rejects a bearer that is malformed, mis-signed,
or expired.

#### Revoke-all — break glass

When infra's polled `revokeAll` flag flips **on**, keep stops trusting **every
cached session bearer** and rejects it (`401`) until the client re-authenticates
at infra. A cached bearer can't be live-checked offline, so revoke-all is how an
operator instantly invalidates all outstanding bearers.

#### Docs access

The OpenAPI spec is gated to in-process **or** an infra bearer whose app-grants
include `dev` (or `*`), but a browser navigating to `/docs` can't send an
`Authorization` header — so docs use a **query-param → localStorage** flow:

- The doc pages (`/docs` and the per-module Swagger UI shells) are served
  **publicly** so they always load. The actual OpenAPI spec lives at a **gated**
  `/docs/<module>/json` endpoint.
- Open any doc page with `?token=<infra bearer>` (one carrying the `dev` grant).
  A small inline script saves the bearer to `localStorage` and strips it from
  the URL.
- Swagger UI then fetches the spec over XHR with `Authorization: Bearer <bearer>`
  from `localStorage` — which **persists across same-origin navigation**, so
  once seeded you can move between modules without re-supplying it.
- If the spec request returns `401` (bearer missing, invalid, expired, or
  lacking `dev`), the script **wipes** the stored bearer and shows a message to
  reopen with a fresh `?token=…` link.

So you share a `…/docs?token=…` link once; the bearer is reused from
`localStorage` until it stops working. This also works mounted under a sprig UI — the
shell derives the spec URL from its own path, so `/api/docs/<module>` fetches
`/api/docs/<module>/json`.

#### Browser access to your own API (frontend bearer)

The same query-param → `localStorage` flow works for your app's `/api`, so a
browser/island can call the gated API without you wiring a bearer into every
`fetch`. Drop this in a client entry (e.g. a sprig island or client bundle) — it seeds the
bearer from `?token=`, attaches it to same-origin `/api/*` requests, and drops it
when one comes back `401`:

```ts
const KEY = "danet:token";

// Seed once from ?token=, then strip it from the URL.
const url = new URL(location.href);
const seeded = url.searchParams.get("token");
if (seeded) {
  localStorage.setItem(KEY, seeded);
  url.searchParams.delete("token");
  history.replaceState(history.state, "", url.toString());
}

// Auto-attach on /api/* requests; clear on a 401 (stale/expired).
const isApi = (u: string) =>
  new URL(u, location.origin).pathname.startsWith("/api/");
const native = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const req = new Request(input as RequestInfo, init);
  const token = localStorage.getItem(KEY);
  if (token && isApi(req.url) && !req.headers.has("authorization")) {
    req.headers.set("authorization", `Bearer ${token}`);
  }
  const res = await native(req);
  if (token && isApi(req.url) && res.status === 401) {
    localStorage.removeItem(KEY);
  }
  return res;
};
```

You hand someone a `…/probe?token=…` link once; the browser remembers it and
authorizes every subsequent API call until it stops working. (Server-side
rendering should still prefer `api.backend.fetch(...)` — in-process, no bearer.
This is only for calls the browser itself makes over the network.)

> **A bearer in a URL can leak.** It can be shoulder-surfed, kept in history, or
> forwarded in a `Referer`. Infra session bearers are already short-lived (~1h),
> and this snippet moves the bearer to a header and strips it from the URL
> immediately, dropping a stale one on the next `401`. Still prefer the header
> where a caller can set it.

#### Programmatic verification (offline)

`bootstrapServer` wires bearer verification automatically from `INFRA_URL`. The
primitives are also exported if you need them standalone — keep only ever
**verifies** (infra signs):

```ts
import {
  createInfraClient,
  createJwksVerifier,
  TokenError,
  verifyToken,
} from "@techgoose-labs/rune";

const infra = createInfraClient({ baseUrl: Deno.env.get("INFRA_URL")! });
const verifier = createJwksVerifier({ fetchJwks: () => infra.jwks() });

try {
  const payload = await verifyToken(bearerFromClient, verifier);
  // payload: { iss, creator, source, claims, sessionExp }
} catch (err) {
  if (err instanceof TokenError) {/* malformed, mis-signed, or expired */}
}
```

The JWKS is fetched from `<INFRA_URL>/authz/jwks` and cached (kid-selected; an
unknown `kid` triggers one refresh). `infra.revocationStatus()` reads the
break-glass `revokeAll` flag from `<INFRA_URL>/authz/status`.

### `backend` — in-process HTTP client

The returned `backend` runs requests against the **exact** server pipeline
(controllers, guards, pipes, interceptors, exception filters, middleware) by
dispatching through the underlying handler — no port binding, no TCP, just an
`async` call. `bootstrapServer` itself only initializes (it does **not**
`listen()`), so `backend` is usable immediately, and importable from anywhere:

```typescript
// server.ts
export const app = await bootstrapServer("my-api", AppModule); // init only — non-blocking
// elsewhere.ts
import { app } from "./server.ts";
await app.backend.fetch("/users"); // ✅ no listen() required
```

#### `backend.fetch(input, init?)` — drop-in for global `fetch`

Mirrors the global `fetch` signature exactly and returns the raw `Response`.
Relative paths resolve against the server's origin, so they work here even
though global `fetch` would reject them:

```typescript
const res = await backend.fetch("/users"); // → Response
const json = await res.json();

await backend.fetch("/users", { // full RequestInit
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Bob" }),
});

await backend.fetch(new Request("http://localhost/users")); // Request object also works
```

Because it's `typeof fetch`, it's a true drop-in: swap `fetch` → `backend.fetch`
and any existing client code (your own wrappers, etc.) keeps working,
in-process.

Requests made through `backend` are recognized as in-process and **bypass token
auth** automatically (see
[Access tokens & authorization](#access-tokens--authorization)) — no token is
needed to call your own API from within the process.

### Logging

Every request is wrapped by a logging middleware that emits two correlated
entries:

```
[ingress my-api 8f3c…] GET /users     + { headers, query, body, routePath }   (structured)
[egress  my-api 8f3c…] GET /users     + { status, headers, body }             (structured)
```

The message carries the `[ingress|egress <appName> <requestId>]` tag; the
structured data is attached as log attributes — the expandable JSON ("the
zippy") in Datadog. The request id is taken from an inbound `x-request-id` /
`x-correlation-id` header, or generated, and is echoed back on the response's
`x-request-id` header. Egress level is derived from the status (`>=500` → error,
`>=400` → warn, else info). `authorization` / `cookie` headers are redacted.

#### `log` — request-scoped structured logger

Import `log` anywhere and call `log.<level>(message, data?)`. Inside a request
it is **automatically** tagged with `[<appName> <requestId>]` (matching the
surrounding ingress/egress) and `data` becomes the structured attributes:

```typescript
import { log } from "@techgoose-labs/rune";

class UsersService {
  create(dto: CreateUser) {
    log.info("creating user", { email: dto.email });
    // → console + Datadog: "[my-api 8f3c…] creating user"  { email, requestId }
  }
}
```

Levels: `log.debug`, `log.info`, `log.warn`, `log.error`. Outside a request the
tag is `[<appName>]`.

**Calls are synchronous** — `log.*` writes to the console and fires the Datadog
request, but never awaits the network itself. Each entry is stamped at **call
time** with an ISO `timestamp` and a monotonic `seq`, so ordering reflects when
`log()` was called, not when it was sent.

**Delivery** — each log fires its Datadog request **immediately, as the log
happens** (fire-and-forget), and the in-flight promises are collected on the
request. Just before the response is sent — on **any** status code, success or
error — the middleware `await`s them all (`Promise.all`), so every log request
has returned before the client gets its response. Sends started early (ingress,
mid-handler) overlap with the handler's work; the wait at the end is dominated
by the egress log, which is sent at the boundary.

A log request **never throws** into your code: each send is wrapped, and on
failure (network error or non-2xx from Datadog) the logger **falls back to
console** (surfacing the failure and the log) **and** raises a **Postmark alert
email** — the email throttled to one per `POSTMARK_ALERT_COOLDOWN_MS` window
(default 5 min) so an outage can't flood your inbox. Logs emitted outside a
request fire fire-and-forget.

> Note: awaiting before responding guarantees delivery but adds roughly one
> Datadog round-trip to each response (the egress send starts at the boundary).
> If you'd rather not block the response, the alternative is to let the sends
> complete off the response path (event loop on a long-running server, or
> `waitUntil` on serverless) — ask and it's a small switch.

#### Shipping to Datadog — environment gating

Having `DD_API_KEY` set means you *have* credentials, not that every run should
*ship*. Shipping is gated on environment so the key can live everywhere (a
deploy "just works") without local dev polluting production logs:

- **On Deno Deploy** (`DENO_DEPLOY=1`, set automatically) → ships, tagged
  `env:production`.
- **Locally, by default** → console only, even with the key present.
- **Locally with `KEEP_DD_LOCAL=1`** → ships, tagged `env:local` and prefixed
  `[LOCAL]` in the message, so it stays segmented from production in Datadog.

The `env` value rides on every entry as an `env:` Datadog tag (the reserved
environment facet). The site is `us5.datadoghq.com`. `KEEP_DD_LOCAL` gates both
logs and [traces](#shipping-to-an-apm-datadog-over-otlp) the same way.

### `withBasePath(prefix, handler)`

The low-level mount primitive — framework-agnostic. Wraps a root-based
`handler` so it can be mounted under `prefix`: requests whose path is `prefix`
or starts with `prefix + "/"` are dispatched with the prefix stripped (so the
root-registered routes still match); anything else returns `404`. Reach for it
directly when composing the handler into another host. (Hosting the backend
under a sprig UI is done with `serveSprig`/`sprigUi` from the separate
`@sprig/keep` package — see [Deployment](#deployment).)

### `createInfraClient({ baseUrl })` / `createJwksVerifier({ fetchJwks })`

The infra-verification primitives. `createInfraClient` returns a client for
infra's two public endpoints — `jwks()` (`GET <baseUrl>/authz/jwks`) and
`revocationStatus()` (`GET <baseUrl>/authz/status`). `createJwksVerifier`
returns a `verify(bearer)` that validates an infra session bearer **offline**
against that JWKS (Ed25519, kid-selected, cached), or throws `TokenError`.
`bootstrapServer` wires both automatically from `INFRA_URL`; exported for
standalone use. See
[Access tokens & authorization](#access-tokens--authorization).

### `setupWithSwagger(server)`

Lower-level alternative. Takes an existing `Server` instance and returns a
configured `HttpAdapter` with Swagger routes registered, without starting it.

### `@SwaggerDescription(description)`

Decorator to attach a custom description to a module's Swagger documentation.

### `Server`

Module registry. Create with `Server.create()`, register modules with
`registerModule()`.

### `DanetDocumentBuilder`

Generates OpenAPI 3.0 specification objects from module metadata.

### `InjectValue`, `InjectFactory`, `InjectClass`

Dependency injection container builders for configuring injectable services.

## Process endpoints, the cake, and the exercise harness

A module's endpoints can declare their **process order** and **data
dependencies** right on the handler, so keep can (1) serve them, (2) document
them in Swagger, (3) render an interactive **cake** per module, and
(4) drive them headlessly. This is the surface the
[`rune`](https://github.com/mrg-keystone/rune) workflow generates into.

### `@EndpointController` / `@Endpoint`

Write a thin controller whose handler delegates to your logic. `@Endpoint`
composes danet's route

- body decorators with `@danet/swagger`'s schema decorators, and records the
  process metadata. Type the handler's parameter as the input DTO — `@Endpoint`
  wires `@Body()` for you.

```ts
import { ApiProperty } from "jsr:@danet/swagger@2/decorators";
import {
  bootstrapServer,
  Endpoint,
  EndpointController,
  endpointModule,
} from "@techgoose-labs/rune";

class CreateOrderDto {
  @ApiProperty()
  item!: string;
}
class OrderDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  item!: string;
}
class PayDto {
  @ApiProperty()
  orderId!: string;
}
class ReceiptDto {
  @ApiProperty()
  receipt!: string;
}

@EndpointController("orders", { description: "Orders API" })
class OrdersController {
  @Endpoint({ input: CreateOrderDto, output: OrderDto, order: 1 })
  create(body: CreateOrderDto): OrderDto {
    return { id: "o_1", item: body.item };
  }

  // Runs after `create`; its request's `orderId` is filled from create's `id` output.
  @Endpoint({
    path: "pay",
    input: PayDto,
    output: ReceiptDto,
    order: 2,
    dependsOn: "create",
    bind: { orderId: "create.id" },
  })
  pay(body: PayDto): ReceiptDto {
    return { receipt: `paid ${body.orderId}` };
  }
}

export const api = await bootstrapServer(
  "shop",
  endpointModule("Orders", [OrdersController]),
);
```

`EndpointOptions`: `method` (default `"post"`), `path`, `input`/`output` DTO
classes, `order` (ascending), `dependsOn` (endpoint id(s) — handler method
names), `bind`, `flows`, `optional`, `stub`, `description`. The metadata rides
into each module's OpenAPI doc as an **`x-keep-process`** vendor extension.

`bind` values come in three forms:

- `"otherEndpointId.outputField"` — fill this field from a captured response;
- `"$name"` — an **external input** nothing in this module produces (an id
  minted by another module, a tenant key): the cake lists it under
  **Module inputs** and the runner takes it from `overrides.seeds[name]`;
- `["payCard.paymentId", "payCash.paymentId"]` — **alternatives**, first
  resolvable wins (the join after a branch).

`flows: "card"` puts the endpoint in a named branch — untagged endpoints belong
to every flow; the cake gets a flow selector and dependencies on endpoints
outside the active flow don't gate (so a join can depend on every alternative).
`optional: true` marks a step that's attempted but never blocks the walk.
`stub: true` marks a **generated stand-in** endpoint that mints placeholder
values — not part of the real process. The cake badges it with a `stub`
chip, and the contract auto-wiring treats it as a producer like any other (this
is what [`rune`](https://github.com/mrg-keystone/rune)'s ghost-stub module
generates for external inputs nothing produces yet).

### The cake (per module)

With Swagger on (default), each module gets three docs pages:

| Path                     | What                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `/docs/<module>`         | the **cake** — a Postman-style guided walk of the chain |
| `/docs/<module>/swagger` | the standard Swagger UI (deep inspection)                            |
| `/docs/<module>/json`    | the raw OpenAPI spec (token-gated; see [Docs access](#docs-access))  |

The cake lists endpoints in `order`/`dependsOn` order. Each step's request
body is generated from the DTO schema, with bound fields holding
**`{{step.field}}` references** that resolve against captured responses when
the request is sent — so your hand edits are never overwritten, and any value
can reference any earlier output (or a variable you define yourself). Run a
step and on success it drops a checkmark with status + timing, **captures its
outputs into a live variables panel**, and unlocks its dependents. A
**Run all in order** button walks the chain and stops on the first failure
with a banner saying exactly where and why; fix the step and run again to
resume. The walk **scrolls the active step into view and leaves boxes
collapsed** — nothing auto-expands, so the list stays easy to follow; open a
box yourself to inspect its request or response. Each step shows the concrete
request it _will send_, the response, a paste-ready curl, and a one-click
**copy of the route's full URL**. Re-running a step shows a **diff against the
previous response** (changed/added/removed paths, `old → new`) so "did my code
change break anything" is visible at a glance. The session (statuses, captured
outputs, variables, edited bodies) survives reloads — **Reset session** starts
fresh. Walking the list and eyeballing each response verifies the module's
logic end-to-end.

#### Expectations — green means *right*, not just 2xx

Every step has an **Expect** block under its response: pin an exact HTTP
status and any number of body checks (`path` `==`/`!=`/`contains`/`exists`
`value`, where the value may hold `{{refs}}` — e.g. `id == {{create.id}}`).
With expectations pinned, a step only goes green when the response **meets
them**: a 200 whose body is wrong turns the step red (`expect ✗`), shows each
check's verdict with the actual value, and stops Run all with the failing
expectation named in the banner. Expectations ride **Save fixtures** into
`spec/misc/cake.json`, so a committed artifact is a clickable contract test:
clone the repo, open the cake, Run all — green now means the process behaves,
not merely responds.

#### Scenarios — record and replay whole walks

The **Scenarios** rail card freezes the entire walk — the active flow, every
step's body text and params (refs intact), and skips — under a name, one JSON
file per scenario in **`spec/misc/scenarios/`** (`happy-path.json`,
`refund-flow.json`, …). **load** applies one over the page; **run** loads it
and runs all. They're served and saved through the control-plane-gated (in-process
or a `dev`-grant infra bearer) `GET`/`POST /docs/_scenarios`, and CI can replay
one headlessly:
`POST /docs/_run {"scenario": "happy-path"}` runs the saved flow with each
step's **literal** body fields as overrides (fields holding `{{refs}}` are left
to the runner's own bind machinery, which the refs mirror).

Beyond the chain: a module with `flows` gets a **flow selector** (walk one
branch at a time; run-all walks the active flow); declared `$inputs` appear in
a **Module inputs** card. Variables are shared **across modules**: every
captured output is also published as `{{module:step.field}}`, user variables
form a global environment, and references resolve recursively — point a module
input at `{{members:create.memberId}}` once and every re-run upstream feeds it
fresh. Dependency cycles are called out in a banner instead of leaving steps
mutely locked.

Composed modules **snap together** without any of that typing: when an
endpoint anywhere in the app (this module included) outputs a declared
`$input`'s field — **exactly, or as its plural collection** (`$tableName` ←
`tableNames[0]`) — the Module-inputs row shows a dim **`auto:
<module>:<endpoint>`** note instead of the amber "not set" state, and the
input is satisfied automatically from that producer's capture — run the
producer once (in any tab) and the consumer just works. Endpoints that merely
echo the field they consume never count as producers. Typing a value
overrides the auto-wiring; clearing it back to empty returns to auto.
Endpoints declared `stub: true` carry an amber **`stub`** chip marking them as
generated stand-ins minting placeholder values, not part of the real process.

#### Module setup & the `spec/misc/cake.json` artifact

`localStorage` keeps the working session, but a session is browser-local and
disappears with the cache. The **Module setup** rail card is the durable
counterpart. It holds **setup steps** — calls that put the system in a known
state _before_ the process runs (seed a tenant, flip a flag, create a
prerequisite record) — and they can target **any endpoint in the composed
app, not just this module**: the card's picker lists every module's endpoints,
so one cake page can stand up the whole app's state. Pick from the app
(generated bodies qualify their refs — `{{mint:create.id}}` — so they resolve
from the shared scope), or press **`+ setup`** in any step's Request panel to
snapshot its current request. Each step is editable in place (frozen body +
params), reorderable, and runnable alone; **Run setup** fires them all, and
**Run all** runs setup first, then the process walk, stopping with a banner if
a setup call fails. A cross-module setup step writes its result into **that
module's** session and the shared capture scope (the same write-back the
map's Run all uses), so every page agrees on what happened.

**Save fixtures** writes the whole configuration to **`spec/misc/cake.json`**:
this module's setup steps, its pinned **expectations**, plus every environment
variable you ticked **`persist`** (a checkbox next to each variable in the
Variables card). The file is plain JSON you can commit, so the setup and the
contract a process needs travel with the repo. On load, the cake reads it
back — even in a fresh browser with no `localStorage` — restoring setup,
expectations, and persisted variables as the baseline. The read/write door is
`POST`/`GET /docs/_fixtures`, on the **`/docs/_*` control-plane gate** like
`/docs/_run` (**in-process OR a `dev`-grant infra bearer** — no localhost trust);
the default path is `<cwd>/spec/misc/cake.json` when the project has a `spec/`
dir, else the legacy `<cwd>/fixtures/cake.json` (`KEEP_FIXTURES_DIR` overrides
the directory).

A sibling artifact, **`spec/misc/heal-rules.json`**, holds the project's tier
of the cake's heal panel: a declarative map from your API's **error slugs**
(`"not-enabled"`, `"not-armed"`, …) to one-click fixes (`run-step`,
`set-input`, `pick`, `retry`, `note`, …). keep ships only generic diagnosis
(missing inputs, validation shapes, transient retries) and executes your
rules for everything domain-specific; rune generates a starter file from the
spec's declared fault slugs. Served read-only at `GET /docs/_heal-rules`
(control-plane-gated: in-process or a `dev`-grant bearer); unknown rule kinds and
extra fields are ignored, so the file is forward-compatible.

### The system map — `/docs/_map`

`/docs/_map` renders the **whole composed app as one process graph**: every
module's endpoints as nodes grouped into module lanes, ordered left-to-right
by dependency depth. Solid edges are intra-module binds (`"step.field"`
autofill); **dashed edges** are `"$input"` contracts satisfied by a producer
in another module; a `$name` nothing produces shows as an amber input badge on
its consumer. Flows tint their edges, and optional/stub endpoints carry chips.
The map is **live**: each node's status dot recolors from the cake
sessions in `localStorage` — run a step on any docs page (any tab) and the map
updates. A **Run all** button runs the whole composed process server-side (the
control-plane-gated `/docs/_run` walk) **module by module, endpoint by endpoint**,
in the order the lanes draw — and it runs under the cake's own defaults: the
untagged-only walk (destructive flow branches never auto-run), your typed
environment variables as seeds, and each module's per-step skips honored.
Results **stream**: every call's outcome is written into that module's cake
session as it lands (status, response body, timing, captures + the shared
scope) and its node settles green/red while the rest keep pulsing. One source
of truth for run state: colors survive a reload, **already-open cake tabs
update live**, and opening a cake afterwards finds its steps green with
responses and captures pre-filled. When steps fail, **heal takes over**: each
failed name in the banner is a deep-link into its cake step, where the heal
panel is already lit with that run's actual failure.
Clicking a node **deep-links** into that module's cake with the step expanded
(`/docs/<module>#<endpointId>`). (Underscore-prefixed so a module named "map"
can still own `/docs/map`.)

### Dev mode — `KEEP_DEV` and `/docs/_dev`

Set **`KEEP_DEV=<status-file path>`** and `bootstrapServer` serves a
**`/docs/_dev`** JSON endpoint (the status file's contents plus the process's
`bootId`) and injects a small poller into every cake/map page. The pages
poll `_dev` while visible and **auto-reload when the `bootId` changes** (a new
process is serving); status-file `errors` render in the page banner, and a
"server restarting…" notice appears while the server is unreachable. Session
state lives in `localStorage`, so statuses, captures, and edited bodies
survive the reload. This is the channel
[`rune dev`](https://github.com/mrg-keystone/rune) drives — its watcher
checks/re-syncs the spec on save, restarts the app under `KEEP_DEV`, and the
open docs pages pick up the new boot by themselves.

### Request tracing — `/docs/_trace`, Deno KV, and Datadog APM

Every inbound request is captured as a **trace**: a tree of timed **spans**.
The root span is the whole request (opened automatically by the logging
middleware); each in-process `backend.fetch` sub-call becomes a span; and you
wrap your own hot functions so they show up as their own segment. A span that
throws is recorded as the trace's **crash point**. The same instrumentation
feeds two outputs — a zero-config local waterfall **and** your APM.

#### Instrumenting

```typescript
import { span, Traced, traceUser } from "@techgoose-labs/rune";

class Checkout {
  async run(cart: Cart) {
    traceUser(cart.memberId);                       // label this trace by user
    const total = await span("priceCart", () => priceCart(cart)); // inline span
    await span("chargeCard", () => charge(total));
    return total;
  }
}

class Pricing {
  @Traced()                                          // whole-method span "Pricing.price"
  async price(items: Item[]) { /* … */ }
}
```

`span(name, fn, meta?)` times `fn` as a child of the current span and is a
**pass-through outside a request**, so it's always safe to leave in. `@Traced()`
is the method-decorator form. `traceUser(id)` labels the trace with your own
identity; absent that, the trace is labeled with the verified token identity
(the logger `source`). The request root and `backend.fetch` sub-calls are
captured automatically — no annotation needed.

#### The waterfall — `/docs/_trace`

`/docs/_trace` renders recent requests as bars; expand one for the full
waterfall — every span positioned by start time, sized by duration, coloured by
kind (request / backend / your function), with a ✖ on the span that crashed.
A filter bar narrows by **route**, **method**, **status** (ok / crashed) and
**user** (selecting a user re-queries server-side); each row carries a clickable
user chip. The page polls the **control-plane-gated** `/docs/_traces` JSON route
(in-process or a `dev`-grant bearer; traces carry route paths and error messages,
so the data is never exposed to
the network; the page shell loads publicly like the other docs pages).

#### Storage — in-memory ring or Deno KV

By default the last **200** traces live in an in-memory ring buffer (size with
`KEEP_TRACE_BUFFER`, disable capture with `KEEP_TRACE=off`). Set
**`KEEP_TRACE_KV`** (`1`/`true` → the default KV location, or a path) to persist
to **Deno KV** instead, so the UI survives restarts and looks past the in-memory
window. Traces are stored time-ordered **and** indexed by user, so the
newest-first list and `?user=` lookups are fast indexed scans; every key carries
a TTL (`KEEP_TRACE_TTL_DAYS`, default 7) so storage stays bounded. On Deno Deploy
`KEEP_TRACE_KV=1` uses the hosted KV automatically. (Requires `--unstable-kv`;
without it, capture degrades to the in-memory ring with a one-time warning.)

#### Shipping to an APM (Datadog) over OTLP

Set **`KEEP_TRACE_OTLP_URL`** to an OTLP/HTTP endpoint — a Datadog Agent or an
OpenTelemetry Collector — and each finished trace is serialised to OTLP/JSON and
**POSTed at request end**. There is no OpenTelemetry SDK and no extra
dependency: the whole tree is already in memory, so it's just `JSON.stringify` +
one `fetch`. The POST is **fire-and-forget but flushed** — its promise rides the
same `pending` list the logs use, so `settle()` awaits it right before the
response returns (the logger pattern, reused). `/v1/traces` is appended to the
URL if absent.

- **Gating mirrors the logs** (see [Logging](#logging)): ships from **Deno
  Deploy automatically** (`DENO_DEPLOY=1`), and from **local only with
  `KEEP_DD_LOCAL=1`**. Traces are tagged `service.name` = your app and
  `deployment.environment` = `production`/`local`.
- **Guard header:** set **`KEEP_TRACE_OTLP_TOKEN`** and every POST carries
  `X-Keep-Token: <token>`, so the OTLP endpoint can be exposed publicly behind a
  reverse proxy that only routes requests bearing the secret.

```bash
KEEP_TRACE_OTLP_URL=https://otlp.example.com   # → POSTs to /v1/traces
KEEP_TRACE_OTLP_TOKEN=<shared-secret>          # sent as X-Keep-Token
# locally, also: KEEP_DD_LOCAL=1
```

The Datadog Agent's OTLP HTTP receiver accepts JSON natively (it's the
OpenTelemetry Collector receiver; `application/json` → JSON, dispatched by
`Content-Type`). A working Agent + Traefik deployment, including the secret-guard
routing and a verification runbook, is documented in
[`docs/datadog-agent.md`](../docs/datadog-agent.md).

| Env var | Effect |
| --- | ------ |
| `KEEP_TRACE` | `off` disables trace capture entirely |
| `KEEP_TRACE_BUFFER` | in-memory ring size (default 200) |
| `KEEP_TRACE_KV` | `1`/`true`/`<path>` → persist traces to Deno KV (needs `--unstable-kv`) |
| `KEEP_TRACE_TTL_DAYS` | Deno KV retention in days (default 7) |
| `KEEP_TRACE_OTLP_URL` | OTLP/HTTP endpoint to ship traces to (Agent/Collector) |
| `KEEP_TRACE_OTLP_TOKEN` | shared secret sent as `X-Keep-Token` on each OTLP POST |
| `KEEP_DD_LOCAL` | ship logs **and** traces to Datadog from a local (non-Deploy) run |

### `exerciseEndpoints(opts)` — headless runner

The same metadata, run programmatically (for CI / agents). Discovers endpoints
from the bootstrapped app's `docs`, orders them, runs them while chaining
outputs into inputs via `bind`, rate-limits, and loops until green.

```ts
import { exerciseEndpoints } from "@techgoose-labs/rune";

const report = await exerciseEndpoints({ api }); // in-process (backend.fetch), no token
// report: { passed, failed, optionalFailed, iterations, order, cycles }

// One branch at a time, with external inputs seeded:
await exerciseEndpoints({ api, flow: "card", overrides: { seeds: { memberId: "m-7" } } });
```

- **Transport.** No `baseUrl` → dispatches in-process via `backend.fetch` (no
  port, bypasses auth) — the default for tests/CI. With `baseUrl` (a running
  server) it uses **Playwright's `APIRequestContext`** over real HTTP.
- **`overrides`.** `seeds` (literal values by field name), `byEndpoint`
  (per-endpoint overrides by id — win over `bind`), and `auth`
  (`{kind:"in-process"}` default, or a ready infra session bearer as
  `{kind:"token", token}` / `{kind:"bearer", bearer}` for network/`baseUrl`
  runs — keep mints nothing; obtain the bearer from infra).
- **`$`-input resolution order.** A `"$name"` bind resolves from
  `overrides.seeds[name]` first — a seed always wins. With no seed,
  **composition fulfills the contract**: the value falls back to the first
  captured response (in run order) owning a same-named field — or, failing
  that, a same-named **plural collection** (`name + "s"`) whose first scalar
  element supplies the value (`$tableName` ← `discover.tableNames[0]`): the
  list→item pattern auto-wires. The runner adds a synthetic dependency edge
  from the consumer to that producer, so the producer runs first and the
  fallback hits on pass one — a composed app with stub or real producers
  needs no seeds at all. **Echoes never count as producers**: an endpoint
  that consumes the very field it outputs can't bootstrap a value, so it is
  excluded from producer matching, `unresolvedInputs`, and map edges.
- **Required fields with real examples are filled.** A required input field
  with no seed/bind fills from its schema `example` when one is declared
  (typed zeros like `0`/`false` count; the empty-string placeholder doesn't) —
  matching the cake's generated bodies.
- **Transient retries** (`retry: { slugs, delayMs?, attempts? }`): a failed
  response whose `body.message` matches a listed slug is re-attempted after a
  delay instead of failing the walk. `/docs/_run` derives the slugs from the
  project's heal rules (`retry` actions in `spec/misc/heal-rules.json`) plus
  the built-in transients (`timeout`, `rate-limited`) — heal knowledge feeds
  the runner, not just the UI.
- **`rateLimit`** (`{ requestsPerSecond?, maxConcurrency? }`) and
  **`maxIterations`** (default 5).
- **Report rows** carry `{ id, module, method, path, ok, status, attempts,
  ms, body }` — the response body and per-call timing ride along, so a caller
  (CI, the system map's write-back) can show or replay outcomes, not just
  pass/fail.

Against a **running** server, `POST /docs/_run` (control-plane-gated: in-process
or a `dev`-grant bearer) is the HTTP
door to the same walk: `{ flow?, seeds?, byEndpoint?, rateLimit?,
maxIterations?, dryRun?, scenario?, orderBy?, skip?, stream? }` —
`scenario: "happy-path"` replays a saved `spec/misc/scenarios/` file (its flow
+ literal body fields); `orderBy: "module"` walks lane-by-lane (modules in
docs order, topological within — forward cross-module deps converge on a
later iteration); `skip: ["module:op", …]` excludes steps like the cake's
skip toggle; `stream: true` returns ndjson — one `{kind:"result",…}` line per
call as it completes, then a final `{kind:"done",…}` summary (what the map's
Run all consumes); `dryRun: true` returns just
`order`/`cycles`/`unresolvedInputs` without firing a request.

> **Playwright is an optional peer.** It's only loaded when you pass a
> `baseUrl`; in-process runs (and everything else in keep) need no browser.
> Provision it (`deno run -A npm:playwright install` or set
> `PLAYWRIGHT_BROWSERS_PATH`) only for `baseUrl` runs — note the
> `APIRequestContext` path uses Playwright's HTTP client, not a browser.

## Deployment

The same bootstrapped backend runs in two shapes: **standalone** (a normal HTTP
server) or **hosted** under a sprig frontend, sharing the in-process client.
Both are driven by two things `bootstrapServer` returns:

- `handler` — the raw `(Request) => Response` dispatcher (the same pipeline
  `listen()` serves).
- `backend` — the in-process client (`backend.fetch(...)`), which bypasses auth
  (trusted in-process).

Bootstrap once in a shared module (init only — it does **not** `listen()`):

```ts
// backend.ts
import { bootstrapServer } from "@techgoose-labs/rune";
import { AppModule } from "./app.module.ts";

export const api = await bootstrapServer("my-api", AppModule);
```

(No `import "reflect-metadata"` needed — the package loads the Reflect polyfill
itself.)

### Standalone

Serve the handler directly — works locally and on Deno Deploy:

```ts
// server.ts
import { api } from "./backend.ts";

// Forward Deno's conn info so request logging/tracing can attribute the caller.
Deno.serve((req, info) => api.handler(req, info)); // or: await api.listen();
```

> **Forward `info`.** `api.handler` takes `(req, info?)`. When you dispatch
> through it from your own `Deno.serve`, pass the second `info` argument — it
> carries `remoteAddr`, which request logging and tracing attribute the caller
> with. Auth doesn't depend on it (trust is the in-process key or an infra
> bearer), but keep forwarding it so logs stay attributable.

Network clients must send an infra session bearer (`Authorization: Bearer
<bearer>`); see [Access tokens & authorization](#access-tokens--authorization).

### Hosted under a sprig frontend

The frontend is **sprig**, and the composition lives in the separate sprig
package [`@sprig/keep`](https://jsr.io/@sprig/keep). `serveSprig({ keep, app,
base })` returns a single `{ fetch }` default export — run it with `deno serve
serve.ts` (**not** `Deno.serve()`):

```ts
// serve.ts
import { serveSprig } from "@sprig/keep";
import app from "./app/src/main.ts"; // the sprig SSR app
import { api } from "./backend.ts";

export default serveSprig({ keep: api, app });
```

`serveSprig` routes `/api/*` and `/docs*` to the keep's `handler` (forwarding
conn info for request attribution) and everything else to the sprig SSR app,
with the keep's in-process `backend.fetch` bound to sprig's `Backend` DI token.
SSR pages read data through that in-process channel, with no network hop and no
bearer:

```ts
// a sprig page's resolve.ts (or a service)
import { inject } from "@sprig/core";
import { Backend } from "@sprig/keep";

export async function resolve() {
  const res = await inject(Backend).fetch("/users"); // in-process; no bearer needed
  return { users: await res.json() };
}
```

So one Deno Deploy process serves the sprig UI, exposes the token-gated API at
`/api/*` for browser/external callers, and lets SSR reach the backend
in-process. The backend stays fully runnable standalone — same `api`, different
entry.

`rune init` scaffolds this whole sprig+keep app: a `serve.ts` composition root,
an `app/` sprig UI tree (`app/src/main.ts` + a starter page), the `bootstrap/`
keep backend, and a `deno.json` wired with `@sprig/core` + `@techgoose-labs/rune`
and a `deno serve serve.ts` start task.

`bootstrapServer` is **bundler-safe**: it lazy-loads the Swagger builder (and
its CommonJS `handlebars` dependency), so importing the backend into a bundled
SSR frontend works in both dev and production builds.

To mount the sprig UI inside an existing host (`Deno.serve`, Danet, Hono), use
`sprigUi(config)` — a framework-agnostic middleware that returns
`Response | null` (`null` = pass-through, so the host handles the route). To
mount the keep's `handler` under a prefix in any host, reach for the lower-level
[`withBasePath(prefix, handler)`](#withbasepathprefix-handler) directly.

Browser islands can't make in-process calls, so for browser-side calls that go
over the network to `/api` (an island's `fetch`), attach an **infra session
bearer** — seeded from `?token=` and auto-injected from `localStorage` (see
[Browser access to your own API](#browser-access-to-your-own-api-frontend-bearer)).
Server-side rendering should always prefer the in-process `inject(Backend)`
path, which needs no credential.

**Deno Deploy notes**

- Env vars in the Deploy project are optional for infra: `INFRA_URL` defaults to
  the keystone infra, so keep verifies session bearers against its JWKS and polls
  revoke-all out of the box — only set `INFRA_URL` to target a different infra (or
  empty to disable). Add `DD_API_KEY` / `POSTMARK_*` as needed.
- The start command is `deno serve serve.ts` — `serveSprig` returns the
  `{ fetch }` export `deno serve` expects, and the backend singleton runs in the
  same process as the UI.
- keep mints nothing — clients obtain their bearer from infra
  (`session.login` / `authz.exchange`) and present it (see above).

## Testing

```sh
deno test -A --unstable-raw-imports
```

## Releasing

Every push to `main` publishes to JSR via `.github/workflows/publish.yml`
(reusable — it derives scope/package from `deno.json`'s `name`; drop it plus
`scripts/check-jsr-deps.ts` into any JSR repo with a `JSR_TOKEN` secret):

- A **preflight** emulates JSR's server-side dependency validation locally
  (`jsr:` subpath exports across all versions matching each range) plus a
  `deno publish --dry-run`, so bad packages fail in seconds instead of after a
  ~10-minute server round trip.
- If `deno.json`'s version is **not yet on JSR**, it publishes as-is — set the
  version yourself to cut a specific release. Otherwise the next version is
  derived from the latest published one: **patch** by default, **minor** when
  the push contains a `feat:` commit, **major** on `!:` / `BREAKING CHANGE` —
  and the bump is committed back to `main`.
- The publish step polls the JSR API instead of trusting the CLI: `deno
  publish` neither exits after a successful publish nor reports a failed
  server-side task. Server-side processing alone has taken **~22 minutes** for
  this package, so a silent "Publishing ..." for a long while is normal.
- **Do not cancel a publish run that looks hung.** JSR's backend does not
  release the package transaction lock when the client disconnects, so the
  next publish attempt hangs too
  ([jsr-io/jsr#1448](https://github.com/jsr-io/jsr/issues/1448)). Let the
  20-minute window expire — a task failure surfaces its real error within
  ~20 seconds; only a stuck-in-processing task waits the window out. Stuck
  tasks can be requeued from the package's publishing-tasks page on jsr.io.
