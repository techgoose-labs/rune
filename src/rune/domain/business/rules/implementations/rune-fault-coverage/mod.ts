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
  processName,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-fault-coverage: every fault declared in a rune must have a matching
// `Deno.test("<fault-name>", ...)` case in the relevant test file.
//
// Three test-file destinations:
//   - Faults on untagged step → src/<module>/domain/business/<noun>/test.ts
//   - Faults on boundary step → src/<module>/domain/data/<noun>/smk.test.ts
//   - Every fault in a REQ    → src/<module>/domain/coordinators/<process>/int.test.ts

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

  // Track expected faults per test file.
  const expected = new Map<string, Set<string>>();

  for (const req of ast.reqs) {
    const intPath = `src/${moduleName}/domain/coordinators/${
      processName(req.noun, req.verb)
    }/int.test.ts`;
    const reqFaults = collectAllFaults(req);

    if (reqFaults.size > 0) {
      addFaults(expected, intPath, reqFaults);
    }

    walkSteps(req.steps, moduleName, expected);
  }

  for (const [filePath, faults] of expected) {
    if (!fileSet.has(filePath)) continue; // presence rules handle missing files
    const content = await ctx.getFileContent(filePath);
    for (const fault of faults) {
      if (!hasTestCase(content, fault)) {
        violations.push(`Missing test case "${fault}" in ${filePath}`);
      }
    }
  }

  return violations.length > 0 ? violations : null;
}

function collectAllFaults(req: ReqNode): Set<string> {
  const out = new Set<string>();
  collectFromSteps(req.steps, out);
  return out;
}

function collectFromSteps(
  steps: StepLike[] | CseNode["steps"],
  out: Set<string>,
): void {
  for (const step of steps) {
    if (step.kind === "step" || step.kind === "boundary") {
      for (const f of step.faults) out.add(f);
    } else if (step.kind === "ply") {
      for (const cse of step.cases) collectFromSteps(cse.steps, out);
    }
  }
}

function walkSteps(
  steps: StepLike[] | CseNode["steps"],
  moduleName: string,
  expected: Map<string, Set<string>>,
): void {
  for (const step of steps) {
    if (step.kind === "step" && step.faults.length > 0) {
      const noun = applyCase(step.noun, "kebab");
      const file = `src/${moduleName}/domain/business/${noun}/test.ts`;
      addFaults(expected, file, new Set(step.faults));
    } else if (step.kind === "boundary" && step.faults.length > 0) {
      const noun = applyCase(step.noun, "kebab");
      const file = `src/${moduleName}/domain/data/${noun}/smk.test.ts`;
      addFaults(expected, file, new Set(step.faults));
    } else if (step.kind === "ply") {
      for (const cse of step.cases) walkSteps(cse.steps, moduleName, expected);
    }
  }
}

function addFaults(
  expected: Map<string, Set<string>>,
  file: string,
  faults: Set<string>,
): void {
  const existing = expected.get(file) ?? new Set<string>();
  for (const f of faults) existing.add(f);
  expected.set(file, existing);
}

function hasTestCase(content: string, fault: string): boolean {
  const escaped = fault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match Deno.test("fault", ...) or 'fault' or `fault` or t("fault") variants.
  const re = new RegExp(`Deno\\.test\\s*\\(\\s*["'\`]${escaped}["'\`]`);
  return re.test(content);
}

export const SYSTEM_PROMPT = `You are enforcing the rune-fault-coverage rule.

Every fault declared in a rune (e.g., \`not-found\`, \`timed-out\`) must have a matching test case in the relevant test file:

- Faults on an untagged step  → src/<module>/domain/business/<noun>/test.ts
- Faults on a boundary step   → src/<module>/domain/data/<noun>/smk.test.ts
- Every fault in a [REQ]      → src/<module>/domain/coordinators/<process>/int.test.ts

A test case looks like \`Deno.test("not-found", () => { ... })\`. The name must match the fault exactly.

A missing test case means the fault path isn't being verified.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
Missing fault test cases:
${violations.map((v) => `  - ${v}`).join("\n")}

Add a Deno.test("<fault-name>", ...) case to the cited test file for each missing fault.`;
}
