// Corpus parity (REQ-014): the corpus is the executable spec of the checker.
//
// Every `fixtures/corpus/valid/*.rune` must check clean; every
// `fixtures/corpus/invalid/<name>.rune` must produce EXACTLY the findings its
// sidecar `<name>.diag.json` lists (`[{ id, line }]`). Any tool that claims to
// implement the checker — the engine, the LSP through `rune check --json`, the
// studio — is held to the same lists, so "which error" is pinned, not only
// "whether an error".

import { join } from "#std/path";
import { planManifest } from "@rune/domain/business/rune-manifest/mod.ts";

export interface ExpectedFinding {
  id: string;
  line: number;
}

/** The findings `rune check` reports for a corpus fixture: the spec is checked
 * as `src/<stem>/<stem>.rune` so a fixture without `[MOD]` still derives its
 * module (the corpus tests the language, not the project layout). */
function corpusFindings(stem: string, text: string): ExpectedFinding[] {
  const plan = planManifest(`src/${stem}/${stem}.rune`, text, new Set());
  return plan.findings
    .map((f) => ({ id: f.id, line: f.line }))
    .sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

const sidecarPath = (runePath: string): string =>
  runePath.replace(/\.rune$/, ".diag.json");

function stableJson(v: unknown): string {
  return JSON.stringify(v, null, 2) + "\n";
}

function stemOf(p: string): string {
  return p.split("/").pop()!.replace(/\.rune$/, "");
}

async function listRune(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".rune")) out.push(join(dir, e.name));
  }
  return out.sort();
}

/** Check a corpus directory (with `valid/` and `invalid/` under it). Returns one
 * line per mismatch; an empty list is parity. With `update`, a MISSING sidecar
 * is written from the current findings (an existing one is never rewritten —
 * a changed verdict is a reviewed edit, not a recapture). */
export async function corpusParity(
  corpusDir: string,
  opts: { update?: boolean } = {},
): Promise<string[]> {
  const bad: string[] = [];
  for (const p of await listRune(join(corpusDir, "valid"))) {
    const got = corpusFindings(stemOf(p), await Deno.readTextFile(p));
    if (got.length > 0) {
      bad.push(
        `valid/${stemOf(p)}: expected no findings, got ${
          got.map((f) => `${f.id}@${f.line}`).join(", ")
        }`,
      );
    }
  }
  for (const p of await listRune(join(corpusDir, "invalid"))) {
    const got = corpusFindings(stemOf(p), await Deno.readTextFile(p));
    const side = sidecarPath(p);
    let expected: string | null;
    try {
      expected = await Deno.readTextFile(side);
    } catch {
      expected = null;
    }
    if (expected === null) {
      if (opts.update) {
        await Deno.writeTextFile(side, stableJson(got));
        continue;
      }
      bad.push(
        `invalid/${stemOf(p)}: no sidecar ${
          stemOf(side)
        }.diag.json (run with --update-goldens to capture, then review it)`,
      );
      continue;
    }
    if (got.length === 0) {
      bad.push(`invalid/${stemOf(p)}: checked clean (expected findings)`);
      continue;
    }
    if (stableJson(got) !== expected) {
      bad.push(
        `invalid/${stemOf(p)}: findings differ from sidecar\n  got:      ${
          got.map((f) => `${f.id}@${f.line}`).join(", ")
        }\n  expected: ${
          (JSON.parse(expected) as ExpectedFinding[]).map((f) =>
            `${f.id}@${f.line}`
          ).join(", ")
        }`,
      );
    }
  }
  return bad;
}
