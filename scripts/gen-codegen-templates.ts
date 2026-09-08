#!/usr/bin/env -S deno run -A
// Mirror the engine's DEFAULT_TEMPLATES into the artifact's codegen.templates,
// so the registry carries the canonical codegen bodies (WO-4b). Run once to
// seed / re-sync:
//
//   deno run -A scripts/gen-codegen-templates.ts
//
// Sourced from the engine so the artifact copy is byte-identical to the engine
// default (L3 baseline). Only the tpl()-honoring roles are mirrored — the
// other roles render through dedicated renderers (renderDto, renderImpl, …)
// and a template entry for them would be dead data. codegen.policies is left
// untouched. After running, re-check the Drift gate (`deno task verify`).
import { DEFAULT_TEMPLATES } from "@rune/domain/business/rune-manifest/mod.ts";

// The roles whose bodies actually flow through tpl() in rune-manifest, in the
// artifact's key order (so a re-run is byte-stable against keywords.json).
const TPL_KEYS = [
  "coordinator-int-test",
  "poly-base-mod",
  "poly-base-test",
  "poly-mod",
  "poly-impl-mod",
  "poly-impl-test",
  "adapter-smk-test",
  "mod-root",
];

const p = new URL("../lang/keywords.json", import.meta.url);
const reg = JSON.parse(await Deno.readTextFile(p));
const templates: Record<string, string> = {};
for (const key of TPL_KEYS) {
  const body = (DEFAULT_TEMPLATES as Record<string, string>)[key];
  if (body === undefined) {
    console.error(`engine DEFAULT_TEMPLATES is missing "${key}" — aborting`);
    Deno.exit(1);
  }
  templates[key] = body;
}
reg.codegen = { ...reg.codegen, templates };
await Deno.writeTextFile(p, JSON.stringify(reg, null, 2) + "\n");
console.log(
  `wrote codegen.templates: ${TPL_KEYS.length} templates (policies untouched)`,
);
