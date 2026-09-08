// App bootstrap (dev-owned): created once by rune sync, never overwritten —
// tune the app name, port, or keep options freely. The module registry
// (bootstrap/modules.ts) is regenerated as runes are added and removed.

import { bootstrapServer } from "@techgoose-labs/rune";
import { config } from "@/bootstrap/config.ts";
import { modules } from "@/bootstrap/modules.ts";

export const api = await bootstrapServer("bullshit", modules, { port: config.port });

if (import.meta.main) {
  // listen() walks to the next free port if config.port is busy; the
  // runtime logs the actual bound port ("Listening on <port>").
  await api.listen();
  console.log(
    `bullshit on http://localhost:${config.port} — emulator at /docs/<module>`,
  );
}
