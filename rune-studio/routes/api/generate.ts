import { define } from "../../utils.ts";
import { generate } from "../../lib/engine.ts";

// Generate via the shared shape-checker engine (ADR 0001) — the Studio shows
// exactly what the CLI emits (L5), no Rust-binary bridge.
export const handler = define.handlers({
  async POST(ctx) {
    const { source, registry } = await ctx.req.json().catch(() => ({ source: "" }));
    // Use the edited registry from the request when present, else the bundled
    // one — so language edits in the UI flow straight into engine output.
    let reg = registry;
    if (!reg) {
      try {
        reg = JSON.parse(await Deno.readTextFile("../lang/keywords.json"));
      } catch { /* fall back to engine defaults */ }
    }
    try {
      return Response.json({ files: generate(source ?? "", reg) });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
    }
  },
});
