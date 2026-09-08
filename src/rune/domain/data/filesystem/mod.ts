import { dirname, join, normalize } from "#std/path";
import type { PipelineContext } from "@core/dto/types.ts";

const SKIP = new Set([".git", "node_modules"]);

async function walkDir(
  root: string,
  prefix: string,
  files: string[],
  dirs: string[],
  ignored: Set<string>,
): Promise<void> {
  const base = prefix ? join(root, prefix) : root;
  for await (const entry of Deno.readDir(base)) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (ignored.has(rel)) continue;
    if (entry.isDirectory) {
      dirs.push(rel);
      await walkDir(root, rel, files, dirs, ignored);
    } else if (entry.isFile) {
      files.push(rel);
    }
  }
}

export async function buildContext(
  targetDir: string,
  ignored: Set<string>,
): Promise<PipelineContext> {
  const files: string[] = [];
  const dirs: string[] = [];
  await walkDir(targetDir, "", files, dirs, ignored);

  const contentCache = new Map<string, string>();

  async function getFileContent(rel: string): Promise<string> {
    if (contentCache.has(rel)) return contentCache.get(rel)!;
    const text = await Deno.readTextFile(join(targetDir, rel));
    contentCache.set(rel, text);
    return text;
  }

  const importRe =
    /(?:import|export)\s+.*?\s+from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

  async function getImports(rel: string): Promise<string[]> {
    const content = await getFileContent(rel);
    const specifiers: string[] = [];
    for (const m of content.matchAll(importRe)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith(".")) {
        specifiers.push(normalize(join(dirname(rel), spec)));
      } else {
        specifiers.push(spec);
      }
    }
    return specifiers;
  }

  return { targetDir, files, dirs, getFileContent, getImports, lsp: null };
}
