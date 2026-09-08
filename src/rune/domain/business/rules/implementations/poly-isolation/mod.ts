import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";
import { dirname } from "#std/path";

const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx"]);

function uriToRelPath(uri: string, targetDir: string): string | null {
  const prefix = `file://${targetDir}/`;
  if (!uri.startsWith(prefix)) return null;
  return uri.slice(prefix.length);
}

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target === "folder" || !SOURCE_EXTS.has(target as string)) return null;

  const polyFeatures = ctx.files
    .filter((f) => f.split("/").pop()?.replace(/\.[^.]+$/, "") === "poly-mod")
    .map((f) => ({ dir: dirname(f), polyModPath: f }));

  const imports = await ctx.getImports(path);
  const violations: string[] = [];

  for (const imp of imports) {
    for (const poly of polyFeatures) {
      if (path.startsWith(poly.dir + "/") || path === poly.dir) continue;
      if (
        imp.startsWith(poly.dir + "/") &&
        imp.split("/").pop()?.replace(/\.[^.]+$/, "") !== "poly-mod"
      ) {
        violations.push(
          `Importing directly from inside a poly structure — use ${poly.polyModPath} instead of ${imp}`,
        );
      }
    }
  }

  // LSP enhancement: verify poly-mod imports resolve within the poly directory
  if (ctx.lsp?.capabilities.definition) {
    for (const imp of imports) {
      for (const poly of polyFeatures) {
        if (path.startsWith(poly.dir + "/") || path === poly.dir) continue;
        // Only check imports that DO go through poly-mod (currently passing)
        if (!imp.startsWith(poly.dir + "/")) continue;
        if (imp.split("/").pop()?.replace(/\.[^.]+$/, "") !== "poly-mod") {
          continue;
        }

        let exports;
        try {
          exports = await ctx.lsp.getExportTypes(imp);
        } catch {
          continue;
        }

        for (const exp of exports) {
          const defs = await ctx.lsp.findSymbolDefinition(imp, exp.name);
          for (const def of defs) {
            const resolvedPath = uriToRelPath(def.uri, ctx.targetDir);
            if (!resolvedPath) continue;
            if (
              !resolvedPath.startsWith(poly.dir + "/") &&
              resolvedPath !== poly.polyModPath
            ) {
              violations.push(
                `Poly-mod leak: "${exp.name}" in ${poly.polyModPath} resolves to ${resolvedPath} which is outside the poly structure`,
              );
            }
          }
        }
      }
    }
  }

  return violations.length > 0 ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor enforcing polymorphic module isolation.

Rule: poly-mod files are the ONLY public surface for polymorphic features. External code must import from poly-mod, never from internal files within that feature directory.

Given bypass violations, suggest concise fixes (2-3 sentences).`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `File: ${path}
Violations:
${violations.map((v) => `  - ${v}`).join("\n")}

How should the developer fix these poly-mod bypass violations?`;
}
