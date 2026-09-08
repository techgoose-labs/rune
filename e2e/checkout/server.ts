import "reflect-metadata";
import { bootstrapServer } from "@techgoose-labs/rune";
import { Bedrock } from "@techgoose-labs/bedrock";
import { httpModule } from "./src/checkout/entrypoints/http/mod.ts";
import { membersModule } from "./src/members/entrypoints/http/mod.ts";

// One module per rune; keep serves a process emulator per module under /api/docs/<module>.
// checkout branches (card|cash flows), declares an external input ($memberId), and carries
// an optional step; the composed members module PRODUCES memberId, so the contract snaps
// together — checkout's module-inputs card shows the `auto:` affordance instead of amber.
export const api = await bootstrapServer("checkout", [
  membersModule,
  httpModule,
], {
  port: 8723,
});

export default Bedrock({ backend: api });

if (import.meta.main) {
  await Bedrock({ backend: api }).listen();
  console.log(
    "🛒 checkout app on http://localhost:8723 — emulators at /api/docs/checkout + /api/docs/members",
  );
}
