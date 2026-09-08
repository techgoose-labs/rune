import { buildContext } from "@rune/domain/data/filesystem/mod.ts";
import { Lsp } from "@rune/domain/data/lsp/mod.ts";
import { LSP_CONFIG } from "@core/dto/lsp-config.ts";
import { extname } from "#std/path";
import type { EntryResult } from "@core/dto/types.ts";
import type { RuleDefinition } from "@core/dto/types.ts";

export async function runPipeline(
  targetDir: string,
  rules: RuleDefinition[],
  ignored: Set<string> = new Set(),
): Promise<EntryResult[]> {
  const t0 = performance.now();
  const ctx = await buildContext(targetDir, ignored);
  const tCtx = performance.now();
  console.error(
    `  [profile] buildContext: ${
      (tCtx - t0).toFixed(0)
    }ms (${ctx.files.length} files, ${ctx.dirs.length} dirs)`,
  );

  // SHAPE_NO_LSP forces the LSP-free path so results don't depend on whether
  // the Rust LSP binary is installed in this environment — required for
  // deterministic golden capture (L0/L4). Off by default; behaviour unchanged.
  let lsp: Lsp | null = null;
  if (!Deno.env.get("SHAPE_NO_LSP")) {
    lsp = new Lsp(targetDir, LSP_CONFIG);
    try {
      await lsp.initialize();
      ctx.lsp = lsp;
    } catch {
      ctx.lsp = null;
      lsp = null;
    }
  }
  const tLsp = performance.now();
  console.error(
    `  [profile] LSP init: ${(tLsp - tCtx).toFixed(0)}ms (${
      ctx.lsp ? "connected" : "disabled"
    })`,
  );

  const entries = [
    ...ctx.dirs.map((p) => ({ path: p, target: "folder" as const })),
    ...ctx.files.map((p) => ({
      path: p,
      target: extname(p).slice(1) || "unknown",
    })),
  ];

  const results: EntryResult[] = [];
  const ruleTimes = new Map<string, number>();

  try {
    for (const entry of entries) {
      for (const rule of rules) {
        const rStart = performance.now();
        const violations = await rule.check(entry.path, entry.target, ctx);
        ruleTimes.set(
          rule.name,
          (ruleTimes.get(rule.name) ?? 0) + (performance.now() - rStart),
        );
        if (violations !== null) {
          results.push({
            path: entry.path,
            target: entry.target,
            rule: rule.name,
            violations,
          });
        }
      }
    }
  } finally {
    const tShutStart = performance.now();
    if (lsp) await lsp.shutdown();
    const tEnd = performance.now();
    console.error(
      `  [profile] LSP shutdown: ${(tEnd - tShutStart).toFixed(0)}ms`,
    );
    console.error(`  [profile] Rules (${entries.length} entries):`);
    for (
      const [name, ms] of [...ruleTimes.entries()].sort((a, b) => b[1] - a[1])
    ) {
      console.error(`    ${name}: ${ms.toFixed(0)}ms`);
    }
    console.error(`  [profile] Total: ${(tEnd - t0).toFixed(0)}ms`);
  }

  return results;
}
