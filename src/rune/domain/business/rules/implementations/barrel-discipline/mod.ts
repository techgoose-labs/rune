import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";

const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx"]);

const BARREL_RE =
  /export\s+(?:\{[^}]*\}\s+from|(?:\*|\*\s+as\s+\w+)\s+from)\s+["'][^"']+["']/g;

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target === "folder" || !SOURCE_EXTS.has(target as string)) return null;

  const baseName = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  if (baseName === "poly-mod" || baseName === "mod-root") return null;
  if (path.startsWith("src/bootstrap/")) return null;

  const content = await ctx.getFileContent(path);

  if (BARREL_RE.test(content)) {
    return [
      "Re-exports (barrel pattern) are only allowed in mod-root.ts, poly-mod.ts, and bootstrap files",
    ];
  }

  return null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor enforcing barrel export discipline.

Rule: Re-exports (export { x } from, export * from) are ONLY allowed in mod-root, poly-mod, or bootstrap files. All other files must export their own declarations directly.

Given a barrel violation, suggest where to move the re-exports. Be concise (2-3 sentences).`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `File: ${path}
Violation: ${violations[0]}

This file has re-exports that belong in a mod-root or poly-mod. What should the developer do?`;
}
