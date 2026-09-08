/**
 * Generates canonical-shape.md from the layout in the keywords.json artifact
 * (keywords.json → canonicalPaths — the single source of truth).
 * Run: deno run --allow-read --allow-write scripts/gen-shape-docs.ts
 */

const SPEC_PATH = "lang/keywords.json";
const OUT_PATH = Deno.args[0] ?? "docs/canonical-shape.md";

type Node = Record<string, unknown>;
type FileSpec = { ext?: string[]; desc?: string; optional?: boolean };

function isObj(v: unknown): v is Node {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFileSpec(v: unknown): v is FileSpec {
  if (typeof v === "string") return true;
  if (!isObj(v)) return false;
  return "ext" in v || "desc" in v;
}

function isFolderKey(k: string): boolean {
  return k.endsWith("/");
}

function dirName(k: string): string {
  return k.endsWith("/") ? k.slice(0, -1) : k;
}

function renderTree(node: Node, prefix: string, isLast: boolean[]): string[] {
  const lines: string[] = [];
  const entries = Object.entries(node).filter(([k]) => !k.startsWith("$"));

  entries.forEach(([k, v], i) => {
    const last = i === entries.length - 1;
    const connector = last ? "└── " : "├── ";
    const indent = isLast.map((l) => l ? "    " : "│   ").join("");

    if (isFolderKey(k)) {
      const name = dirName(k);
      const desc = isObj(v) ? (v as Node)["$desc"] as string ?? "" : "";
      const descSuffix = desc ? `  # ${desc}` : "";

      if (Array.isArray(v)) {
        // Variant
        lines.push(`${indent}${connector}${name}/${descSuffix}`);
        v.forEach((variant, vi) => {
          if (!isObj(variant)) return;
          const vLast = vi === v.length - 1;
          const vIndent = indent + (last ? "    " : "│   ");
          const vConn = vLast ? "└── " : "├── ";
          lines.push(`${vIndent}${vConn}# variant ${vi + 1}`);
          lines.push(
            ...renderTree(variant as Node, "", [...isLast, last, vLast]),
          );
        });
      } else if (isObj(v)) {
        lines.push(`${indent}${connector}${name}/${descSuffix}`);
        lines.push(...renderTree(v as Node, "", [...isLast, last]));
      }
    } else if (isFileSpec(v)) {
      const spec = typeof v === "string" ? { desc: v } : v as FileSpec;
      const ext = spec.ext?.length ? spec.ext.join("|") : ".*";
      const opt = spec.optional ? " (optional)" : "";
      const desc = spec.desc ? `  # ${spec.desc}` : "";
      lines.push(`${indent}${connector}${k}${ext}${opt}${desc}`);
    }
  });

  return lines;
}

const spec =
  (JSON.parse(await Deno.readTextFile(SPEC_PATH)) as { canonicalPaths: Node })
    .canonicalPaths;

const forbiddenDirs = spec["$forbiddenDirNames"] as string[] ?? [];
const looseNames = spec["$looseFileNames"] as string[] ?? [];
const rootFiles = spec["$rootFiles"] as string[] ?? [];

const topEntries = Object.entries(spec).filter(([k]) => !k.startsWith("$"));

const tree = topEntries.flatMap(([k, v]) => {
  if (isFolderKey(k)) {
    const name = dirName(k);
    const desc = isObj(v) ? (v as Node)["$desc"] as string ?? "" : "";
    const descSuffix = desc ? `  # ${desc}` : "";
    if (Array.isArray(v)) {
      const lines = [`${name}/${descSuffix}`];
      v.forEach((variant, vi) => {
        if (!isObj(variant)) return;
        lines.push(`    # variant ${vi + 1}`);
        lines.push(
          ...renderTree(variant as Node, "", [true]).map((l) => "    " + l),
        );
      });
      return lines;
    }
    if (isObj(v)) {
      return [`${name}/${descSuffix}`, ...renderTree(v as Node, "", [true])];
    }
  } else if (isFileSpec(v)) {
    const spec2 = typeof v === "string" ? { desc: v } : v as FileSpec;
    const ext = spec2.ext?.length ? spec2.ext.join("|") : ".*";
    const desc = spec2.desc ? `  # ${spec2.desc}` : "";
    return [`${k}${ext}${desc}`];
  }
  return [];
});

const md = `# Canonical Project Shape

> **Auto-generated** from \`canonical-paths.json\`. Do not edit manually.

## Rules

- **Allowed root files** (by stem): ${
  rootFiles.map((f) => `\`${f}\``).join(", ")
}
- **Forbidden directory names** (anywhere): ${
  forbiddenDirs.map((f) => `\`${f}\``).join(", ")
}
- **Loose file names** (flagged anywhere): ${
  looseNames.map((f) => `\`${f}\``).join(", ")
}

## Where this sits in a composed repo

A rune-generated keep backend is the \`server/\` package of a composed monorepo:

\`\`\`
<git-root>/
  deno.json     # Deno workspace ["./ui","./server"]
  serve.ts      # Bedrock({ ui: Frontend(), backend: api }) — the composition root
  ui/           # the sprig UI package (ui/src/, ui/static/)
  server/       # <- THE CODEGEN ROOT: the tree below is rooted HERE
  spec/         # shared authoring (spec/runes/, spec/misc/, spec/ui/) at the git root
\`\`\`

The structure below is **relative to the \`server/\` codegen root** — i.e. \`src/<module>/\`
below is \`<git-root>/server/src/<module>/\` on disk, and \`bootstrap/\` is
\`<git-root>/server/bootstrap/\`. \`rune sync\`/\`rune dev\`/\`rune lint\` all resolve this
\`server/\` root from the spec path (or descend into it from the git root), so the
codegen-root-relative rules below hold unchanged.

## Structure

\`\`\`
${tree.join("\n")}
\`\`\`

## Key Conventions

- \`/\` suffix in spec keys = folder
- File objects with \`ext\` = enforced extensions, \`optional: true\` = not required
- \`<name>\` = wildcard, matches any name
- \`mod.ts\` — main module file
- \`mod-root.ts\` — module's public API (only external import surface)
- \`poly-mod.ts\` — polymorphic barrel export
- \`test.ts\` — unit tests (co-located)
- \`int.test.ts\` — integration tests (coordinators)
- \`smk.test.ts\` — smoke tests (data layer)
- \`e2e.test.ts\` — end-to-end tests (entrypoints)
- \`./\` imports for same-directory, \`@\` aliases for cross-directory
- \`#\` aliases for external packages (npm/jsr)
`;

await Deno.writeTextFile(OUT_PATH, md);
console.log(`Generated ${OUT_PATH}`);
