// REQ-017 — the merge gate's test lanes (REQ-278/316).
//
// A test's kind is its filename, by the gate's own rule (wt-gate `kind_of`):
//   smoke  *.smk.test.* / smk.test.*            never in a lane
//   e2e    *.e2e.test.* / under e2e/            test:e2e
//   int    *.int.test.* / int.test.*            test:int
//   unit   anything else named *test.ts         test:unit
//
//   deno run -A scripts/lane.ts <unit|int> [--plan]
//
// `--plan` prints the files the lane would run, one per line (what the gate
// reads before running anything); without it the lane is
// `deno test --parallel` over exactly those files. The roots are the ones CI
// tests (src/rune/, keep/) plus scripts/ for this script's own test.

import { dirname, fromFileUrl } from "#std/path";

/** The repo root — from this file, never the cwd (a parallel test may chdir). */
export const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

export type Kind = "unit" | "int" | "e2e" | "smoke";

const ROOTS = ["src/rune", "keep", "scripts"];

const TEST_NAME = /(^|\/)([^/]*[_.])?test\.(ts|tsx|mts|js|mjs|jsx)$/;

export function kindOf(path: string): Kind {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/(^|\.)smk\.test\./.test(base)) return "smoke";
  if (/(^|\/)e2e\//.test(path) || /\.e2e\.test\./.test(base)) return "e2e";
  if (/(^|\.)int\.test\./.test(base) || /\.docker\.test\./.test(base)) {
    return "int";
  }
  return "unit";
}

async function trackedTests(roots = ROOTS): Promise<string[]> {
  const out = await new Deno.Command("git", {
    args: [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...roots,
    ],
    cwd: ROOT,
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).split("\n").filter((p) =>
    TEST_NAME.test(p)
  ).sort();
}

export async function plan(kind: Kind, roots = ROOTS): Promise<string[]> {
  return (await trackedTests(roots)).filter((p) => kindOf(p) === kind);
}

if (import.meta.main) {
  const [kind, flag] = Deno.args;
  if (kind !== "unit" && kind !== "int") {
    console.error("usage: lane.ts <unit|int> [--plan]");
    Deno.exit(2);
  }
  const files = await plan(kind);
  if (flag === "--plan") {
    console.log(files.join("\n"));
    Deno.exit(0);
  }
  const run = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "--parallel", "--unstable-raw-imports", ...files],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(run.code);
}
