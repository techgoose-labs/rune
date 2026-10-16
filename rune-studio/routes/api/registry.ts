// deno-lint-ignore-file no-explicit-any
import { define } from "../../utils.ts";

// Persist the edited language definition back to lang/keywords.json.
// This is what makes "editing the language through the UI" durable: routes read
// keywords.json at request time, so a save shows up on the next load everywhere.
// CWD-relative so it works in the bundled server too (import.meta.url → _fresh/)
const REGISTRY = "../lang/keywords.json";

export const handler = define.handlers({
  async POST(ctx) {
    let registry: unknown;
    try {
      registry = await ctx.req.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    if (
      !registry || typeof registry !== "object" ||
      !Array.isArray((registry as any).tags)
    ) {
      return Response.json({ error: "not a registry (missing tags[])" }, {
        status: 422,
      });
    }
    try {
      await Deno.writeTextFile(
        REGISTRY,
        JSON.stringify(registry, null, 2) + "\n",
      );
    } catch (e) {
      return Response.json({ error: `write failed: ${(e as Error).message}` }, {
        status: 500,
      });
    }
    return Response.json({ ok: true, tags: (registry as any).tags.length });
  },
});
