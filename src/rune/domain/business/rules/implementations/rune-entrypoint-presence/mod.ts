import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import {
  applyCase,
  isProjectSpec,
  moduleFromSpecPath,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-entrypoint-presence: every [ENT] in a rune file requires:
//   src/<module>/entrypoints/<surface>/mod.ts
//   src/<module>/entrypoints/<surface>/e2e.test.ts

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

  for (const ent of ast.ents) {
    const surface = applyCase(ent.surface, "kebab");
    const dir = `src/${moduleName}/entrypoints/${surface}`;
    const mod = `${dir}/mod.ts`;
    const e2e = `${dir}/e2e.test.ts`;
    if (!fileSet.has(mod)) {
      violations.push(
        `Missing entrypoint file: ${mod} (for [ENT] ${ent.surface}.${ent.action} at line ${
          ent.line + 1
        })`,
      );
    }
    if (!fileSet.has(e2e)) {
      violations.push(
        `Missing entrypoint e2e test: ${e2e} (for [ENT] ${ent.surface}.${ent.action} at line ${
          ent.line + 1
        })`,
      );
    }
  }

  return violations.length > 0 ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are enforcing the rune-entrypoint-presence rule.

Every [ENT] in a rune file declares an inbound entrypoint. It requires:
  src/<module>/entrypoints/<surface>/mod.ts        (the entrypoint handler)
  src/<module>/entrypoints/<surface>/e2e.test.ts   (end-to-end tests)

The surface name (e.g., \`http\`, \`cli\`, \`queue\`) becomes the entrypoint folder.

A missing entrypoint means the rune declared an inbound surface that isn't yet wired up.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
Missing entrypoint slots:
${violations.map((v) => `  - ${v}`).join("\n")}

Either run \`rune manifest ${path}\` to scaffold the missing files, or remove the [ENT] from the rune.`;
}
