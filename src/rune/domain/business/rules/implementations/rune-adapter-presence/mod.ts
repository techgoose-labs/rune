import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import {
  type CseNode,
  parse,
  type StepLike,
} from "@rune/domain/business/rune-parse/mod.ts";
import {
  applyCase,
  isProjectSpec,
  moduleFromSpecPath,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-adapter-presence: every boundary call (db:, fs:, mq:, ex:, os:, lg:) in a
// rune file must have an adapter folder at src/<module>/domain/data/<noun>/ with
// mod.ts + smk.test.ts.

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

  // Collect every boundary noun across all REQs (and inside [PLY] cases).
  const services = new Map<string, { service: string; line: number }>();
  for (const req of ast.reqs) {
    collectBoundaries(req.steps, services);
  }

  const fileSet = new Set(ctx.files);
  const violations: string[] = [];

  for (const [noun, info] of services) {
    const kebab = applyCase(noun, "kebab");
    const dir = `src/${moduleName}/domain/data/${kebab}`;
    const mod = `${dir}/mod.ts`;
    const smk = `${dir}/smk.test.ts`;
    if (!fileSet.has(mod)) {
      violations.push(
        `Missing adapter file: ${mod} (for boundary ${info.service}:${noun} at line ${
          info.line + 1
        })`,
      );
    }
    if (!fileSet.has(smk)) {
      violations.push(
        `Missing adapter smoke test: ${smk} (for boundary ${info.service}:${noun} at line ${
          info.line + 1
        })`,
      );
    }
  }

  return violations.length > 0 ? violations : null;
}

function collectBoundaries(
  steps: StepLike[] | CseNode["steps"],
  out: Map<string, { service: string; line: number }>,
): void {
  for (const step of steps) {
    if (step.kind === "boundary") {
      if (!out.has(step.noun)) {
        out.set(step.noun, { service: step.service, line: step.line });
      }
    } else if (step.kind === "ply") {
      for (const cse of step.cases) {
        collectBoundaries(cse.steps, out);
      }
    }
  }
}

export const SYSTEM_PROMPT = `You are enforcing the rune-adapter-presence rule.

Every boundary call in a rune (e.g., db:metadata.set, ex:provider.search) must have an adapter folder at:
  src/<module>/domain/data/<noun>/

The folder must contain:
  - mod.ts        (the adapter implementation that crosses the system boundary)
  - smk.test.ts   (smoke test that verifies connectivity)

A missing adapter means the rune declared a boundary call without a backing implementation.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
Missing adapter slots:
${violations.map((v) => `  - ${v}`).join("\n")}

Either run \`rune manifest ${path}\` to scaffold the missing files, or remove the boundary call from the rune.`;
}
