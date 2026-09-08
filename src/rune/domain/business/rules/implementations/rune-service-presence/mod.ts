import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import {
  type CseNode,
  parse,
  type StepLike,
} from "@rune/domain/business/rune-parse/mod.ts";
import {
  CORE_SPEC_REL,
  isCoreSpec,
  isProjectSpec,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-service-presence: every boundary call `service:noun.verb(...)` must name a
// service declared by a matching `[SRV] <transport>:<service>: <ENV,…>`. Services
// are shared: they are declared ONCE in src/core/core.rune and resolved from
// there by every module spec (the core spec resolves against its own [SRV]). The
// `service:` prefix replaced the old fixed db:/fs:/… kinds — there are no builtin
// boundaries anymore, so an undeclared service is a spec error.

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target !== "rune") return null;
  if (!isProjectSpec(path)) return null;

  const text = await ctx.getFileContent(path);
  const ast = parse(text);

  // Resolve against the shared service set. The core spec is its own source; any
  // other spec reads core.rune (when present) — services declared there are
  // visible here without a local [SRV].
  const declared = new Set<string>();
  if (isCoreSpec(path)) {
    for (const s of ast.srvs) declared.add(s.name);
  } else {
    // A module spec resolves services from the project's core spec, wherever it
    // lives: src/core/core.rune, or spec/core.rune / specs/core.rune in a flat
    // spec-folder layout.
    const corePath = ctx.files.find((f) => isCoreSpec(f));
    if (corePath) {
      const coreAst = parse(await ctx.getFileContent(corePath));
      for (const s of coreAst.srvs) declared.add(s.name);
    }
  }

  const used = new Map<string, number>(); // service -> first line
  for (const req of ast.reqs) collectServices(req.steps, used);

  const violations: string[] = [];
  for (const [service, line] of used) {
    if (!declared.has(service)) {
      violations.push(
        `Undeclared service "${service}" (boundary at line ${line + 1}) — ` +
          `declare it once in ${CORE_SPEC_REL} as ` +
          `\`[SRV] (TRANSPORT)${service}: <ENV,…>\` ` +
          `(transport: SDK/HTTP/WEBSOCKET/SIDECAR/NATIVE)`,
      );
    }
  }
  return violations.length > 0 ? violations : null;
}

function collectServices(
  steps: StepLike[] | CseNode["steps"],
  out: Map<string, number>,
): void {
  for (const step of steps) {
    if (step.kind === "boundary") {
      if (!out.has(step.service)) out.set(step.service, step.line);
    } else if (step.kind === "ply") {
      for (const cse of step.cases) collectServices(cse.steps, out);
    }
  }
}

export const SYSTEM_PROMPT = `You are enforcing the rune-service-presence rule.

Every boundary call uses a declared service prefix: \`service:noun.verb(...)\`.
Services are SHARED: declare each one ONCE in src/core/core.rune:
  [SRV] (TRANSPORT)<service>: <ENV_VAR, ENV_VAR2>
where transport is one of (SDK) / (HTTP) / (WEBSOCKET) / (SIDECAR) / (NATIVE).
(NATIVE = an in-process runtime/std-lib boundary — filesystem, subprocess,
crypto, clock — that is neither a network surface nor a co-located process.)
Every module spec resolves its boundary services from that core spec — there is
no per-module [SRV].

An undeclared service means a boundary points at a backing service no core.rune
declared (its transport + config are unknown).`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Rune file: ${path}
Undeclared services:
${violations.map((v) => `  - ${v}`).join("\n")}

Add a [SRV] declaration for each service to src/core/core.rune, or change the
boundary prefix to a service that core.rune already declares.`;
}
