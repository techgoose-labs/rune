import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import {
  CORE_SPEC_REL,
  isCoreSpec,
  isProjectSpec,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-service-core-only: `[SRV]` is shared infrastructure and may be declared in
// exactly one place — src/core/core.rune. A `[SRV]` in any other project spec is
// an error: it would fragment a service's transport/env/docs across modules and
// shadow the shared declaration. The companion rune-service-presence rule then
// resolves every boundary prefix against that single core spec.

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target !== "rune") return null;
  if (!isProjectSpec(path)) return null;
  if (isCoreSpec(path)) return null; // the one allowed [SRV] site

  const ast = parse(await ctx.getFileContent(path));
  if (ast.srvs.length === 0) return null;

  return ast.srvs.map((s) =>
    `[SRV] (${s.transport})${s.name} declared in a module spec (line ${
      s.line + 1
    }) — shared services must be declared once in ${CORE_SPEC_REL}`
  );
}

export const SYSTEM_PROMPT = `You are enforcing the rune-service-core-only rule.

[SRV] declarations are shared infrastructure. They live in exactly one spec —
src/core/core.rune — so a backing service's transport, env vars, and @docs link
have a single source of truth. Every other module spec references those services
by prefix (\`service:noun.verb(...)\`) without re-declaring them.

A [SRV] in any spec other than core.rune is a violation: move it to
src/core/core.rune and delete the local declaration.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
Misplaced [SRV] declarations:
${violations.map((v) => `  - ${v}`).join("\n")}

Move each [SRV] to src/core/core.rune (the single shared-service spec) and remove
it here. The module's boundary steps keep working — they resolve the service from
core.rune automatically.`;
}
