import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import {
  type HealRules,
  readHealRules,
  todoSlugs,
} from "@rune/domain/business/rune-heal/mod.ts";
import { basename } from "#std/path";

// rune-heal-todo: every entry in a generated `spec/misc/heal-rules.json` should be
// ENRICHED before a module ships — its scaffold `todo: true` flag replaced with a
// real suggestion + `why`. rune sync nudges about this on every run (the always-on
// signal); this rule is the enforcement teeth.
//
// Strict-gated on purpose. A fresh scaffold mid-work must not block iteration, so
// the rule stays SILENT in a plain `rune lint`. Under strict — `rune lint --strict`,
// or `RUNE_LINT_STRICT`/`RUNE_STRICT` in the env (the CI profile) — it fires as a
// normal (failing) violation, so a project can refuse to ship un-enriched rules.
// (The engine's lint CLI treats every violation as an error and exits 1; gating on
// strict is how we get "warning by default, error under strict" without flipping
// the exit semantics of every other rule.)

// The keep cake artifact name; matched dir-agnostically so a KEEP_FIXTURES_DIR
// override (the file need not live in `fixtures/`) is still covered.
const HEAL_RULES_FILE = "heal-rules.json";

/** Strict mode: an explicit `--strict` flag (the CLI sets RUNE_LINT_STRICT) or a
 * truthy strict env var (the CI profile). Off → the rule is a no-op. */
export function isStrict(): boolean {
  const on = (v: string | undefined) =>
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return on(Deno.env.get("RUNE_LINT_STRICT")) ||
    on(Deno.env.get("RUNE_STRICT"));
}

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target !== "json") return null;
  if (basename(path) !== HEAL_RULES_FILE) return null;
  if (!isStrict()) return null; // non-blocking by default — sync output nudges instead

  let rules: HealRules | null;
  try {
    rules = readHealRules(JSON.parse(await ctx.getFileContent(path)));
  } catch {
    return null; // malformed JSON is keep's / sync's concern, not this rule's
  }
  if (rules === null) return null; // not a heal-rules document

  const pending = todoSlugs(rules);
  if (pending.length === 0) return null;

  return pending.map((slug) =>
    `heal-rules slug "${slug}" is an un-enriched scaffold (todo: true) — replace ` +
    `its TODO suggestion with a real run-step/set-input/pick/retry/note + a ` +
    `concrete \`why\`, then drop \`todo: true\`.`
  );
}

export const SYSTEM_PROMPT = `You are enforcing the rune-heal-todo rule.

A generated spec/misc/heal-rules.json drives keep's cake self-heal panel: when an endpoint fails, its fault slug is looked up here and the suggestions become one-click fixes. rune scaffolds one entry per slug with a placeholder marked \`todo: true\`. An un-enriched entry shows the user a TODO label instead of a real fix.

Enrichment means answering, for each slug: what state makes this slug fire, and what is the cheapest path out? Prefer, in order: run-step (a concrete or regex endpoint that repairs the state) -> pick/set-input (a value already present in captures) -> retry (transient causes only, with the reason in \`why\`) -> note (pure guidance, e.g. an env var to set; add retryAfter when a retry helps after the human acts). Never propose a destructive endpoint as a run-step. The \`why\` is shown verbatim to the user, so write it as the one-line explanation of the fix. Then remove the \`todo: true\` flag.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `File: ${path}
${violations.join("\n")}

Enrich each listed slug in ${path}: replace the TODO suggestion with a concrete
fix (run-step/set-input/pick/retry/note) and a real \`why\`, then delete the
\`todo: true\` flag. A module is not done while todo:true entries remain.`;
}
