import "reflect-metadata";
import { bootstrapServer } from "@techgoose-labs/rune";
import { Bedrock } from "@techgoose-labs/bedrock";
import { httpModule } from "./src/cake/entrypoints/http/mod.ts";

// `api` is the backend UNIT; the composition root composes it.
export const api = await bootstrapServer("cake", httpModule, { port: 8722 });
export default Bedrock({ backend: api });

if (import.meta.main) {
  const { port } = await Bedrock({ backend: api }).listen();
  console.log(
    `🍰 cake app on http://localhost:${port} — emulator at /api/docs/cake`,
  );
}
