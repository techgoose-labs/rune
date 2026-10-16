import { define } from "../../utils.ts";
import { check, generate, lintGenerated, reqCount } from "../../lib/engine.ts";

// The engine, served (REQ-035): the island posts the spec (and the edited
// registry) and gets back exactly what `rune check` reports, the files the
// engine generates and the generated-code findings over them. With `dir`, the
// filesystem bridge scans a real project directory instead and lints its
// source files (+ any .rune spec) with the same rules.

// CWD is the studio dir; rune repo root is .. (survives bundling)
const REPO = `${Deno.cwd()}/..`;
const SKIP = new Set([
  "node_modules",
  "_fresh",
  ".git",
  "target",
  "dist",
  ".deno",
  ".playwright-mcp",
  ".claude",
  "vendor",
]);
const SRC = /\.(ts|tsx|js|jsx|rune)$/;

async function scan(root: string): Promise<{ files: { path: string; content: string }[]; count: number }> {
  const files: { path: string; content: string }[] = [];
  let count = 0;
  async function walk(d: string, prefix: string) {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(d);
    } catch {
      return;
    }
    for await (const e of entries) {
      if (count > 3000) return;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (SKIP.has(e.name)) continue;
        await walk(`${d}/${e.name}`, rel);
      } else if (SRC.test(e.name)) {
        try {
          const info = await Deno.stat(`${d}/${e.name}`);
          if (info.size > 250_000) continue;
          files.push({ path: rel, content: await Deno.readTextFile(`${d}/${e.name}`) });
          count++;
        } catch { /* skip */ }
      }
    }
  }
  await walk(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, count };
}

export const handler = define.handlers({
  async POST(ctx) {
    const body = await ctx.req.json().catch(() => ({}));
    const registry = body.registry ?? undefined;
    if (body.dir !== undefined) {
      const root = (body.dir && String(body.dir).startsWith("/"))
        ? String(body.dir)
        : `${REPO}/${body.dir || "."}`;
      try {
        await Deno.stat(root.replace(/\/$/, ""));
      } catch {
        return Response.json({ error: `directory not found: ${root}` }, { status: 404 });
      }
      const { files, count } = await scan(root.replace(/\/$/, ""));
      return Response.json({ root, fileCount: count, diags: await lintGenerated(files, registry) });
    }
    const source = String(body.source ?? "");
    const findings = check(source, registry);
    let files: { path: string; content: string }[] = [];
    try {
      files = generate(source, registry);
    } catch {
      files = []; // a spec with errors generates nothing to preview
    }
    const generated = files.length ? await lintGenerated([...files, { path: "specs/spec.rune", content: source }], registry) : [];
    return Response.json({ findings, generated, files, reqs: reqCount(source) });
  },
});
