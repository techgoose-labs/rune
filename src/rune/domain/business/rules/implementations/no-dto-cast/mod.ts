import { classifyFile } from "@core/business/classify/mod.ts";
import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";

const SOURCE_EXTS = new Set(["ts", "tsx"]);
// A blind compile-time cast to a DTO class: `... as OrderDto`. Coordinators
// must validate the seam instead (assert(OrderDto, ...)); `as never`
// placeholders and non-Dto types are deliberately not matched.
const DTO_CAST_RE = /\bas\s+([A-Z]\w*Dto)\b/g;

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target === "folder" || !SOURCE_EXTS.has(target as string)) return null;
  if (/\.(?:test|spec)\./.test(path)) return null;
  if (classifyFile(path).layer !== "coordinators") return null;

  const content = await ctx.getFileContent(path);
  const violations: string[] = [];
  for (const m of content.matchAll(DTO_CAST_RE)) {
    const dto = m[1];
    violations.push(
      `coordinator casts to "${dto}" — validate the seam with assert(${dto}, ...) instead of a blind cast`,
    );
  }

  return violations.length ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor enforcing validated seams in coordinators.

Rule: Coordinators must not cast values to DTO classes with \`as XxxDto\` — a cast is a compile-time fiction that lets unvalidated data flow through the system. Every seam (adapter read, write argument, input, output) must go through \`assert(XxxDto, value, context)\` so the data is validated at runtime.

Be concise (2-3 sentences).`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `File: ${path}
Violations:
${violations.map((v) => "  - " + v).join("\n")}

Each flagged cast should become \`assert(XxxDto, value, "<noun>.<verb>")\` so the seam is validated at runtime instead of blindly asserted at compile time. What should the developer change?`;
}
