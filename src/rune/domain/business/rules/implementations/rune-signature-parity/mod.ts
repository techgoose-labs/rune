import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import {
  applyCase,
  isProjectSpec,
  moduleFromSpecPath,
  processName,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-signature-parity: each [REQ] coordinator file and each [ENT] entrypoint
// file must reference the input and output DTOs declared in the rune.
//
// This is approximate — the rule confirms the named DTOs appear as identifiers
// in the implementation file. A proper structural check would use the LSP, but
// the cheap version catches the common errors (wrong DTO, missing DTO, typo).

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

  // Coordinator signatures.
  for (const req of ast.reqs) {
    const file = `src/${moduleName}/domain/coordinators/${
      processName(req.noun, req.verb)
    }/mod.ts`;
    if (!fileSet.has(file)) continue;
    const content = await ctx.getFileContent(file);
    const missing = checkSignatureRefs(content, req.input, req.output);
    for (const m of missing) {
      violations.push(
        `${file}: ${m} (rune declares [REQ] ${req.noun}.${req.verb}(${req.input}): ${req.output} at line ${
          req.line + 1
        })`,
      );
    }
  }

  // Entrypoint signatures.
  for (const ent of ast.ents) {
    const surface = applyCase(ent.surface, "kebab");
    const file = `src/${moduleName}/entrypoints/${surface}/mod.ts`;
    if (!fileSet.has(file)) continue;
    const content = await ctx.getFileContent(file);
    const missing = checkSignatureRefs(content, ent.input, ent.output);
    for (const m of missing) {
      violations.push(
        `${file}: ${m} (rune declares [ENT] ${ent.surface}.${ent.action}(${ent.input}): ${ent.output} at line ${
          ent.line + 1
        })`,
      );
    }
  }

  return violations.length > 0 ? violations : null;
}

function checkSignatureRefs(
  content: string,
  input: string,
  output: string,
): string[] {
  const missing: string[] = [];
  // Skip inline DTO inputs like `{a:b, c:d}` — only named DTOs are checked.
  const inputName = isNamedDto(input) ? input : null;
  const outputName = isNamedDto(output) ? output : null;
  if (inputName && !mentionsIdent(content, inputName)) {
    missing.push(`signature does not reference input DTO "${inputName}"`);
  }
  if (outputName && !mentionsIdent(content, outputName)) {
    missing.push(`signature does not reference output DTO "${outputName}"`);
  }
  return missing;
}

function isNamedDto(s: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*Dto$/.test(s.trim());
}

function mentionsIdent(content: string, ident: string): boolean {
  const re = new RegExp(
    `\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  );
  return re.test(content);
}

export const SYSTEM_PROMPT = `You are enforcing the rune-signature-parity rule.

Each coordinator file (src/<module>/domain/coordinators/<process>/mod.ts) and each entrypoint file (src/<module>/entrypoints/<surface>/mod.ts) must reference the input and output DTOs declared by the rune. A function whose signature doesn't include the right DTOs has drifted from the spec.

This rule's check is approximate — it verifies the DTO names appear in the file. Stricter signature checks (parameter order, generic args) would require LSP analysis.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
Signature mismatches:
${violations.map((v) => `  - ${v}`).join("\n")}

Update the function signatures so they reference the DTOs declared in the rune.`;
}
