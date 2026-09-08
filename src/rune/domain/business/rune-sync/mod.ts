// Rune sync planner: one reconcile pass over a .rune spec against the project
// file set. Pure — no I/O. Combines scaffold (reuse planManifest) with prune of
// rune-managed slots the spec no longer declares.
//
//   toCreate  — new files the spec predicts that don't exist yet (from manifest)
//   toSkip    — predicted files that already exist (preserved, never clobbered)
//   toPrune   — folders/files in rune slots no element predicts (orphans)
//
// The prune prediction mirrors rune-extra-files: feature/coordinator/adapter/
// entrypoint slots are pruned at the folder level; dto/ at the file level.

import {
  type CseNode,
  parse,
  type StepLike,
} from "@rune/domain/business/rune-parse/mod.ts";
import {
  applyCase,
  bindings,
  processName,
  transformName,
  typFileName,
} from "@rune/domain/business/rune-bindings/mod.ts";
import {
  type FilePlan,
  type ManifestOptions,
  planManifest,
  pruneRoleFor,
  resolvePolicy,
} from "@rune/domain/business/rune-manifest/mod.ts";
import type { SrvNode } from "@rune/domain/business/rune-parse/mod.ts";

export interface SyncPlan {
  module: string;
  rune: string;
  toCreate: FilePlan[];
  toRegenerate: FilePlan[];
  /** Every orphan the spec no longer declares that policy allows pruning. */
  toPrune: string[];
  /** The subset of toPrune that holds hand-written bodies (dev-owned). The
   * entrypoint requires --force to delete these; spec-owned orphans (dto files)
   * prune without it. */
  toPruneOwned: string[];
  toSkip: FilePlan[];
  errors: string[];
}

interface Predictions {
  dirs: Set<string>;
  files: Set<string>;
}

// Plan a sync run. Pure: the caller decides whether to write/delete. `opts`
// (artifact bindings/codegen/policies) flow into planManifest AND govern prune:
// a role with prunable:false is never deleted, and dev-owned orphans are split
// into toPruneOwned so the caller can gate them behind --force.
export function planSync(
  runePath: string,
  runeText: string,
  existingFiles: Set<string>,
  opts: ManifestOptions = {},
  // The project's shared `[SRV]` set from src/core/core.rune, forwarded to
  // planManifest so a module's adapters resolve their backing services.
  sharedSrvs?: Map<string, SrvNode>,
): SyncPlan {
  const manifest = planManifest(
    runePath,
    runeText,
    existingFiles,
    opts,
    sharedSrvs,
  );
  const plan: SyncPlan = {
    module: manifest.module,
    rune: runePath,
    toCreate: manifest.toCreate,
    toRegenerate: manifest.toRegenerate,
    toPrune: [],
    toPruneOwned: [],
    toSkip: manifest.toSkip,
    errors: manifest.errors,
  };
  if (manifest.errors.length > 0 || !manifest.module) return plan;

  const module = manifest.module;
  const ast = parse(runeText);
  const predicted = predictPaths(ast, module);

  // activePolicies is set by the planManifest call above; resolvePolicy reads it.
  const prune = new Set<string>();
  const owned = new Set<string>();
  const consider = (target: string, slot: Slot) => {
    const { role, owned: who } = pruneRoleFor(
      slot.kind === "dir"
        ? { kind: "dir", category: slot.category }
        : { kind: "file" },
    );
    if (!resolvePolicy(role).prunable) return; // policy forbids deleting this role
    prune.add(target);
    if (who === "dev") owned.add(target);
  };

  for (const file of existingFiles) {
    const slot = classify(file, module);
    if (!slot) continue;
    if (slot.kind === "dir") {
      if (!predicted.dirs.has(slot.dir)) consider(slot.dir, slot);
    } else if (!predicted.files.has(file)) {
      consider(file, slot);
    }
  }

  plan.toPrune = [...prune].sort();
  plan.toPruneOwned = [...owned].sort();
  return plan;
}

// ---- prediction: every rune-managed dir/file the spec declares ----

function predictPaths(
  ast: ReturnType<typeof parse>,
  module: string,
): Predictions {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const dtoBinding = bindings["<name>"];

  for (const req of ast.reqs) {
    dirs.add(
      `src/${module}/domain/coordinators/${processName(req.noun, req.verb)}`,
    );
    walkSteps(req.steps, module, dirs);
  }
  for (const dto of ast.dtos) {
    const name = transformName(dto.name, dtoBinding);
    const scope = dto.isCore ? "core" : module;
    files.add(`src/${scope}/dto/${name}.ts`);
  }
  for (const typ of ast.typs) {
    // Mirror the generator's collision handling (rune-manifest / rune-typ-shape /
    // rune-extra-files): a [TYP] sharing a same-dir [DTO]'s stripped stem
    // (channel vs ChannelDto) is written to `dto/<name>-type.ts`. Predict it the
    // SAME way, else the real `<name>-type.ts` file is wrongly pruned as an orphan
    // on a re-sync — and lint (rune-typ-shape) then demands the file just deleted.
    const dtoNamesSameDir = ast.dtos
      .filter((d) => !!d.isCore === !!typ.isCore)
      .map((d) => d.name);
    const name = typFileName(typ.name, dtoNamesSameDir, dtoBinding);
    const scope = typ.isCore ? "core" : module;
    files.add(`src/${scope}/dto/${name}.ts`);
  }
  for (const ent of ast.ents) {
    dirs.add(`src/${module}/entrypoints/${applyCase(ent.surface, "kebab")}`);
  }

  return { dirs, files };
}

function walkSteps(
  steps: StepLike[] | CseNode["steps"],
  module: string,
  dirs: Set<string>,
): void {
  for (const step of steps) {
    if (step.kind === "step") {
      dirs.add(
        `src/${module}/domain/business/${applyCase(step.noun, "kebab")}`,
      );
    } else if (step.kind === "boundary") {
      dirs.add(`src/${module}/domain/data/${applyCase(step.noun, "kebab")}`);
    } else if (step.kind === "ply") {
      const featureDir = `src/${module}/domain/business/${
        applyCase(step.noun, "kebab")
      }`;
      dirs.add(featureDir);
      for (const cse of step.cases) {
        // Predict each DECLARED variant folder so only a REMOVED [CSE] arm's
        // implementations/<case>/ becomes an orphan (classify keys these at the
        // case-folder level rather than collapsing them to the feature dir).
        dirs.add(
          `${featureDir}/implementations/${applyCase(cse.name, "kebab")}`,
        );
        walkSteps(cse.steps, module, dirs);
      }
    }
  }
}

// ---- classify an existing path into a prunable rune slot ----

type SlotCategory = "business" | "data" | "coordinators" | "entrypoints";
type Slot = { kind: "dir"; dir: string; category: SlotCategory } | {
  kind: "file";
};

function classify(path: string, module: string): Slot | null {
  const prefix = `src/${module}/`;
  if (!path.startsWith(prefix)) return null;
  const parts = path.split("/"); // ["src", module, ...]

  // src/<module>/domain/business/<noun>/implementations/<case>/... — a [PLY] variant folder.
  // Keyed at the case-folder level (not collapsed to the feature dir) so a removed [CSE] arm is
  // an orphan even though its parent [PLY] feature dir is still predicted. Must precede the
  // general business branch below.
  if (
    parts[2] === "domain" && parts[3] === "business" &&
    parts[5] === "implementations" && parts.length >= 7
  ) {
    return {
      kind: "dir",
      dir: parts.slice(0, 7).join("/"),
      category: "business",
    };
  }
  // src/<module>/domain/(business|data|coordinators)/<feature>/...
  if (
    parts[2] === "domain" &&
    (parts[3] === "business" || parts[3] === "data" ||
      parts[3] === "coordinators") &&
    parts.length >= 6
  ) {
    return {
      kind: "dir",
      dir: parts.slice(0, 5).join("/"),
      category: parts[3] as SlotCategory,
    };
  }
  // src/<module>/entrypoints/<surface>/...
  if (parts[2] === "entrypoints" && parts.length >= 5) {
    return {
      kind: "dir",
      dir: parts.slice(0, 4).join("/"),
      category: "entrypoints",
    };
  }
  // src/<module>/dto/<name>.ts
  if (parts[2] === "dto" && parts.length === 4 && path.endsWith(".ts")) {
    return { kind: "file" };
  }
  return null;
}

// ---- honest ownership (the prune gate) ---------------------------------------

/** Whether file content PROVABLY came out of rune's generators: every file rune
 * emits opens with a `// Generated by rune …` banner (rune-sig and the
 * rune-manifest templates say "Generated by rune manifest", the bootstrap
 * registry "Generated by rune sync"). The prune pass uses this as the honest
 * ownership test — a file sitting in a rune-owned slot whose header carries no
 * such marker (e.g. `// Hand-authored (not rune-generated)`) is FOREIGN: sync
 * cannot prove it generated it, so it must never delete it (infra 2026-09-03:
 * hand-authored dto/ship.ts et al, still imported by dev-owned coordinators,
 * were destroyed as "orphans"). Only the head is scanned: the banner is always
 * the first line, and quoting the phrase deep inside a hand-written file must
 * not hand rune ownership of it. */
export function isRuneGenerated(content: string): boolean {
  return content
    .split("\n", 5)
    .some((line) => /^\/\/.*Generated by rune\b/.test(line));
}

// ---- create-once growth (incremental sync) -----------------------------------
//
// When a spec GROWS an existing module, the plan's toSkip entries carry the
// freshly generated content for create-once files that already exist. Before
// this pass, sync preserved them silently — generating coordinators that CALL
// adapter methods, DTO fields, and @Endpoint bindings it then refused to write
// (the tree failed `deno check`, and the missing @Endpoint bindings were
// invisible even to that). Growth restores the red-by-design contract on the
// incremental path: a missing member is APPENDED to the create-once file as the
// generator would have emitted it (a throwing stub method, a spec-exact DTO
// field, an @Endpoint delegator) — append-only, existing members are never
// touched. When the file has drifted so far the class can't be located, the
// member list is reported as hand-work owed instead (never a corrupt write).

/** One appendable member extracted from freshly generated content. */
interface ClassUnit {
  name: string;
  /** The member's full text: leading JSDoc/comments/decorators + the member. */
  text: string;
}

export interface GrowthResult {
  /** The merged content: existing + missing imports + missing members. */
  content: string;
  /** Human-readable additions, e.g. "method roleDefined", "field roles". */
  added: string[];
}

/** Paths whose create-once files can grow additively. Test files, coordinators
 * (whole-body semantics), [TYP] aliases, and core service clients are excluded. */
function growKind(
  path: string,
): "adapter" | "business" | "entrypoint" | "dto" | null {
  if (/^src\/[^/]+\/domain\/data\/[^/]+\/mod\.ts$/.test(path)) return "adapter";
  if (/^src\/[^/]+\/domain\/business\/[^/]+\/mod\.ts$/.test(path)) {
    return "business";
  }
  if (/^src\/[^/]+\/entrypoints\/[^/]+\/mod\.ts$/.test(path)) {
    return "entrypoint";
  }
  if (/^src\/[^/]+\/dto\/[^/]+\.ts$/.test(path)) return "dto";
  return null;
}

const METHOD_HEAD = /^ {2}(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/;
const FIELD_HEAD =
  /^ {2}(?:static\s+)?(?:readonly\s+)?([A-Za-z_$][\w$]*)[?!]?\s*[:=]/;
const LEAD_LINE = /^ {2,}(\/\/|\/\*\*|\*|\*\/|@)/;

/** Parse FRESH generated content into its class name + member units. The fresh
 * side is generator-owned, so its shapes are stable: 2-space members, JSDoc/
 * comment/decorator leads contiguous with their member, blank lines only
 * between units. Returns null when the file holds no class (e.g. a [TYP]). */
function parseFreshClass(
  content: string,
): { className: string; units: ClassUnit[] } | null {
  const lines = content.split("\n");
  const declIdx = lines.findIndex((l) =>
    /^export (?:default )?class \w+/.test(l)
  );
  if (declIdx === -1) return null;
  const className = lines[declIdx].match(/class (\w+)/)![1];
  const units: ClassUnit[] = [];
  let pending: string[] = [];
  for (let i = declIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "}") break; // class close (generated: column 0)
    if (line.trim() === "") {
      pending = [];
      continue;
    }
    if (LEAD_LINE.test(line)) {
      pending.push(line);
      continue;
    }
    const head = METHOD_HEAD.exec(line);
    if (head) {
      const unit = [...pending, line];
      pending = [];
      // A single-line member (`constructor(...) {}`) closes on its own line;
      // a block member collects through its 2-space closing brace.
      if (!/\{\s*\}\s*$/.test(line) && !/;\s*$/.test(line)) {
        for (i++; i < lines.length; i++) {
          unit.push(lines[i]);
          if (lines[i] === "  }") break;
        }
      }
      units.push({ name: head[1], text: unit.join("\n") });
      continue;
    }
    const field = FIELD_HEAD.exec(line);
    if (field) {
      units.push({ name: field[1], text: [...pending, line].join("\n") });
      pending = [];
      continue;
    }
    pending = []; // unrecognized line — never attach stale leads to a later unit
  }
  return { className, units };
}

/** Property names a constructor's parameter properties bind
 * (`private readonly firebase = new FirebaseService()` → "firebase"). */
function ctorProps(text: string): string[] {
  return [
    ...text.matchAll(
      /(?:private|protected|public)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)/g,
    ),
  ].map((m) => m[1]);
}

/** Whether any OTHER missing unit references a property the constructor binds
 * (`this.<prop>`) — the only case where appending the constructor is appending
 * something the new spec-driven members actually need. */
function ctorNeededBy(ctor: ClassUnit, missing: ClassUnit[]): boolean {
  return ctorProps(ctor.text).some((p) => {
    const re = new RegExp(`\\bthis\\.${p.replace(/\$/g, "\\$")}\\b`);
    return missing.some((o) => o !== ctor && re.test(o.text));
  });
}

/** Whether EXISTING (hand-owned) content already declares a class member named
 * `name` — method, field, or assigned property; any of these means the symbol
 * exists and appending would collide. */
function hasMember(existing: string, name: string): boolean {
  const re = new RegExp(
    `(^|\\n)\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?(?:readonly\\s+)?(?:async\\s+)?(?:override\\s+)?${name}\\s*[(<:=!?]`,
  );
  return re.test(existing);
}

/** The index of the closing brace of `class <className>` in hand-owned content,
 * found with a string/comment-aware scanner (template `${}` nesting included).
 * The close must sit at the start of a line — a mid-line match means the scan
 * was thrown off (e.g. a brace inside a regex literal) and the caller must fall
 * back to reporting instead of writing. */
function findClassClose(text: string, className: string): number | null {
  const decl = new RegExp(`\\bclass\\s+${className}\\b`).exec(text);
  if (!decl) return null;
  const open = text.indexOf("{", decl.index);
  if (open === -1) return null;
  type Mode = "code" | "line" | "block" | "s1" | "s2" | "tpl";
  const stack: Mode[] = ["code"];
  const braces: number[] = [0]; // per-code-frame brace depth
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    const mode = stack[stack.length - 1];
    if (mode === "line") {
      if (c === "\n") stack.pop();
    } else if (mode === "block") {
      if (c === "*" && n === "/") {
        stack.pop();
        i++;
      }
    } else if (mode === "s1" || mode === "s2") {
      if (c === "\\") i++;
      else if ((mode === "s1" && c === "'") || (mode === "s2" && c === '"')) {
        stack.pop();
      }
    } else if (mode === "tpl") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && n === "{") {
        stack.push("code");
        braces.push(0);
        i++;
      }
    } else {
      // code
      if (c === "/" && n === "/") {
        stack.push("line");
        i++;
      } else if (c === "/" && n === "*") {
        stack.push("block");
        i++;
      } else if (c === "'") stack.push("s1");
      else if (c === '"') stack.push("s2");
      else if (c === "`") stack.push("tpl");
      else if (c === "{") braces[braces.length - 1]++;
      else if (c === "}") {
        const d = braces.length - 1;
        if (braces[d] === 0 && d > 0) {
          // closes a template interpolation
          stack.pop();
          braces.pop();
        } else {
          braces[d]--;
          if (d === 0 && braces[0] === 0) {
            // the class's own close — only trust it at a line start
            const lineStart = text.lastIndexOf("\n", i) + 1;
            return /^\s*$/.test(text.slice(lineStart, i)) ? i : null;
          }
        }
      }
    }
  }
  return null;
}

/** Missing import lines for the appended members: any fresh import binding that
 * the appended unit text actually REFERENCES and the (original) existing file
 * doesn't already bind. Appended as NEW lines after the existing import block —
 * existing lines are never edited (a second `import { X } from "spec"` is
 * valid TS, and never risks corrupting a hand-formatted import). */
function missingImportLines(
  existing: string,
  fresh: string,
  appended: string,
): string[] {
  const wordIn = (text: string, name: string): boolean =>
    new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(text);
  const out: string[] = [];
  for (const line of fresh.split("\n")) {
    const named =
      /^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']+["'];?\s*$/.exec(
        line,
      );
    if (named) {
      const names = named[1].split(",").map((s) => s.trim()).filter(Boolean);
      const missing = names.filter((n) => {
        // the binding (or its alias target) must be used by the appended
        // members and not already bound/used in the original file.
        const bound = n.includes(" as ") ? n.split(" as ").pop()!.trim() : n;
        return wordIn(appended, bound) && !wordIn(existing, bound);
      });
      if (missing.length > 0) {
        out.push(line.replace(/\{[^}]*\}/, `{ ${missing.join(", ")} }`));
      }
      continue;
    }
    const side = /^import\s+["']([^"']+)["'];?\s*$/.exec(line);
    if (
      side && !existing.includes(`"${side[1]}"`) &&
      !existing.includes(`'${side[1]}'`)
    ) {
      out.push(line);
    }
  }
  return out;
}

/** The line index AFTER the existing import block (multiline imports included),
 * where new import lines are inserted. Falls back to after the leading comment
 * header when the file has no imports. */
function importInsertLine(lines: string[]): number {
  let last = -1;
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (open) {
      last = i;
      if (l.includes(";")) open = false;
      continue;
    }
    if (/^import[\s"']/.test(l)) {
      last = i;
      if (!/;\s*$/.test(l) && !l.includes(";")) open = true;
    }
  }
  if (last !== -1) return last + 1;
  // no imports: after the leading comment/blank header block
  let i = 0;
  while (
    i < lines.length && (lines[i].startsWith("//") || lines[i].trim() === "")
  ) i++;
  return i;
}

/** Plan the additive growth of one preserved create-once file. Returns null
 * when the path isn't growable or nothing is missing; `{ owed }` when members
 * are missing but the existing class can't be safely located; `{ grown }` with
 * the merged content otherwise. */
export function planCreateOnceGrowth(
  path: string,
  existing: string,
  fresh: string,
): { grown: GrowthResult } | { owed: string[] } | null {
  const kind = growKind(path);
  if (kind === null) return null;
  const parsed = parseFreshClass(fresh);
  if (!parsed) return null;
  const rawMissing = parsed.units.filter((u) => !hasMember(existing, u.name));
  // Growth appends the new SPEC-DRIVEN members only (methods, fields,
  // @Endpoint delegators). A constructor is inferred infrastructure — the
  // default service wiring the generator hands a FRESH scaffold — never a spec
  // member: retrofitting one onto a preserved file couples untouched hand-owned
  // code to a service client nothing appended references, and its zero-arg
  // `new XService()` default may not even compile against the service's real
  // constructor (infra 2026-09-03: the create-once Claims adapter gained a
  // FirebaseService param no method used — FirebaseService requires a mandatory
  // arg, so the append broke `deno check` project-wide). It rides along ONLY
  // when a newly appended member actually references a property it binds; its
  // unused import then also stays out (missingImportLines keys on references).
  const missing = rawMissing.filter((u) =>
    u.name !== "constructor" || ctorNeededBy(u, rawMissing)
  );
  if (missing.length === 0) return null;

  const word = kind === "dto"
    ? "field"
    : kind === "entrypoint"
    ? "@Endpoint"
    : "method";
  const describe = (u: ClassUnit): string =>
    u.name === "constructor" ? "constructor" : `${word} ${u.name}`;

  const close = findClassClose(existing, parsed.className);
  if (close === null) return { owed: missing.map(describe) };

  // Compose: existing up to the class close, a blank line, the missing units
  // (blank-line separated, matching generated spacing), then the close.
  const before = existing.slice(0, close).replace(/[ \t]*$/, "");
  const after = existing.slice(existing.lastIndexOf("\n", close) + 1);
  const body = missing.map((u) => u.text).join("\n\n");
  let content = `${before.replace(/\n*$/, "")}\n\n${body}\n${after}`;

  const imports = missingImportLines(existing, fresh, body);
  if (imports.length > 0) {
    const lines = content.split("\n");
    lines.splice(importInsertLine(lines), 0, ...imports);
    content = lines.join("\n");
  }
  return {
    grown: {
      content,
      added: [
        ...missing.map(describe),
        ...(imports.length ? [`${imports.length} import(s)`] : []),
      ],
    },
  };
}

// ---- poly-mod barrel staleness (the sync entrypoint reads the file + does the I/O) ----

/** The variant a generated poly-mod barrel re-exports, e.g.
 * `export { default } from "./implementations/wyn/mod.ts";` → "wyn". Returns null when
 * the barrel has been hand-rewritten into a shape we can't statically read (a runtime
 * switch, several re-exports) — the caller then skips it rather than warn falsely. */
export function parseBarrelTarget(barrelContent: string): string | null {
  // Strip comments first so a dev who rewrote the barrel into a runtime switch but kept the old
  // generated line as a comment doesn't get the commented-out path read as the live re-export
  // (which would fire a false staleness warning). No `//` appears in the re-export path itself.
  const live = barrelContent
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const m = live.match(
    /from\s+["']\.\/implementations\/([A-Za-z0-9_-]+)\/mod\.ts["']/,
  );
  return m ? m[1] : null;
}

/** The warning when a create-once poly-mod barrel points at a variant the spec no
 * longer declares, OR whose folder is gone (e.g. a --force prune just removed the
 * arm). `variantExists` is the caller's on-disk check. null when the barrel is fine.
 * The barrel is dev-owned/create-once, so sync never rewrites it — it tells the dev to
 * repoint it (same posture as the stale heal-rules note). */
export function polyBarrelNote(
  dir: string,
  target: string,
  declaredCases: Set<string>,
  variantExists: boolean,
): string | null {
  if (!variantExists) {
    return `${dir}/poly-mod.ts re-exports ./implementations/${target}/mod.ts which no longer exists ` +
      `— repoint the barrel by hand to a current variant`;
  }
  if (!declaredCases.has(target)) {
    return `${dir}/poly-mod.ts re-exports ./implementations/${target} which no [CSE] declares ` +
      `— repoint the barrel by hand`;
  }
  return null;
}
