import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import {
  bindings,
  isProjectSpec,
  moduleFromSpecPath,
  typFileName,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-typ-shape: every [TYP] in a rune file must have a corresponding file at:
//   - src/<module>/dto/<name>.ts        (default)
//   - src/core/dto/<name>.ts            (with :core modifier)
// And the file must mention the type name as an exported identifier.

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
  const nameBinding = bindings["<name>"];

  for (const typ of ast.typs) {
    // Mirror the generator's collision handling: a [TYP] sharing a same-dir
    // [DTO]'s stripped stem (principal vs PrincipalDto) is written with a
    // `-type` suffix, so the rule must look for it there, not at the bare stem.
    const dtoNamesSameDir = ast.dtos
      .filter((d) => !!d.isCore === !!typ.isCore)
      .map((d) => d.name);
    const fileName = typFileName(typ.name, dtoNamesSameDir, nameBinding);
    const dir = typ.isCore ? "src/core/dto" : `src/${moduleName}/dto`;
    const filePath = `${dir}/${fileName}.ts`;

    if (!fileSet.has(filePath)) {
      violations.push(
        `Missing TYP file: ${filePath} (for [TYP${
          typ.isCore ? ":core" : ""
        }] ${typ.name} at line ${typ.line + 1})`,
      );
      continue;
    }

    const content = await ctx.getFileContent(filePath);
    // The type name should appear as an identifier somewhere.
    const re = new RegExp(`\\b${escapeRegex(typ.name)}\\b`);
    if (!re.test(content)) {
      violations.push(
        `TYP ${filePath} doesn't reference "${typ.name}" — file may not match the rune declaration (line ${
          typ.line + 1
        })`,
      );
    }
  }

  return violations.length > 0 ? violations : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const SYSTEM_PROMPT = `You are enforcing the rune-typ-shape rule.

Every [TYP] in a rune file must have a corresponding type file:
  - src/<module>/dto/<name>.ts        (default)
  - src/core/dto/<name>.ts            (with [TYP:core])

The file must export a type or constant matching the rune name (e.g., \`[TYP] url: string\` requires a \`url\` identifier in the file).

A missing file or missing identifier means the type isn't backed by code.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
TYP shape mismatches:
${violations.map((v) => `  - ${v}`).join("\n")}

Either run \`rune manifest ${path}\` to scaffold the missing types, or update the file to export the missing identifier.`;
}
