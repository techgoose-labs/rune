import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";

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
    if (spec && spec.includes("..")) {
      violations.push(
        `"../" import is not allowed — use an @ alias instead (${spec})`,
      );
    }
  }

  return violations.length > 0 ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor enforcing import alias conventions.

Rule: Relative parent imports (\`../\`) are banned. All cross-directory imports must use import aliases prefixed with \`@\`.

Available aliases are defined in deno.json under "imports". Each module gets its own alias (e.g., \`@core/\`, \`@rune/\`). Sibling imports within the same directory use \`./\`.

When a file needs to import from outside its directory, it must use the appropriate \`@\` alias instead of climbing up with \`../\`.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  const specs = violations.map((v) => v.replace("dotdot-import:", ""));
  return `File: ${path}
Violations: ${specs.length} import(s) using \`../\`:
${specs.map((s) => `  - ${s}`).join("\n")}

Replace each \`../\` import with the appropriate \`@\` alias. What should each import be changed to?`;
}
