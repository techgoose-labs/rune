import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";

const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx"]);

function isModFile(filePath: string): boolean {
  const baseName = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  return baseName === "mod";
}

function isBootstrapFile(filePath: string): boolean {
  return filePath.startsWith("src/bootstrap/");
}

function stripExtension(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, "");
}

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target === "folder") return null;
  if (!path.startsWith("fixtures/")) return null;

  const fixtureStem = stripExtension(path);

  const candidates = ctx.files.filter(
    (f) =>
      SOURCE_EXTS.has(f.split(".").pop() ?? "") &&
      (isModFile(f) || isBootstrapFile(f)),
  );

  for (const file of candidates) {
    const imports = await ctx.getImports(file);
    for (const imp of imports) {
      if (
        imp === path || imp === fixtureStem ||
        stripExtension(imp) === fixtureStem
      ) {
        return [
          "This fixture is imported by production code — move it to assets/ instead",
        ];
      }
    }
  }

  return null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor enforcing fixture/asset separation.

Rule: Files under fixtures/ are for test data only. If a fixture is imported by production code (mod.ts files or bootstrap files), it should live in assets/ instead.

Given a fixture-promotion violation, suggest how to move the file to assets/. Be concise (2-3 sentences).`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `File: ${path}
Violation: ${violations[0]}

This fixture is imported by a mod or bootstrap file, meaning it's used in production code. It should be moved to assets/. What should the developer do?`;
}
