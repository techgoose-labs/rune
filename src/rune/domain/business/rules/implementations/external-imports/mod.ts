import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";

const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx"]);

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target === "folder" || !SOURCE_EXTS.has(target as string)) return null;

  const content = await ctx.getFileContent(path);
  const violations: string[] = [];

  const importRe =
    /(?:import|export)\s+.*?\s+from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const m of content.matchAll(importRe)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    if (spec.startsWith("npm:") || spec.startsWith("jsr:")) {
      violations.push(
        `Direct "${spec}" import is not allowed — add a # alias in deno.json and import via the alias instead`,
      );
    }
  }

  return violations.length > 0 ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor enforcing external import conventions.

Rule: Direct \`npm:\` and \`jsr:\` specifiers are banned in source files. All external packages must be aliased in deno.json import maps with a \`#\` prefix, and source files import via the alias.

Examples:
- \`npm:zod\` becomes \`#zod\` (mapped in deno.json: \`"#zod": "npm:zod"\`)
- \`jsr:@std/path\` becomes \`#std/path\` (mapped in deno.json: \`"#std/path": "jsr:@std/path"\`)
- \`node:crypto\` becomes \`crypto\` (bare, no prefix needed)

This centralizes version management and makes dependencies explicit in one place.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  const specs = violations.map((v) => v.replace("bare-external:", ""));
  return `File: ${path}
Violations: ${specs.length} bare external import(s):
${specs.map((s) => `  - ${s}`).join("\n")}

Each should be replaced with a \`#\` alias defined in deno.json. What should each import be changed to?`;
}
