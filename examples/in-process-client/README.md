# Examples

Runnable example of rune's runtime (`@techgoose-labs/rune`).

## In-process client (`in-process-client/`)

Shows the `backend` client returned by `bootstrapServer` — an in-process HTTP
client whose `fetch` is a drop-in for the global `fetch`, but which dispatches
against the **exact** server pipeline (controllers, guards, pipes, interceptors,
exception filters, middleware) **without binding a port or touching the
network**.

### Run it

```bash
deno task example
# or
deno run -A examples/in-process-client/main.ts
```

Expected output:

```
GET /users        → 200 [ { id: 1, name: "Alice" } ]
POST /users       → 200 { id: 2, name: "Bob" }
GET /users/2      → 200 { id: 2, name: "Bob" }
GET /users/999    → 404 {"status":404,"description":"Not found","name":"NotFoundException","message":"404 - Not found"}
```

(Each request also prints `[ingress …]` / `[egress …]` log lines — that's the
logging middleware running in the pipeline, in-process.)

### The files

| File        | What it shows                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users.ts`  | An ordinary Danet `@Controller` + `@Module` — a tiny in-memory Users API. Nothing here is special to the in-process client.                                                                                        |
| `server.ts` | `export const app = await bootstrapServer(...)`. Bootstrap **once**, export the app. `bootstrapServer` only _initializes_ (it does **not** `listen()`), so `app.backend` is usable immediately, from any importer. |
| `main.ts`   | The demo: `app.backend.fetch(...)` for a relative GET, a POST with a JSON body, a path param, and a real 404.                                                                                                      |

### What to notice

- **No `listen()`.** No port is ever bound. `backend.fetch` calls the pipeline
  directly.
- **No token.** In-process calls are trusted automatically (a process-private
  key is stamped on each request and verified internally; it never leaves the
  process). The _same_ requests over the network would each need an access
  token.
- **It's a true `fetch`.** Relative paths resolve, `RequestInit` works, a
  `Request` object works, and you get back a raw `Response`. Swap `fetch` →
  `backend.fetch` and existing client code keeps working — in-process.

This is the pattern for calling your own API from server-side code (SSR routes,
background jobs, scripts, tests) without going out to the network or managing
tokens.

> **Note on imports.** The example code imports the published package names
> (`@techgoose-labs/rune`, `@danet/core`, `reflect-metadata`) so it reads exactly
> like a real consumer's code. Inside this repo those names are aliased to the
> local source via the import map in `deno.json`. In your own project, add
> `@techgoose-labs/rune` from JSR and import the same way.

> **Security.** `backend.fetch` is a _trusted_ channel — anything dispatched
> through it skips auth. Never pipe inbound network requests through it. To
> expose the API over the network, mount `app.handler` (which strips the
> in-process trust header). See the main README's "Security: the in-process
> bypass and how to mount safely".
