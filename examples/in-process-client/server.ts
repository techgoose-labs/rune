import "reflect-metadata";
import { bootstrapServer } from "@techgoose-labs/rune";
import { AppModule } from "./users.ts";

/**
 * Bootstrap once and export the result. `bootstrapServer` only *initializes* — it binds
 * no socket — and returns the backend as a bedrock UNIT. `app.backend` is the scope-less
 * in-process client from a private composition root, usable the moment this module is
 * imported, from anywhere in the process.
 *
 * This is the "server.ts / elsewhere.ts" pattern: define the app in one place, then
 * import `app` and call `app.backend.fetch("/api/…")` wherever you need to talk to your
 * own API in-process (SSR routes, background jobs, scripts, tests).
 */
export const app = await bootstrapServer("examples-api", AppModule, {
  swagger: false,
});
