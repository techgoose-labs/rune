import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import {
  bindings,
  isProjectSpec,
  moduleFromSpecPath,
  transformName,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-dto-shape: every [DTO] in a rune file must have a Zod schema file at:
//   - src/<module>/dto/<name>.ts        (default)
//   - src/core/dto/<name>.ts            (with :core modifier)
// And the file must mention every property declared in the rune.

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
  const dtoBinding = bindings["<name>"];

  for (const dto of ast.dtos) {
    const fileName = transformName(dto.name, dtoBinding);
    const dir = dto.isCore ? "src/core/dto" : `src/${moduleName}/dto`;
    const filePath = `${dir}/${fileName}.ts`;

    if (!fileSet.has(filePath)) {
      violations.push(
        `Missing DTO file: ${filePath} (for [DTO${
          dto.isCore ? ":core" : ""
        }] ${dto.name} at line ${dto.line + 1})`,
      );
      continue;
    }

    const content = await ctx.getFileContent(filePath);
    const missing = findMissingProperties(content, dto.properties);
    if (missing.length > 0) {
      violations.push(
        `DTO ${filePath} is missing properties from rune: ${
          missing.join(", ")
        } (line ${dto.line + 1})`,
      );
    }
  }

  return violations.length > 0 ? violations : null;
}

// Each rune property like "providerName", "metadata?", "url(s)" must appear as an
// identifier in the DTO file. Normalize the rune property to its bare form.
function findMissingProperties(
  content: string,
  properties: string[],
): string[] {
  const missing: string[] = [];
  for (const raw of properties) {
    const ident = normalizeProperty(raw);
    if (!ident) continue;
    // Match the identifier as a whole word (boundary-anchored).
    const re = new RegExp(`\\b${escapeRegex(ident)}\\b`);
    if (!re.test(content)) missing.push(ident);
  }
  return missing;
}

function normalizeProperty(raw: string): string | null {
  // "metadata?" → "metadata"
  let s = raw.endsWith("?") ? raw.slice(0, -1) : raw;
  // "url(s)" → "urls", "address(es)" → "addresses", "child(ren)" → "children"
  const arrMatch = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([a-z]+)\??\)$/);
  if (arrMatch) {
    return `${arrMatch[1]}${arrMatch[2]}`;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const SYSTEM_PROMPT = `You are enforcing the rune-dto-shape rule.

Every [DTO] in a rune file must have a corresponding Zod schema file:
  - src/<module>/dto/<name>.ts        (default — module-local DTO)
  - src/core/dto/<name>.ts            (with [DTO:core] — shared kernel DTO)

The file must export a Zod schema (or equivalent runtime validator) that includes every property declared in the rune. Property names normalize: "metadata?" → "metadata", "url(s)" → "urls".

A missing file or missing property means the code's DTO doesn't match the spec.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
DTO shape mismatches:
${violations.map((v) => `  - ${v}`).join("\n")}

Either run \`rune manifest ${path}\` to scaffold the missing DTOs, or update the schema file to include the missing properties.`;
}
