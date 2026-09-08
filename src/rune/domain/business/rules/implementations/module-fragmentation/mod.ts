import { getModuleFromPath } from "@core/business/classify/mod.ts";
import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";

const EXCLUDED_MODULES = new Set(["core", "bootstrap"]);
const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx"]);
const DOMAIN_LAYERS = ["business", "data", "coordinators"];
const TOP_LAYERS = ["entrypoints", "dto"];
const ALL_LAYERS = [...DOMAIN_LAYERS, ...TOP_LAYERS];

const MIN_SOURCE_FILES = 5;
const MIN_BUSINESS_FEATURES = 2;
const MIN_ACTIVE_LAYERS = 2;
const COUPLING_THRESHOLD = 0.5;
const COUPLING_MIN_IMPORTS = 3;

function isSourceFile(path: string): boolean {
  const ext = path.split(".").pop() ?? "";
  if (!SOURCE_EXTS.has(ext)) return false;
  const base = path.split("/").pop() ?? "";
  return !base.includes("test.");
}

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target !== "folder") return null;

  const segs = path.split("/");
  if (segs.length !== 2 || segs[0] !== "src") return null;

  const moduleName = segs[1];
  if (EXCLUDED_MODULES.has(moduleName)) return null;

  const moduleFiles = ctx.files.filter((f) => f.startsWith(path + "/"));
  const sourceFiles = moduleFiles.filter(isSourceFile);

  if (sourceFiles.length < 2) return null;

  const violations: string[] = [];

  // Signal 1: Small module
  const isSmall = sourceFiles.length < MIN_SOURCE_FILES;
  if (isSmall) {
    violations.push(
      `Module only has ${sourceFiles.length} source files — consider merging it into a related module`,
    );
  }

  // Signal 3 (computed early — it corroborates the single-feature signal below):
  // underutilized layers.
  const activeLayers: string[] = [];
  for (const layer of DOMAIN_LAYERS) {
    if (ctx.dirs.includes(path + "/domain/" + layer)) activeLayers.push(layer);
  }
  for (const layer of TOP_LAYERS) {
    if (ctx.dirs.includes(path + "/" + layer)) activeLayers.push(layer);
  }
  const isUnderutilized = activeLayers.length < MIN_ACTIVE_LAYERS;

  // Signal 2: Single-feature module. A single business noun is, on its own, a
  // legitimate module shape (a focused service like `secrets` may have exactly
  // one noun) — so this signal only contributes when CORROBORATED by structural
  // thinness (a small file count or an underused layer set). Alone it is not
  // fragmentation, and firing it alone blocked correct single-noun modules from
  // reaching "All clear".
  const businessDir = path + "/domain/business";
  const businessFeatures = ctx.dirs.filter(
    (d) =>
      d.startsWith(businessDir + "/") &&
      d.split("/").length === businessDir.split("/").length + 1,
  );
  if (
    businessFeatures.length > 0 &&
    businessFeatures.length < MIN_BUSINESS_FEATURES &&
    (isSmall || isUnderutilized)
  ) {
    const names = businessFeatures.map((d) => d.split("/").pop());
    violations.push(
      `Module has only one business feature (${
        names.join(", ")
      }) — it may not need its own module`,
    );
  }

  if (isUnderutilized) {
    const layerList = activeLayers.length > 0
      ? activeLayers.join(", ")
      : "none";
    violations.push(
      `Module only uses ${activeLayers.length} layer(s) (${layerList}) — consider merging into a module that uses more of the architecture`,
    );
  }

  // Signal 4: High coupling (only for already-flagged modules)
  if (violations.length > 0) {
    const importCounts = new Map<string, number>();
    let totalCrossModule = 0;

    for (const file of sourceFiles) {
      const imports = await ctx.getImports(file);
      for (const imp of imports) {
        const targetMod = getModuleFromPath(imp);
        if (targetMod && targetMod !== moduleName && targetMod !== "core") {
          importCounts.set(targetMod, (importCounts.get(targetMod) ?? 0) + 1);
          totalCrossModule++;
        }
      }
    }

    if (totalCrossModule > 0) {
      for (const [targetMod, count] of importCounts) {
        const ratio = count / totalCrossModule;
        if (ratio >= COUPLING_THRESHOLD && count >= COUPLING_MIN_IMPORTS) {
          violations.push(
            `Most of this module's imports (${count}) come from "${targetMod}" — consider merging into that module`,
          );
        }
      }
    }
  }

  return violations.length > 0 ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor detecting fragmented modules that should be consolidated.

Signals of fragmentation:
- Very few source files (module is too small to justify its own namespace)
- Only one business feature (could be a feature inside another module)
- Only one active layer (business/data/coordinators/entrypoints/dto)
- Heavy coupling to another module (most imports come from one other module)

Given violations, suggest which module to consolidate into and how. Be concise (2-3 sentences).`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  const moduleName = path.split("/").pop();
  const parts: string[] = [];

  for (const v of violations) {
    if (v.startsWith("small-module:")) {
      parts.push(
        `Module "${moduleName}" has very few source files (${v.split(":")[1]})`,
      );
    }
    if (v.startsWith("single-feature:")) {
      parts.push(
        `Module "${moduleName}" contains only one business feature: ${
          v.split(":")[1]
        }`,
      );
    }
    if (v.startsWith("underutilized-layers:")) {
      parts.push(
        `Module "${moduleName}" only uses layers: ${v.split(":")[1] || "none"}`,
      );
    }
    if (v.startsWith("high-coupling:")) {
      parts.push(
        `Module "${moduleName}" is heavily coupled: ${
          v.split(":").slice(1).join(":")
        }`,
      );
    }
  }

  return `Module path: ${path}
Fragmentation signals:
${parts.map((p) => `  - ${p}`).join("\n")}

Should this module be consolidated into another module? If so, which one and how?`;
}
