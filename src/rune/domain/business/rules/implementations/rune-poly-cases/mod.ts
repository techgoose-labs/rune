import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import {
  parse,
  type PlyNode,
  type StepLike,
} from "@rune/domain/business/rune-parse/mod.ts";
import {
  applyCase,
  isProjectSpec,
  moduleFromSpecPath,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-poly-cases: every [PLY] in a rune file requires:
//   src/<module>/domain/business/<noun>/base/mod.ts
//   src/<module>/domain/business/<noun>/base/test.ts
//   src/<module>/domain/business/<noun>/poly-mod.ts
// And for each [CSE]:
//   src/<module>/domain/business/<noun>/implementations/<case>/mod.ts
//   src/<module>/domain/business/<noun>/implementations/<case>/test.ts

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target !== "rune") return null;
  if (!isProjectSpec(path)) return null;

  const text = await ctx.getFileContent(path);
  const ast = parse(text);
  const moduleName = ast.module ?? moduleFromSpecPath(path);
  if (!moduleName) return null;

  const plies: PlyNode[] = [];
  for (const req of ast.reqs) collectPlies(req.steps, plies);

  const fileSet = new Set(ctx.files);
  const violations: string[] = [];

  for (const ply of plies) {
    const noun = applyCase(ply.noun, "kebab");
    const featureDir = `src/${moduleName}/domain/business/${noun}`;

    const baseFiles = [
      `${featureDir}/base/mod.ts`,
      `${featureDir}/base/test.ts`,
      `${featureDir}/poly-mod.ts`,
    ];
    for (const f of baseFiles) {
      if (!fileSet.has(f)) {
        violations.push(
          `Missing poly file: ${f} (for [PLY] ${ply.noun} at line ${
            ply.line + 1
          })`,
        );
      }
    }

    for (const cse of ply.cases) {
      const caseKebab = applyCase(cse.name, "kebab");
      const caseDir = `${featureDir}/implementations/${caseKebab}`;
      const caseFiles = [`${caseDir}/mod.ts`, `${caseDir}/test.ts`];
      for (const f of caseFiles) {
        if (!fileSet.has(f)) {
          violations.push(
            `Missing case file: ${f} (for [CSE] ${cse.name} at line ${
              cse.line + 1
            })`,
          );
        }
      }
    }
  }

  return violations.length > 0 ? violations : null;
}

function collectPlies(steps: StepLike[], out: PlyNode[]): void {
  for (const step of steps) {
    if (step.kind === "ply") {
      out.push(step);
      // Don't recurse into cases — nested [PLY] is invalid per parser.
    }
  }
}

export const SYSTEM_PROMPT = `You are enforcing the rune-poly-cases rule.

Every polymorphic step ([PLY]) in a rune requires a feature folder with this structure:
  src/<module>/domain/business/<noun>/
  ├── base/mod.ts           (the shared abstraction across variants)
  ├── base/test.ts          (tests for the base)
  ├── poly-mod.ts           (barrel re-export selecting the active variant)
  └── implementations/
      └── <case-name>/
          ├── mod.ts        (variant-specific implementation)
          └── test.ts       (variant tests)

A case (\`[CSE] genie\`) becomes \`implementations/genie/\`. Names are kebab-cased.

Missing files mean the polymorphic feature isn't fully scaffolded.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
Missing poly slots:
${violations.map((v) => `  - ${v}`).join("\n")}

Either run \`rune manifest ${path}\` to scaffold the missing files, or remove the [PLY]/[CSE] from the rune.`;
}
