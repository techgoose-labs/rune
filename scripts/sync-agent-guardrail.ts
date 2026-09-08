#!/usr/bin/env -S deno run -A
// sync-agent-guardrail.ts — stamp the shared "never crawl the filesystem" guardrail
// into every bundled Claude Code agent, so a spawned subagent carries the knowledge
// it would otherwise go hunting for.
//
// WHY: subagents (rune-build-method-impl, rune-build-test-author, the framework/cake
// agents …) spawn with only their own `.md` as context — they do NOT load the rune:*
// skills. So when one needs a framework internal (the `#assert` contract, the
// `HttpException`→422 mapping, `bootstrapServer`, a Playwright screenshot's path) it
// improvises with `find /` — which, because Claude Code shadows `find` with a
// multithreaded `bfs`, crawls the whole disk and pegs several cores for minutes. An
// audit found 600+ such root crawls across projects, nearly all for things already
// documented in the co-installed skill references.
//
// This is the same fix `sync-spec-skill-refs.ts` applies to the rune:spec SKILL
// ("carry the reference WITH it — don't do brittle archaeology"), extended to the
// AGENTS: one canonical guardrail (scripts/agent-guardrail.md) is injected, verbatim,
// between markers into each claude/agents/*.md, just above its `## Never` section.
// `install.sh` ships the agents, so the guardrail travels to ~/.claude/agents/.
//
// Idempotent: re-running regenerates the block in place (edit the snippet, re-run,
// every agent updates). Insertion anchor: the `## Never` heading every agent ends
// with; agents without one get the block appended.
//
// Usage:
//   deno run -A scripts/sync-agent-guardrail.ts           # inject / update
//   deno run -A scripts/sync-agent-guardrail.ts --check    # verify in sync (CI); exit 1 on drift

const SNIPPET = "scripts/agent-guardrail.md";
const AGENTS_DIR = "claude/agents";
const BEGIN = `<!-- BEGIN rune-agent-guardrail: ${SNIPPET} -->`;
const END = "<!-- END rune-agent-guardrail -->";
const ANCHOR = "\n## Never";

const check = Deno.args.includes("--check");

const body = (await Deno.readTextFile(SNIPPET)).trim();
const block = `${BEGIN}\n${body}\n${END}`;

// Return the file content with the guardrail present exactly once, or null if the
// file already matches (no write needed).
function withBlock(text: string): string {
  const b = text.indexOf(BEGIN);
  if (b !== -1) {
    // Replace whatever is currently between the markers.
    const e = text.indexOf(END, b);
    if (e === -1) {
      throw new Error("found BEGIN marker without END — file hand-edited?");
    }
    return text.slice(0, b) + block + text.slice(e + END.length);
  }
  // First insertion: place the block just above the `## Never` section, else append.
  const a = text.indexOf(ANCHOR);
  if (a !== -1) {
    return text.slice(0, a + 1) + block + "\n\n" + text.slice(a + 1);
  }
  return text.replace(/\s*$/, "") + "\n\n" + block + "\n";
}

const drift: string[] = [];
let wrote = 0;
for await (const entry of Deno.readDir(AGENTS_DIR)) {
  if (!entry.isFile || !entry.name.endsWith(".md")) continue;
  const path = `${AGENTS_DIR}/${entry.name}`;
  const have = await Deno.readTextFile(path);
  const want = withBlock(have);
  if (have === want) continue;
  if (check) {
    drift.push(path);
  } else {
    await Deno.writeTextFile(path, want);
    console.log(`✓ ${path}`);
    wrote++;
  }
}

if (check) {
  if (drift.length) {
    console.error(
      `agent guardrail drifted from ${SNIPPET} in:\n  ${drift.join("\n  ")}\n` +
        `  → run: deno run -A scripts/sync-agent-guardrail.ts`,
    );
    Deno.exit(1);
  }
  console.log(`agent guardrail in sync across ${AGENTS_DIR}.`);
} else {
  console.log(
    wrote === 0
      ? "agent guardrail already up to date."
      : `updated ${wrote} agent(s).`,
  );
}
