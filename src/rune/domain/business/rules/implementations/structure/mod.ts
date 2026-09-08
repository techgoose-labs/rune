import { canonicalPaths as SHAPE } from "@rune/domain/business/artifact/canonical-paths.ts";
import type { EntryTarget, PipelineContext } from "@/core/dto/types.ts";

const FORBIDDEN_DIRS = new Set(
  (SHAPE as Record<string, unknown>)["$forbiddenDirNames"] as string[],
);
const LOOSE_NAMES =
  (SHAPE as Record<string, unknown>)["$looseFileNames"] as string[];

/** Split a name into its word tokens across camelCase, kebab- and snake_case
 * boundaries (e.g. `myUtils` → [my, utils], `my-utils` → [my, utils],
 * `commonHelper` → [common, helper]). Used so the loose-name guard matches a
 * WHOLE word token, not a bare substring — `utilization`/`commonwealth`/
 * `futility` embed a loose word but are not made of it, so they pass. */
function wordTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

function containsLooseName(name: string): string | null {
  const lower = name.toLowerCase();
  const tokens = new Set(wordTokens(name));
  for (const loose of LOOSE_NAMES) {
    // Whole-name match (`utils`) or whole-token match (`my-utils`, `commonHelper`).
    if (lower === loose || tokens.has(loose)) return loose;
  }
  return null;
}
const ROOT_FILES = new Set(
  ((SHAPE as Record<string, unknown>)["$rootFiles"] as string[]) ?? [],
);

type ShapeNode = Record<string, unknown>;
type FileSpec = { ext?: string[]; desc?: string; optional?: boolean };

function isNodeLike(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A file value is either a string or an object with ext/desc/optional */
function isFileValue(v: unknown): boolean {
  if (typeof v === "string") return true;
  if (!isNodeLike(v)) return false;
  const obj = v as Record<string, unknown>;
  return "ext" in obj || "desc" in obj;
}

function toFileSpec(v: unknown): FileSpec {
  if (typeof v === "string") return { desc: v };
  return v as FileSpec;
}

/** Key ends with / → folder */
function isFolderKey(k: string): boolean {
  return k.endsWith("/");
}

/** Strip / suffix to get dir name */
function dirName(k: string): string {
  return k.endsWith("/") ? k.slice(0, -1) : k;
}

/** Is this a variant array (array of objects)? */
function isVariantArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && isNodeLike(v[0]);
}

/** Is this key+value a navigable child folder? */
function isChildNode(k: string, v: unknown): boolean {
  if (k.startsWith("$")) return false;
  if (isFolderKey(k)) return isNodeLike(v) || isVariantArray(v);
  return false;
}

function resolveArrayVariant(
  variants: unknown[],
  dirPath: string,
  ctx: PipelineContext,
): ShapeNode | null {
  for (const variant of variants) {
    if (!isNodeLike(variant)) continue;
    const node = variant as ShapeNode;

    const fixedKeys = Object.entries(node).filter(
      ([k]) => !k.startsWith("$") && !k.startsWith("<"),
    );

    const allMatch = fixedKeys.every(([k, v]) => {
      if (isChildNode(k, v)) {
        return ctx.dirs.includes(dirPath + "/" + dirName(k));
      }
      // Skip optional files — they don't need to exist for variant matching
      if (isFileValue(v)) {
        const spec = toFileSpec(v);
        if (spec.optional) return true;
      }
      // File key — check if a matching file exists by baseName
      return ctx.files.some(
        (f) =>
          f.startsWith(dirPath + "/") &&
          f.split("/").length === dirPath.split("/").length + 1 &&
          f.split("/").pop()?.replace(/\.[^.]+$/, "") === k,
      );
    });

    if (allMatch) return node;
  }
  return null;
}

export function resolveNode(
  segments: string[],
  ctx?: PipelineContext,
): ShapeNode | null {
  let current: unknown = SHAPE;
  const pathSoFar: string[] = [];

  for (const seg of segments) {
    if (!isNodeLike(current)) return null;
    const node = current as ShapeNode;

    // Find a fixed folder key matching this segment
    const folderKey = Object.keys(node).find((k) => {
      if (!isFolderKey(k)) return false;
      const name = dirName(k);
      if (name.startsWith("<") && name.endsWith(">")) return false;
      return name === seg;
    });

    if (folderKey) {
      current = node[folderKey];
      if (isVariantArray(current)) {
        if (!ctx) return null;
        current = resolveArrayVariant(
          current as unknown[],
          [...pathSoFar, seg].join("/"),
          ctx,
        );
        if (!current) return null;
      }
      pathSoFar.push(seg);
      continue;
    }

    // Try descriptor folder key
    const descriptorKey = Object.keys(node).find((k) => {
      if (!isFolderKey(k)) return false;
      const name = dirName(k);
      return name.startsWith("<") && name.endsWith(">");
    });

    if (descriptorKey) {
      current = node[descriptorKey];
      if (isVariantArray(current)) {
        if (!ctx) return null;
        current = resolveArrayVariant(
          current as unknown[],
          [...pathSoFar, seg].join("/"),
          ctx,
        );
        if (!current) return null;
      }
      pathSoFar.push(seg);
      continue;
    }

    return null;
  }
  return isNodeLike(current) ? (current as ShapeNode) : null;
}

export function getRequiredFiles(node: ShapeNode): string[] {
  return Object.keys(node).filter((k) => {
    if (k.startsWith("$") || k.startsWith("<") || isFolderKey(k)) return false;
    const v = node[k];
    if (!isFileValue(v)) return false;
    const spec = toFileSpec(v);
    return !spec.optional;
  });
}

export function getExpectedAt(node: ShapeNode): {
  desc: string;
  folders: string[];
  files: { name: string; desc: string }[];
  descriptor: string | null;
} {
  const desc = (node["$desc"] as string) ?? "";
  const folders: string[] = [];
  const files: { name: string; desc: string }[] = [];
  let descriptor: string | null = null;

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("$")) continue;
    if (k.startsWith("<") && (k.endsWith(">") || k.endsWith(">/"))) {
      descriptor = k;
      continue;
    }
    if (isFolderKey(k)) {
      folders.push(dirName(k));
    } else if (isFileValue(v)) {
      const spec = toFileSpec(v);
      files.push({ name: k, desc: spec.desc ?? "" });
    }
  }

  return { desc, folders, files, descriptor };
}

/** Render the expected structure of a node as a readable string for diagnostics */
function formatExpected(node: ShapeNode): string {
  const parts: string[] = [];

  if (node["$desc"]) parts.push(`  ${node["$desc"]}`);

  const folders: string[] = [];
  const files: string[] = [];

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("$")) continue;
    if (isFolderKey(k)) {
      const name = dirName(k);
      const child = isNodeLike(v) ? v as ShapeNode : null;
      const childDesc = child?.["$desc"] as string ?? "";
      folders.push(`  ${name}/${childDesc ? "  " + childDesc : ""}`);
    } else if (isFileValue(v)) {
      const spec = toFileSpec(v);
      const ext = spec.ext?.length ? spec.ext.join("|") : ".*";
      const opt = spec.optional ? " (optional)" : "";
      const desc = spec.desc ? ` — ${spec.desc}` : "";
      files.push(`  ${k}${ext}${opt}${desc}`);
    }
  }

  if (folders.length) {
    parts.push("  Folders: " + folders.map((f) => f.trim()).join(", "));
  }
  if (files.length) parts.push(...files);

  return parts.length > 0 ? "\n\nExpected structure:\n" + parts.join("\n") : "";
}

/** Render expected structure for the parent of a path */
function expectedHint(parentNode: ShapeNode | null): string {
  if (!parentNode) return "";
  return formatExpected(parentNode);
}

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  const segments = path.split("/");
  const name = segments[segments.length - 1];

  if (target === "folder") {
    // Check if ANY ancestor has $ignore: "*"
    for (let i = segments.length - 1; i >= 1; i--) {
      const ancestorSegs = segments.slice(0, i);
      const ancestorNode = resolveNode(ancestorSegs, ctx);
      if (ancestorNode && ancestorNode["$ignore"] === "*") return null;
    }

    const node = resolveNode(segments, ctx);
    const violations: string[] = [];

    if (node === null) {
      const parentSegs = segments.slice(0, -1);
      const parentNode = parentSegs.length > 0
        ? resolveNode(parentSegs, ctx)
        : null;
      violations.push(
        `This folder is not allowed by the project structure spec${
          expectedHint(parentNode)
        }`,
      );
    }
    if (FORBIDDEN_DIRS.has(name)) {
      violations.push(
        `"${name}" is a forbidden directory name — use a more specific name`,
      );
    }
    if (name === "core" && path !== "src/core") {
      violations.push('Only src/core can be named "core" — rename this folder');
    }
    const looseFolderMatch = containsLooseName(name);
    if (looseFolderMatch) {
      violations.push(
        `"${name}" contains loose/vague word "${looseFolderMatch}" — use a more specific name`,
      );
    }

    if (node !== null) {
      const required = getRequiredFiles(node);
      for (const baseName of required) {
        const found = ctx.files.some(
          (f) =>
            f.startsWith(path + "/") &&
            // Direct child only — a required file must sit IN this folder, not in
            // some grandchild that happens to share the basename (mirrors the
            // variant matcher's depth guard at line 88). Without this, e.g. a
            // `mod.ts` two levels down satisfies a required `mod` here.
            f.split("/").length === path.split("/").length + 1 &&
            f.split("/").pop()?.replace(/\.[^.]+$/, "") === baseName,
        );
        if (!found) {
          const v = node[baseName];
          const spec = isFileValue(v) ? toFileSpec(v) : null;
          const desc = spec?.desc ? ` — ${spec.desc}` : "";
          const ext = spec?.ext?.length ? ` (${spec.ext.join("|")})` : "";
          violations.push(`Missing required file "${baseName}"${ext}${desc}`);
        }
      }
    }

    return violations.length > 0 ? violations : null;
  }

  // ── file checks ──

  const baseName = name.replace(/\.[^.]+$/, "");
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  // Root-level files
  if (segments.length === 1) {
    if (ROOT_FILES.has(baseName) || ROOT_FILES.has(name)) return null;
    return ["This file is not allowed at the project root"];
  }

  // Check if ANY ancestor has $ignore: "*"
  for (let i = segments.length - 1; i >= 1; i--) {
    const ancestorSegs = segments.slice(0, i);
    const ancestorNode = resolveNode(ancestorSegs, ctx);
    if (ancestorNode && ancestorNode["$ignore"] === "*") return null;
  }

  const parentSegs = segments.slice(0, -1);
  const parentNode = resolveNode(parentSegs, ctx);
  if (parentNode === null) {
    return [
      `This file is not allowed here — parent folder is not in the spec${
        expectedHint(null)
      }`,
    ];
  }

  const looseFileMatch = containsLooseName(baseName);
  if (looseFileMatch) {
    return [
      `"${baseName}" contains loose/vague word "${looseFileMatch}" — use a more specific name`,
    ];
  }

  // Co-located private helpers: a leading-underscore file (e.g. `_dispatch.ts`,
  // `_leaf.ts`) is an intentional internal split of the folder it lives in — the
  // opposite of a vague junk drawer (those are caught by the loose-name check
  // above). Allowed in any recognized folder so non-trivial [PLY] dispatchers and
  // other hand-authored decompositions don't trip the structure rule. The parent
  // folder must still itself be in the spec (checked above via parentNode).
  if (baseName.startsWith("_")) return null;

  // Try fixed file keys
  for (const [k, v] of Object.entries(parentNode)) {
    if (k.startsWith("$") || isFolderKey(k)) continue;
    if (!isFileValue(v)) continue;
    if (k === baseName) {
      const spec = toFileSpec(v);
      if (spec.ext && spec.ext.length > 0 && !spec.ext.includes(ext)) {
        return [
          `Wrong extension "${ext}" — expected ${spec.ext.join(" or ")} (${
            spec.desc ?? k
          })`,
        ];
      }
      return null;
    }
  }

  // Try descriptor file keys
  for (const [k, v] of Object.entries(parentNode)) {
    if (k.startsWith("$") || isFolderKey(k)) continue;
    if (!isFileValue(v)) continue;
    if (k.startsWith("<") && k.endsWith(">")) {
      const spec = toFileSpec(v);
      if (spec.ext && spec.ext.length > 0 && !spec.ext.includes(ext)) {
        return [
          `Wrong extension "${ext}" — expected ${spec.ext.join(" or ")} (${
            spec.desc ?? k
          })`,
        ];
      }
      return null;
    }
  }

  return [`This file is not allowed here${expectedHint(parentNode)}`];
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor. The project follows a hexagonal/modular architecture defined in a canonical-paths.json spec. Given structural violations for a file or folder, produce a concise, actionable fix suggestion (2-3 sentences max). Reference the spec's expected structure when relevant.`;

export function buildPrompt(
  violations: string[],
  path: string,
  target: EntryTarget,
): string {
  return `Path: ${path} (${target})
Violations: ${JSON.stringify(violations)}

Parent expected structure: ${
    JSON.stringify(
      (() => {
        const parentSegs = path.split("/").slice(0, -1);
        const parentNode = resolveNode(parentSegs);
        return parentNode ? getExpectedAt(parentNode) : "unknown parent";
      })(),
    )
  }

What should the developer do to fix these violations?`;
}
