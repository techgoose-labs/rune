import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";

const EXPORT_RE =
  /export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/g;

function extractExportNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const m of content.matchAll(EXPORT_RE)) {
    const name = m[1] ?? m[2];
    if (name) names.add(name);
  }
  return names;
}

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target !== "folder") return null;
  if (!path.match(/^src\/[^/]+\/domain\/business$/)) return null;

  const depth = path.split("/").length;

  const childDirs = ctx.dirs.filter(
    (d) => d.startsWith(path + "/") && d.split("/").length === depth + 1,
  );

  // Find poly structures: dirs that have an implementations/ subdir and a poly-mod file
  const polyDirs: string[] = [];
  for (const dir of childDirs) {
    const hasImpl = ctx.dirs.includes(dir + "/implementations");
    const hasPolyMod = ctx.files.some(
      (f) =>
        f.startsWith(dir + "/") &&
        f.split("/").length === dir.split("/").length + 1 &&
        f.split("/").pop()?.replace(/\.[^.]+$/, "") === "poly-mod",
    );
    if (hasImpl && hasPolyMod) polyDirs.push(dir);
  }

  if (polyDirs.length === 0) return null;

  // Standalone siblings: child dirs that are NOT poly structures
  const standaloneDirs = childDirs.filter((d) => !polyDirs.includes(d));
  if (standaloneDirs.length === 0) return null;

  const violations: string[] = [];

  for (const polyDir of polyDirs) {
    // Collect export names from implementations
    const implDirs = ctx.dirs.filter(
      (d) =>
        d.startsWith(polyDir + "/implementations/") &&
        d.split("/").length === polyDir.split("/").length + 2,
    );

    const implExportSets: Set<string>[] = [];
    for (const implDir of implDirs) {
      const modFile = ctx.files.find(
        (f) =>
          f.startsWith(implDir + "/") &&
          f.split("/").pop()?.replace(/\.[^.]+$/, "") === "mod",
      );
      if (!modFile) continue;
      const content = await ctx.getFileContent(modFile);
      implExportSets.push(extractExportNames(content));
    }

    if (implExportSets.length === 0) continue;

    // Find common exports across all implementations
    const commonExports = [...implExportSets[0]].filter((name) =>
      implExportSets.every((s) => s.has(name))
    );
    if (commonExports.length < 2) continue;
    const commonSet = new Set(commonExports);

    // Check each standalone sibling against this poly's common exports
    for (const standalone of standaloneDirs) {
      const modFile = ctx.files.find(
        (f) =>
          f.startsWith(standalone + "/") &&
          f.split("/").pop()?.replace(/\.[^.]+$/, "") === "mod",
      );
      if (!modFile) continue;
      const content = await ctx.getFileContent(modFile);
      const standaloneExports = extractExportNames(content);

      const overlap = [...standaloneExports].filter((n) => commonSet.has(n));
      if (overlap.length >= 2) {
        const standaloneName = standalone.split("/").pop()!;
        const polyName = polyDir.split("/").pop()!;
        violations.push(
          `"${standaloneName}" looks like it belongs inside the "${polyName}" poly structure — it shares the same exports`,
        );
      }
    }
  }

  return violations.length > 0 ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor detecting stray implementations.

Rule: When a standalone feature under business/ exports the same interface as implementations inside a sibling poly structure, it should be moved into that poly structure as another implementation variant.

A poly structure looks like:
\`\`\`
<feature>/
├── base/mod.ts           — Shared interface and common logic
├── implementations/
│   └── <variant>/mod.ts  — Variant-specific implementation
└── poly-mod.ts           — Barrel export for all implementations
\`\`\`

The stray feature should become a new variant under implementations/. Its current mod.ts becomes the variant's mod.ts.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  const parts = violations.map((v) => {
    const m = v.match(/^stray:(.+):belongs-in:(.+)$/);
    return m ? { stray: m[1], poly: m[2] } : null;
  }).filter(Boolean);

  return `Directory: ${path}
Detections: ${JSON.stringify(violations)}

${
    parts.map((p) =>
      `\`${
        p!.stray
      }/\` exports the same interface as implementations inside \`${
        p!.poly
      }/\`. It should be moved to \`${p!.poly}/implementations/${p!.stray}/\`.`
    ).join("\n")
  }

How should the developer restructure this?`;
}
