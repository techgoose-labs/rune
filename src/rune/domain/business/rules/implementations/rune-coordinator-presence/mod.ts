import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import {
  isProjectSpec,
  moduleFromSpecPath,
  processName,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-coordinator-presence: every [REQ] in a .rune file must have a coordinator
// folder at src/<module>/domain/coordinators/<process>/ with mod.ts + int.test.ts.

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

  const fileSet = new Set(ctx.files);
  const violations: string[] = [];

  for (const req of ast.reqs) {
    const process = processName(req.noun, req.verb);
    const dir = `src/${moduleName}/domain/coordinators/${process}`;
    const mod = `${dir}/mod.ts`;
    const test = `${dir}/int.test.ts`;
    if (!fileSet.has(mod)) {
      violations.push(
        `Missing coordinator file: ${mod} (for [REQ] ${req.noun}.${req.verb} at line ${
          req.line + 1
        })`,
      );
    }
    if (!fileSet.has(test)) {
      violations.push(
        `Missing coordinator test: ${test} (for [REQ] ${req.noun}.${req.verb} at line ${
          req.line + 1
        })`,
      );
    }
  }

  return violations.length > 0 ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are enforcing the rune-coordinator-presence rule.

Each [REQ] in a .rune spec file must have a corresponding coordinator folder in the project at:
  src/<module>/domain/coordinators/<process>/

Where <module> comes from the rune file's [MOD] directive (or filename), and <process> is the noun-verb of the [REQ] in kebab case.

The coordinator folder must contain:
  - mod.ts        (the orchestration code that fulfills the REQ)
  - int.test.ts   (integration tests, one per fault path declared in the rune)

A missing coordinator means the rune declared a requirement that isn't yet implemented.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
Missing coordinator slots:
${violations.map((v) => `  - ${v}`).join("\n")}

Either run \`rune manifest ${path}\` to scaffold the missing files, or remove the [REQ] from the rune.`;
}
