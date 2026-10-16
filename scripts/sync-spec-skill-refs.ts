#!/usr/bin/env -S deno run -A
// sync-spec-skill-refs.ts — make the `rune:spec` skill self-contained.
//
// The skill must carry the language reference WITH it, because it runs inside an
// arbitrary user project (e.g. `flame/`) where the rune repo's `lang/docs/` and
// `examples/` do NOT exist. Without the bundle, the agent has to go find the
// toolchain source and read the docs from there — wasted, brittle archaeology.
//
// So the language card (generated from the registry and the corpus by
// scripts/gen-lang-docs.ts — grammar by example, every table, every rule with
// its message and fix, every invalid fixture as an error → fix pair), the
// hand-written cookbook and two known-good example specs are COPIED, verbatim,
// into the skill's `references/`. `install.sh` ships the whole skill folder, so
// the copies travel to `~/.claude/skills/rune:spec/references/`.
//
// Usage:
//   deno run -A scripts/sync-spec-skill-refs.ts          # write the copies
//   deno run -A scripts/sync-spec-skill-refs.ts --check   # verify in sync (CI); exit 1 on drift

// src (repo-relative) → dest (under claude/skills/rune:spec/references/)
const PAIRS: [src: string, dest: string][] = [
  ["lang/docs/card.md", "card.md"],
  ["lang/docs/cookbook.md", "cookbook.md"],
  ["examples/todos/src/core/core.rune", "example-core.rune"],
  ["examples/todos/src/tasks/tasks.rune", "example-tasks.rune"],
];

const REF_DIR = "claude/skills/rune:spec/references";
const check = Deno.args.includes("--check");

const drift: string[] = [];
for (const [src, dest] of PAIRS) {
  const want = await Deno.readTextFile(src);
  const destPath = `${REF_DIR}/${dest}`;
  if (check) {
    let have: string | null = null;
    try {
      have = await Deno.readTextFile(destPath);
    } catch {
      have = null;
    }
    if (have !== want) drift.push(`${destPath} is out of sync with ${src}`);
  } else {
    await Deno.mkdir(REF_DIR, { recursive: true });
    await Deno.writeTextFile(destPath, want);
    console.log(`✓ ${destPath}  ←  ${src}`);
  }
}

if (check) {
  if (drift.length) {
    console.error(
      `rune:spec references drifted from their sources:\n  ${
        drift.join("\n  ")
      }\n` +
        `  → run: deno run -A scripts/sync-spec-skill-refs.ts`,
    );
    Deno.exit(1);
  }
  console.log("rune:spec references in sync with lang/docs + examples.");
}
