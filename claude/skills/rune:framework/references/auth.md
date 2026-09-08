# Auth: keep ships none — it is the third slot

Read this before reasoning about auth in a keep app. **keep ships ZERO auth of
its own**, and has since 5.0: no infra trust, no session store, no grants, no
route guard, no token exchange. What changed in 7.0 is where auth *goes*.

Until 7.0 the advice was "compose a guard into the backend's own handler". That
advice is retired, because it never actually held: a guard inside keep's handler
covers keep's routes, but an app is more than its backend — the UI's own routes,
the auth endpoints, and a scope-less dispatch from a cron tick all live outside
it. Auth is now a **slot in the composition root**, above every unit:

```ts
// serve.ts (git root)
export default Bedrock({ ui: Frontend(), backend: api, auth: Infra() });
```

## What an auth unit is

A `Unit` like any other, with one extra obligation — `verify`:

```ts
verify(req: Request, bag: Bag): Identity | null | Response
```

It **authenticates**; bedrock **authorizes**. Returning an `Identity` says who
the caller is; `null` says "anonymous"; a `Response` is an escape hatch for a
check the policy table cannot express (an org-scoped rule that depends on route
params). The unit also serves its own routes at `/auth` — `login`, `exchange`,
`me`, `logout` — including `GET /auth/login`, which is where bedrock redirects a
denied browser navigation.

Nothing is passed to the slot. `Infra()` takes no arguments: everything it needs
it reads from its own env or receives through the bag and the envelope.

## Coverage is the point

`verify` runs above every unit on **every channel**:

| Channel | What it is |
| --- | --- |
| `network` | a request off the socket |
| `in-process` | a call through the bag's client — SSR reads, unit-to-unit |
| `scope-less` | `app.client` — a cron tick, a test, the headless runner |

That third row is the one no app-composed wrapper ever covered, and the second
is the one a wrapper *silently* missed: the in-process client dispatched
straight into the handler and never traversed it, so SSR reads ran
unauthenticated. Both are guarded now, by construction, because every dispatch
enters the root.

A scope-less call being denied is **correct behavior**, not a bug: there is no
request to be bound to and so no ambient credential. `exerciseEndpoints` and
`POST /api/docs/_run` take a `credential` for exactly this — never a bypass.

## Where a route's policy comes from

Not a decorator, and not the guard's own opinion. It is declared in the spec,
beside the endpoint:

```
[REQ:open] health.check(EmptyDto): StatusDto
```

`[REQ:open]` is the **openness marker** — this endpoint is reachable without a
credential. The chain from there is mechanical:

`[REQ:open]` → `access: "open"` on the generated `@Endpoint` →
`x-bedrock-auth: { access: "open" }` on the operation's OpenAPI →
a row in the `Policy` table keep's unit hands bedrock → bedrock resolves it.

An **unmarked** `[REQ]` gets no extension at all, which bedrock reads as the slot
default — `authenticated` for the `backend` slot. Silence and an explicit
"authenticated" stay distinguishable, so nothing has to guess what silence meant.

This is what retired infra's hand-applied `@Open()`: openness used to be a
decorator re-added to generated controllers after every regeneration, where a
missed one silently exposed (or silently closed) a route. It is a line in the
spec now, and `rune sync` twice leaves no diff.

## Reading the caller

```ts
import { channel, identity, requestId } from "@mrg-keystone/rune";

@Get("me")
me(@Req() req: Request) {
  return identity(req);   // Identity | null
}
```

It cannot be forged. The three envelope headers — `x-bedrock-request-id`,
`x-bedrock-channel`, `x-bedrock-identity` — are **stripped from every inbound
request at the root**, on every channel including a nested in-process dispatch,
before the guard runs; the identity header is written only on an allow. So the
header's presence below the root is proof, and there is nothing an outside
caller can send that survives.

## Diagnosing a 401/403

In order of likelihood:

1. **No `[REQ:open]`** on a route that should be public. Read the spec, not the
   controller — generated code carries no auth decorator to inspect.
2. **The auth unit's `verify` returned `null`** for this credential. Reproduce
   with and without it, on both channels.
3. **A scope-less dispatch with no `credential`** — see above; correct behavior.
4. **Version skew** — the app still pinned `@mrg-keystone/rune@^4` or older,
   whose deny-by-default guard 401s bare network callers. Check the pin first.
5. **Something in front** — a proxy or platform edge.

The check that proves coverage: drop the credential entirely and issue the same
read once via SSR (in-process) and once over the network — **both** must come
back blocked. bedrock's guard vectors run exactly this matrix, per channel, in
bedrock's CI, keep's, and infra's.

Cookie fidelity is the substrate: the in-process client carries the incoming
request's own `Cookie` header and honors `Set-Cookie` bidirectionally, exactly
like a page's own `fetch` — so a cookie-based `verify` sees identical
credentials on both channels with zero plumbing.

## Removed env vars

`INFRA_URL`, `INFRA_JWKS_URL`, `INFRA_JWKS_TTL_SECONDS`,
`INFRA_POLL_INTERVAL_MS`, `KEEP_ROUTE_AUDIT`, `KEEP_SESSION_KV`,
`KEEP_SESSION_TTL_DAYS`, `HONOR_SKELETON` are inert; bedrock's env registry
warns once when one is set. `POSTMARK_TO` was renamed `ALERT_RECIPIENTS`
(dropped hard — migrate the value; the old name does nothing).

`INFRA_URL` returns in one place only, and it is not keep's: it is the auth
unit's own config, selecting authority mode from relying-party mode.

## The `/api/docs` surface

The docs pages, the OpenAPI spec at `/api/docs/<module>/json`, and the
control-plane doors (`/api/docs/_run`, `_heal`, `_traces`, `_fixtures`,
`_scenarios`, `_heal-rules`) are policy rows keep's unit declares (D-11): **open
in dev** (`KEEP_DEV` set) and whenever no auth unit is composed, **authenticated**
otherwise. That restores the gate the old "localhost-only" comments claimed and
no code enforced.

The legacy `?token=` seeding script is gone rather than left inert: access is
answered above the page now, so there was nothing left for it to do.
