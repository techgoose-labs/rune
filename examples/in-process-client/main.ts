import { app } from "./server.ts";

/**
 * The in-process client demo. `app.backend.fetch` is a drop-in for the global `fetch`:
 * same signature, returns a raw `Response`, accepts relative paths. Every call runs
 * fully in-process — no TCP, no open port — through the composition root, so it takes
 * the exact path a browser's request would.
 *
 * Run it:
 *   deno run -A examples/in-process-client/main.ts
 *   # or: deno task example
 *
 * Two things to notice. There is no `listen()` anywhere — nothing binds a socket. And
 * the paths are WIRE paths (`/api/users`, not `/users`): there is ONE client and it
 * addresses the app the way the outside world does. It is also not "trusted": with an
 * auth unit composed, this scope-less dispatch is guarded like any other.
 */

// 1) Relative GET. (Global `fetch` would reject "/users"; the backend resolves it.)
const list = await app.backend.fetch("/api/users");
console.log("GET /api/users        →", list.status, await list.json());

// 2) POST with a JSON body — routed through @Body(), just like over the wire.
const created = await app.backend.fetch("/api/users", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Bob" }),
});
const bob = await created.json();
console.log("POST /api/users       →", created.status, bob);

// 3) Path param — fetch the user we just created back by id.
const one = await app.backend.fetch(`/api/users/${bob.id}`);
console.log(`GET /api/users/${bob.id}     →`, one.status, await one.json());

// 4) A missing user → the controller throws NotFoundException, and the framework's
//    exception filter turns it into a real 404 — in-process, same as over the wire.
const missing = await app.backend.fetch("/api/users/999");
console.log("GET /api/users/999    →", missing.status, await missing.text());

// Tidy up. (We never bound a port, but stop() releases the app's resources.)
await app.stop();
