import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import {
  type CseNode,
  parse,
  type ReqNode,
  type StepLike,
} from "@rune/domain/business/rune-parse/mod.ts";
import {
  applyCase,
  isProjectSpec,
  moduleFromSpecPath,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-business-presence: every untagged step's noun (and every [PLY] noun) in a
// rune file must have a business feature folder at
// src/<module>/domain/business/<noun>/.
//
// For non-poly nouns, mod.ts + test.ts are expected.
// For poly nouns, only the folder is checked here — poly-cases handles the
// internal base/ + implementations/ + poly-mod.ts structure.

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

  // Collect every business noun and whether it's used polymorphically.
  const nouns = new Map<string, { isPoly: boolean; line: number }>();
  for (const req of ast.reqs) {
    collectNouns(req.steps, nouns);
  }

  const fileSet = new Set(ctx.files);
  const dirSet = new Set(ctx.dirs);
  const violations: string[] = [];

  for (const [noun, info] of nouns) {
    const kebab = applyCase(noun, "kebab");
    const dir = `src/${moduleName}/domain/business/${kebab}`;

    if (info.isPoly) {
      if (!dirSet.has(dir)) {
        violations.push(
          `Missing business feature folder: ${dir}/ (for [PLY] ${noun} at line ${
            info.line + 1
          })`,
        );
      }
      continue;
    }

    const mod = `${dir}/mod.ts`;
    const test = `${dir}/test.ts`;
    if (!fileSet.has(mod)) {
      violations.push(
        `Missing business file: ${mod} (for step noun "${noun}" at line ${
          info.line + 1
        })`,
      );
    }
    if (!fileSet.has(test)) {
      violations.push(
        `Missing business test: ${test} (for step noun "${noun}" at line ${
          info.line + 1
        })`,
      );
    }
  }

  return violations.length > 0 ? violations : null;
}

function collectNouns(
  steps: StepLike[] | CseNode["steps"],
  out: Map<string, { isPoly: boolean; line: number }>,
): void {
  for (const step of steps) {
    if (step.kind === "step") {
      // Untagged step → regular business feature.
      mark(out, step.noun, false, step.line);
    } else if (step.kind === "ply") {
      // Polymorphic noun → business feature with base/+implementations/.
      mark(out, step.noun, true, step.line);
      for (const cse of step.cases) {
        collectNouns(cse.steps, out);
      }
    }
    // boundary, ctr, ret → not a business feature for this rule.
  }
}

function mark(
  out: Map<string, { isPoly: boolean; line: number }>,
  noun: string,
  isPoly: boolean,
  line: number,
): void {
  const existing = out.get(noun);
  if (!existing) {
    out.set(noun, { isPoly, line });
    return;
  }
  // If we ever see the noun as poly, treat the whole noun as poly.
  if (isPoly && !existing.isPoly) {
    out.set(noun, { isPoly: true, line: Math.min(existing.line, line) });
  }
}

export const SYSTEM_PROMPT = `You are enforcing the rune-business-presence rule.

Every untagged step in a rune [REQ] (e.g., "id::create(name): id") must have a corresponding business feature folder at:
  src/<module>/domain/business/<noun>/

The folder must contain:
  - mod.ts   (the pure step logic; no I/O)
  - test.ts  (unit tests)

For polymorphic nouns ([PLY] blocks), the folder is checked but its internal structure (base/, implementations/, poly-mod.ts) is enforced by the poly-cases rule.

A missing business feature means the rune declared a step that isn't yet implemented.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
Missing business slots:
${violations.map((v) => `  - ${v}`).join("\n")}

Either run \`rune manifest ${path}\` to scaffold the missing files, or remove the step from the rune.`;
}
