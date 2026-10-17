import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";
import {
  type CseNode,
  parse,
  type StepLike,
} from "@rune/domain/business/rune-parse/mod.ts";
import {
  declaresFaults,
  faultsFilePath,
} from "@rune/domain/business/rune-manifest/mod.ts";
import {
  applyCase,
  bindings,
  isProjectSpec,
  moduleFromSpecPath,
  processName,
  transformName,
  typFileName,
} from "@rune/domain/business/rune-bindings/mod.ts";

// rune-extra-files: folders/files in rune-managed slots that no rune element
// predicts are flagged as orphans. The opposite of the *-presence rules:
//   - presence rules say "rune declared X — where is it on disk?"
//   - this rule says "X is on disk — what rune declared it?"

interface Predictions {
  dirs: Set<string>;
  files: Set<string>;
  modules: Set<string>;
}

const cache = new WeakMap<PipelineContext, Predictions>();

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  // Only fire on folders or .ts files inside rune-managed slots.
  const slotInfo = classifyPath(path, target);
  if (!slotInfo) return null;

  const predictions = await getPredictions(ctx);

  // Skip if the path's module isn't even rune-managed (no rune file declares it).
  if (!predictions.modules.has(slotInfo.module)) return null;

  if (slotInfo.kind === "dir") {
    if (!predictions.dirs.has(path)) {
      return [
        `Orphan ${slotInfo.slot} folder: ${path} — no rune element declares it`,
      ];
    }
  } else {
    if (!predictions.files.has(path)) {
      return [
        `Orphan ${slotInfo.slot} file: ${path} — no rune element declares it`,
      ];
    }
  }

  return null;
}

interface SlotInfo {
  module: string;
  slot: "coordinator" | "business-feature" | "adapter" | "entrypoint" | "dto";
  kind: "dir" | "file";
}

function classifyPath(path: string, target: EntryTarget): SlotInfo | null {
  if (!path.startsWith("src/")) return null;
  const parts = path.slice("src/".length).split("/");
  if (parts.length < 2) return null;
  if (parts[0] === "core") return null; // core/ has its own rules; skip here.
  const module = parts[0];

  // src/<module>/domain/coordinators/<process>
  if (
    parts[1] === "domain" && parts[2] === "coordinators" &&
    parts.length === 4 && target === "folder"
  ) {
    return { module, slot: "coordinator", kind: "dir" };
  }
  // src/<module>/domain/business/<feature>
  if (
    parts[1] === "domain" && parts[2] === "business" && parts.length === 4 &&
    target === "folder"
  ) {
    return { module, slot: "business-feature", kind: "dir" };
  }
  // src/<module>/domain/data/<service>
  if (
    parts[1] === "domain" && parts[2] === "data" && parts.length === 4 &&
    target === "folder"
  ) {
    return { module, slot: "adapter", kind: "dir" };
  }
  // src/<module>/entrypoints/<surface>
  if (parts[1] === "entrypoints" && parts.length === 3 && target === "folder") {
    return { module, slot: "entrypoint", kind: "dir" };
  }
  // src/<module>/dto/<name>.ts
  if (parts[1] === "dto" && parts.length === 3 && target === "ts") {
    return { module, slot: "dto", kind: "file" };
  }
  return null;
}

async function getPredictions(ctx: PipelineContext): Promise<Predictions> {
  const cached = cache.get(ctx);
  if (cached) return cached;

  const dirs = new Set<string>();
  const files = new Set<string>();
  const modules = new Set<string>();
  const dtoBinding = bindings["<name>"];

  const runeFiles = ctx.files.filter((f) =>
    f.endsWith(".rune") && isProjectSpec(f)
  );
  for (const path of runeFiles) {
    const text = await ctx.getFileContent(path);
    const ast = parse(text);
    const moduleName = ast.module ?? moduleFromSpecPath(path);
    if (!moduleName) continue;
    modules.add(moduleName);

    for (const req of ast.reqs) {
      dirs.add(
        `src/${moduleName}/domain/coordinators/${
          processName(req.noun, req.verb)
        }`,
      );
      walkSteps(req.steps, moduleName, dirs);
    }

    for (const dto of ast.dtos) {
      const name = transformName(dto.name, dtoBinding);
      const moduleScope = dto.isCore ? "core" : moduleName;
      files.add(`src/${moduleScope}/dto/${name}.ts`);
    }

    for (const typ of ast.typs) {
      // Mirror the generator's collision handling (and rune-typ-shape): a [TYP]
      // sharing a same-dir [DTO]'s stripped stem (cap vs CapDto) is written with
      // a `-type` suffix. Predict it the SAME way the presence rule requires it,
      // else the real `<name>-type.ts` file is wrongly flagged as an orphan.
      const dtoNamesSameDir = ast.dtos
        .filter((d) => !!d.isCore === !!typ.isCore)
        .map((d) => d.name);
      const name = typFileName(typ.name, dtoNamesSameDir, dtoBinding);
      const moduleScope = typ.isCore ? "core" : moduleName;
      files.add(`src/${moduleScope}/dto/${name}.ts`);
    }

    for (const ent of ast.ents) {
      const surface = applyCase(ent.surface, "kebab");
      dirs.add(`src/${moduleName}/entrypoints/${surface}`);
    }
    // The module's fault classes (REQ-018).
    if (declaresFaults(ast)) files.add(faultsFilePath(moduleName));
  }

  const result: Predictions = { dirs, files, modules };
  cache.set(ctx, result);
  return result;
}

function walkSteps(
  steps: StepLike[] | CseNode["steps"],
  moduleName: string,
  dirs: Set<string>,
): void {
  for (const step of steps) {
    if (step.kind === "step") {
      dirs.add(
        `src/${moduleName}/domain/business/${applyCase(step.noun, "kebab")}`,
      );
    } else if (step.kind === "boundary") {
      dirs.add(
        `src/${moduleName}/domain/data/${applyCase(step.noun, "kebab")}`,
      );
    } else if (step.kind === "ply") {
      dirs.add(
        `src/${moduleName}/domain/business/${applyCase(step.noun, "kebab")}`,
      );
      for (const cse of step.cases) {
        walkSteps(cse.steps, moduleName, dirs);
      }
    }
  }
}

export const SYSTEM_PROMPT = `You are enforcing the rune-extra-files rule.

Folders and files in rune-managed slots (coordinators/, domain/business/, domain/data/, entrypoints/, dto/) should be backed by a rune element. Orphans suggest either:
  - the rune was changed to remove an element, but the code wasn't deleted yet, OR
  - someone added code without updating the rune first.

Either way, the rune is the source of truth. Reconcile by deleting the orphan or restoring the rune element.`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `Path: ${path}
${violations.join("\n")}

Either:
  - Delete this folder/file (use \`rune prune\` for whole-slot orphans), or
  - Restore the corresponding rune element so this code is declared.`;
}
