import {
  classifyFile,
  getModuleFromPath,
  isModRootImport,
} from "@core/business/classify/mod.ts";
import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";

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

  const source = classifyFile(path);
  if (!source.module) return null;

  const imports = await ctx.getImports(path);
  const violations: string[] = [];

  for (const imp of imports) {
    if (!imp.startsWith("src/")) continue;
    const targetModule = getModuleFromPath(imp);
    if (
      !targetModule || targetModule === source.module || targetModule === "core"
    ) continue;

    if (source.isBootstrap && !isModRootImport(imp)) {
      violations.push(
        `Bootstrap imports "${targetModule}" but not through its mod-root — use the mod-root public API instead (${imp})`,
      );
    } else if (!source.isBootstrap) {
      violations.push(
        `Cross-module import from "${source.module}" into "${targetModule}" is forbidden — extract shared code to core/ instead (${imp})`,
      );
    }
  }

  // LSP enhancement: trace re-exports to find hidden cross-module leaks
  if (ctx.lsp?.capabilities.definition) {
    for (const imp of imports) {
      if (!imp.startsWith("src/")) continue;
      const apparentModule = getModuleFromPath(imp);
      if (
        !apparentModule || apparentModule === source.module ||
        apparentModule === "core"
      ) continue;

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
          const resolvedModule = getModuleFromPath(resolvedPath);
          if (
            !resolvedModule || resolvedModule === source.module ||
            resolvedModule === "core"
          ) continue;

          if (source.isBootstrap && !isModRootImport(resolvedPath)) {
            const v =
              `Bootstrap imports "${resolvedModule}" but not through its mod-root — re-export "${exp.name}" resolves to ${resolvedPath}`;
            if (!violations.some((e) => e.includes(resolvedPath))) {
              violations.push(v);
            }
          } else if (!source.isBootstrap) {
            const v =
              `Hidden cross-module leak: "${exp.name}" from ${imp} actually comes from "${resolvedModule}" (${resolvedPath})`;
            if (!violations.some((e) => e.includes(resolvedPath))) {
              violations.push(v);
            }
          }
        }
      }
    }
  }

  return violations.length > 0 ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor enforcing module isolation in a hexagonal architecture.

Rules:
- Modules can only import from themselves or core/
- Bootstrap can import any module but ONLY through its mod-root file
- Cross-module imports are forbidden — extract shared code to core/ instead

Given violations, suggest concise fixes (2-3 sentences).`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `File: ${path}
Violations:
${violations.map((v) => `  - ${v}`).join("\n")}

How should the developer fix these module isolation violations?`;
}
