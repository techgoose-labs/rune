export { runPipeline } from "./domain/coordinators/pipeline/mod.ts";
export {
  parseArgs,
  printHeader,
  printJson,
  printResults,
} from "./entrypoints/cli.ts";
export { runManifest } from "./entrypoints/manifest/mod.ts";
export { runSync } from "./entrypoints/sync/mod.ts";
export { runInit } from "./entrypoints/init/mod.ts";
export { runCheck } from "./entrypoints/check/mod.ts";
export { runDev, runStop } from "./entrypoints/dev/mod.ts";
export { runValidate } from "./entrypoints/validate/mod.ts";
export { runUpdate } from "./entrypoints/update/mod.ts";
export { runVersion } from "./entrypoints/version/mod.ts";
export type { RuleDefinition } from "@core/dto/types.ts";

import type { RuleDefinition } from "@core/dto/types.ts";

import {
  barrelDiscipline,
  dataClassReturns,
  dtoValidation,
  externalImports,
  fixturePromotion,
  importAliases,
  layerRestrictions,
  moduleFragmentation,
  moduleIsolation,
  noDtoCast,
  polyDetection,
  polyIsolation,
  polyStray,
  runeAdapterPresence,
  runeBusinessPresence,
  runeCoordinatorPresence,
  runeDtoShape,
  runeEntrypointPresence,
  runeExtraFiles,
  runeFaultCoverage,
  runeHealTodo,
  runePolyCases,
  runeServiceCoreOnly,
  runeServicePresence,
  runeSignatureParity,
  runeTypShape,
  structure,
} from "./domain/business/rules/poly-mod.ts";

export const rules: RuleDefinition[] = [
  {
    name: "structure",
    description: "Validates file/folder placement against canonical-paths.json",
    check: structure.check,
    systemPrompt: structure.SYSTEM_PROMPT,
    buildPrompt: structure.buildPrompt,
  },
  {
    name: "layer-restrictions",
    description: "Enforces allowed layer-to-layer import directions",
    check: layerRestrictions.check,
    systemPrompt: layerRestrictions.SYSTEM_PROMPT,
    buildPrompt: layerRestrictions.buildPrompt,
  },
  {
    name: "module-isolation",
    description: "Prevents cross-module imports outside core and mod-root",
    check: moduleIsolation.check,
    systemPrompt: moduleIsolation.SYSTEM_PROMPT,
    buildPrompt: moduleIsolation.buildPrompt,
  },
  {
    name: "poly-isolation",
    description:
      "Ensures poly-mod is the only public surface for polymorphic features",
    check: polyIsolation.check,
    systemPrompt: polyIsolation.SYSTEM_PROMPT,
    buildPrompt: polyIsolation.buildPrompt,
  },
  {
    name: "dto-validation",
    description: "Requires runtime validation in DTO files",
    check: dtoValidation.check,
    systemPrompt: dtoValidation.SYSTEM_PROMPT,
    buildPrompt: dtoValidation.buildPrompt,
  },
  {
    name: "data-class-returns",
    description:
      "Data class methods must return validated class instances (class-validator/class-transformer)",
    check: dataClassReturns.check,
    systemPrompt: dataClassReturns.SYSTEM_PROMPT,
    buildPrompt: dataClassReturns.buildPrompt,
  },
  {
    name: "no-dto-cast",
    description:
      "Coordinators must validate seams with assert(XxxDto, ...) — no blind `as XxxDto` casts",
    check: noDtoCast.check,
    systemPrompt: noDtoCast.SYSTEM_PROMPT,
    buildPrompt: noDtoCast.buildPrompt,
  },
  {
    name: "barrel-discipline",
    description:
      "Restricts re-exports to mod-root, poly-mod, and bootstrap only",
    check: barrelDiscipline.check,
    systemPrompt: barrelDiscipline.SYSTEM_PROMPT,
    buildPrompt: barrelDiscipline.buildPrompt,
  },
  {
    name: "poly-detection",
    description: "Detects sibling features that should be behind a poly-mod",
    check: polyDetection.check,
    systemPrompt: polyDetection.SYSTEM_PROMPT,
    buildPrompt: polyDetection.buildPrompt,
  },
  {
    name: "poly-stray",
    description:
      "Detects standalone features that belong inside an existing poly structure",
    check: polyStray.check,
    systemPrompt: polyStray.SYSTEM_PROMPT,
    buildPrompt: polyStray.buildPrompt,
  },
  {
    name: "import-aliases",
    description: "Bans ../ imports — requires @ aliases instead",
    check: importAliases.check,
    systemPrompt: importAliases.SYSTEM_PROMPT,
    buildPrompt: importAliases.buildPrompt,
  },
  {
    name: "external-imports",
    description: "Bans bare npm:/jsr: — requires # aliases from import map",
    check: externalImports.check,
    systemPrompt: externalImports.SYSTEM_PROMPT,
    buildPrompt: externalImports.buildPrompt,
  },
  {
    name: "fixture-promotion",
    description:
      "Flags fixtures imported by mod/bootstrap files — should be assets instead",
    check: fixturePromotion.check,
    systemPrompt: fixturePromotion.SYSTEM_PROMPT,
    buildPrompt: fixturePromotion.buildPrompt,
  },
  {
    name: "module-fragmentation",
    description:
      "Detects overly fragmented modules that should be consolidated",
    check: moduleFragmentation.check,
    systemPrompt: moduleFragmentation.SYSTEM_PROMPT,
    buildPrompt: moduleFragmentation.buildPrompt,
  },
  {
    name: "rune-coordinator-presence",
    description: "Every [REQ] in a .rune file must have a coordinator folder",
    check: runeCoordinatorPresence.check,
    systemPrompt: runeCoordinatorPresence.SYSTEM_PROMPT,
    buildPrompt: runeCoordinatorPresence.buildPrompt,
  },
  {
    name: "rune-business-presence",
    description:
      "Every untagged step's noun must have a business feature folder",
    check: runeBusinessPresence.check,
    systemPrompt: runeBusinessPresence.SYSTEM_PROMPT,
    buildPrompt: runeBusinessPresence.buildPrompt,
  },
  {
    name: "rune-adapter-presence",
    description: "Every boundary call must have an adapter folder",
    check: runeAdapterPresence.check,
    systemPrompt: runeAdapterPresence.SYSTEM_PROMPT,
    buildPrompt: runeAdapterPresence.buildPrompt,
  },
  {
    name: "rune-service-presence",
    description:
      "Every boundary service: prefix must resolve to a declared [SRV] (shared, from src/core/core.rune)",
    check: runeServicePresence.check,
    systemPrompt: runeServicePresence.SYSTEM_PROMPT,
    buildPrompt: runeServicePresence.buildPrompt,
  },
  {
    name: "rune-service-core-only",
    description:
      "[SRV] may only be declared in src/core/core.rune — shared across all specs",
    check: runeServiceCoreOnly.check,
    systemPrompt: runeServiceCoreOnly.SYSTEM_PROMPT,
    buildPrompt: runeServiceCoreOnly.buildPrompt,
  },
  {
    name: "rune-poly-cases",
    description:
      "Every [PLY] block requires base/, implementations/<case>/, and poly-mod.ts",
    check: runePolyCases.check,
    systemPrompt: runePolyCases.SYSTEM_PROMPT,
    buildPrompt: runePolyCases.buildPrompt,
  },
  {
    name: "rune-entrypoint-presence",
    description: "Every [ENT] must have an entrypoints/<surface>/ folder",
    check: runeEntrypointPresence.check,
    systemPrompt: runeEntrypointPresence.SYSTEM_PROMPT,
    buildPrompt: runeEntrypointPresence.buildPrompt,
  },
  {
    name: "rune-dto-shape",
    description:
      "Every [DTO] must have a Zod schema file with matching properties",
    check: runeDtoShape.check,
    systemPrompt: runeDtoShape.SYSTEM_PROMPT,
    buildPrompt: runeDtoShape.buildPrompt,
  },
  {
    name: "rune-typ-shape",
    description: "Every [TYP] must have a corresponding type file",
    check: runeTypShape.check,
    systemPrompt: runeTypShape.SYSTEM_PROMPT,
    buildPrompt: runeTypShape.buildPrompt,
  },
  {
    name: "rune-fault-coverage",
    description:
      "Every fault declared in a rune must have a Deno.test case in the relevant test file",
    check: runeFaultCoverage.check,
    systemPrompt: runeFaultCoverage.SYSTEM_PROMPT,
    buildPrompt: runeFaultCoverage.buildPrompt,
  },
  {
    name: "rune-extra-files",
    description:
      "Folders/files in rune-managed slots without a backing rune element are flagged as orphans",
    check: runeExtraFiles.check,
    systemPrompt: runeExtraFiles.SYSTEM_PROMPT,
    buildPrompt: runeExtraFiles.buildPrompt,
  },
  {
    name: "rune-signature-parity",
    description:
      "Coordinator and entrypoint files must reference the input/output DTOs declared by the rune",
    check: runeSignatureParity.check,
    systemPrompt: runeSignatureParity.SYSTEM_PROMPT,
    buildPrompt: runeSignatureParity.buildPrompt,
  },
  {
    name: "rune-heal-todo",
    description:
      "Generated spec/misc/heal-rules.json entries must be enriched (todo:true removed) — strict-gated",
    check: runeHealTodo.check,
    systemPrompt: runeHealTodo.SYSTEM_PROMPT,
    buildPrompt: runeHealTodo.buildPrompt,
  },
];
