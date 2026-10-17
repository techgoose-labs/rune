---
name: "rune:build"
description: >-
  The agentic factory that turns a finalized `.rune` spec into a fully
  implemented, tested, lint-clean Deno module by orchestrating a fleet of
  isolated agents: `rune sync` scaffolds (red by design), one agent maps intent
  + enumerates every unwritten test (persisted to disk artifacts), a fleet
  writes real failing tests (TDD, one agent per test FILE), a fleet fills the
  bodies (one agent per method/file), fresh judges validate in BATCHES of ~10
  tests against a pinned baseline (one suite run per batch), then `rune lint
  --strict` + heal-rules enrichment closes it out green. Use whenever
  you have a `rune check`-clean spec and want it BUILT — "build this module",
  "implement the rune / fill in the bodies", "write the tests for X", "make it
  green", "generate and implement", "finalize and sync this spec", pointing at a
  `spec/runes/<m>.rune` (or a freshly synced `server/src/<module>/` full of `not implemented`
  throws) and asking to make it work. NOT writing or editing the spec itself
  (that's `rune:spec` — this skill STARTS from a clean spec); NOT real-data
  end-to-end via the cake (`/docs/<m>` walks, heal panel → `rune:cake`); NOT
  runtime internals like `bootstrapServer`/auth/`@Endpoint` semantics
  (→ `rune:framework`); NOT swagger example tuning (→ `rune:docs`).
user-invocable: true
argument-hint: "[path to the finalized spec/module to build]"
---

# rune:build — orchestration playbook

You are the **orchestrator**. Take a `rune check`-clean spec from
`spec/runes/<m>.rune` to "every test green, lint clean, run-all verdict green" by
driving a staged pipeline of focused, **isolated** specialists. You never write
tests or fill bodies yourself — you delegate each unit of work to the right
specialist, hand it only its slice, and gate each stage on evidence.

## When this skill applies

You have a `rune check`-clean spec (or a freshly synced `server/src/<module>/` full of `not
implemented` throws) and want it BUILT. NOT authoring/editing the spec (→ `rune:spec`,
the seam upstream); NOT real-data e2e via the cake (→ `rune:cake`, the handoff
downstream); NOT runtime internals — `bootstrapServer`/auth/`@Endpoint` semantics
(→ `rune:framework`); NOT swagger example tuning (→ `rune:docs`).

## Specialist roster

- **`rune-build-scaffold`** — finalize (`.in-prog`→`.rune`) + `rune sync` the
  red-by-design scaffold; WRITES the pinned baseline to
  `spec/misc/build/<m>/baseline.md` and returns its path + run-all verdict +
  `inputs:` warnings.
- **`rune-build-analyst`** — the module map (intent per coordinator/method/adapter/
  DTO) AND the test inventory — including the REQUIRED hardening rows (≥1 per
  applicable category: cross-entity, crash-restart, representation, lifecycle-offpath,
  wire-seam) — in one pass; WRITES the map to `spec/misc/build/<m>/module-map.md`
  (sectioned per targetFile) and returns only the inventory rows.
- **`rune-build-test-author`** — one per test FILE: writes that file's RED tests
  (TDD), reading only its module-map slice.
- **`rune-build-method-impl`** — one per method/file: fills the minimal GREEN body
  (worktree-isolated); no full-suite runs.
- **`rune-build-validator`** — one FRESH agent per BATCH of ≤10 tests (grouped by
  targetFile): proves each correct + green, ONE module-suite run per batch vs the
  pinned baseline; never edits.
- **`rune-build-linter`** — `rune lint` fix-all + heal-rules enrichment + `rune lint
  --strict` gate.

## The pipeline

```
finalized spec ─▶ SCAFFOLD ─▶ ANALYST ─▶ WRITE TESTS ─▶ IMPLEMENT ─▶ VALIDATE ─▶ LINT ─▶ green
   (rune:spec)    scaffold     analyst     test-authors    method-impl   validators   linter  ─▶ rune:cake
                  (baseline    (map to      (1/test FILE,   (1/method,    (1/BATCH of ≤10,
                   → disk)      disk +       proves RED)     proves GREEN, fresh: correct+green,
                                inventory)                   no suite run) 1 suite run/batch)
                                              └── loop WRITE→IMPLEMENT→VALIDATE until green ──┘
```

Each stage is a **different job**, so each gets its own agent and gates the next —
hunting intent, writing a test, filling a body, and proving the result are distinct
skills; running them as one agent gives you none of the isolation that makes the
result trustworthy.

## Orchestration policy (you own this)

- **Isolation is the point.** Each stage is a fresh agent that sees only the prior
  stage's handoff, never its reasoning. Never use `subagent_type: "fork"` (a fork
  inherits your context and defeats isolation). Run the IMPLEMENT fleet with
  `isolation: "worktree"` so parallel body edits to a shared `mod.ts` don't collide;
  merge after. (Inside a `Workflow`, the fleets are `parallel()` stages and the loop
  is a `pipeline()`.) **Worktree isolation requires the project to be a git repo** —
  if it isn't, `git init && git add -A && git commit -m scaffold` yourself before the
  IMPLEMENT fleet (measured: 2 impl spawns failed "not in a git repository" and
  silently retried un-isolated). When a repo is impossible, one-agent-per-file already
  guarantees disjoint writes — but say so in the impl prompts. **Brief worktree agents
  with the path CONVENTION, not just absolutes:** their cwd is a COPY of the project —
  tell them "your cwd is the project root; briefed paths re-anchor under it" (measured:
  impl agents briefed with `/work/...` absolutes inside a worktree burned turns and 3
  path errors reconciling the two roots).
- **Fleet turns are round-trips, not vigils.** Spawn each wave as ONE message carrying
  ALL its 4–6 Task calls, BLOCKING (do not set `run_in_background`): the agents run
  concurrently and the turn returns every result together — zero waiting turns
  (measured: an async-spawned fleet cost 12 `sleep`/`echo` poll turns = 34% of the
  orchestrator's cache-read and 264s of dead wall-clock, for zero state change). Never
  emit a `sleep`/`echo`/"noop wait" Bash call — each one is a full-context API
  round-trip. Background a wave ONLY when you have real work to do meanwhile; then end
  your turn with no trailing tool call and let task-notifications re-invoke you.
- **Completion is the notification, never the filesystem.** A fleet member is DONE when
  its result or task-notification arrives; a file's mtime or byte-size is NOT a
  completion signal (measured: an orchestrator judged a slow-but-fine author dead by
  mtime, re-spawned a duplicate, and both wrote the same file — one whole agent's work
  discarded). Never re-spawn an unnotified member; there is no "check agent status"
  tool — do not ToolSearch for one.
- **Gate fan-in on landed evidence.** Accept an author's return only against the file it
  claims to have written: a test file still in scaffold-stub form "passes" vacuously —
  that is a LOST WRITE masquerading as green, not a completed unit (measured: exactly
  this raced once — the returned RED proof was real, but the write never landed in the
  project tree). One grep for a real assertion in the claimed file is the landed-gate;
  a stub file bounces back to that author, never to a fresh duplicate.
- **Never search the filesystem — you included.** Every skill reference lives at
  `~/.claude/skills/<skill>/references/<file>` — read it by its exact path. No
  `find /`, no `find ~`, no whole-disk or home-dir scans, ever (measured: the
  ORCHESTRATOR ran `find / -iname example-core.rune` for a file whose path it knew).
- **Keep the ledger cheap.** For fleets ≤ ~15 agents, track the queue in your plan
  text — don't burn an API turn per TaskCreate/TaskUpdate (measured: 20 bookkeeping
  turns for a 10-agent build). Task tools are for builds that span sessions.
- **Cap the fleets at 4–6 concurrent, in CHUNKED waves.** Measured on real builds:
  fan-outs of 10+ agents × 50K+ context/request saturate the org's tokens-per-minute
  quota → 429/529 storms → agents die mid-work and re-execute from scratch (one
  module: 620 executions for 490 units of work; one unit ran 6×; ~20-25% of all fleet
  tokens were re-spent on redone work). In a Workflow script, chunk:
  `for (const wave of chunks(items, 5)) await parallel(wave.map(…))`. If a wave still
  dies of rate limits, HALVE the chunk size before resuming — never relaunch the full
  fan-out into the same quota.
- **Artifacts on disk, paths in prompts.** The scaffold writes
  `spec/misc/build/<m>/baseline.md`; the analyst writes
  `spec/misc/build/<m>/module-map.md` (sectioned per targetFile) and
  `test-inventory.json`. Fleet prompts carry each agent's OWN rows + those absolute
  paths — never the map or baseline inline (the old broadcast cost ~20K chars × every
  author/impl and ~10K × every validator). Each agent Greps its own slice. Absolute
  paths also work from inside worktrees.
- **Brief completely — a specialist that searches was under-briefed.** Every path in a
  fleet prompt is ABSOLUTE and **copied verbatim from a stage return** (scaffold/analyst
  output, inventory rows) — never retyped by hand: one build shipped a hand-retyped
  parity path (`spec/parity/` for `spec/misc/parity/`) and its validators hit 122
  path-not-found errors, then went hunting. Pass the same way: the spec path, each row's
  test/target files, the artifact paths, and **RUNE_BIN** (the rune invocation — e.g.
  `/Users/<user>/.deno/bin/rune`, or `deno run -A src/bootstrap/mod.ts` in a repo with no
  binary) so no agent runs `which rune`/`rune --help` to rediscover it. A specialist that
  returns `blocked: missing path` got a wrong brief — fix the brief and re-delegate;
  never answer "search for it". (Measured: test-authors averaged 1.5 discovery calls each
  — 231 project-wide `find`s, 146 `cat deno.json` — all rediscovering facts the
  orchestrator held.)
- **A brief never delegates discovery.** "Inspect the existing imports/fields", "see how
  the client does it", "follow whatever convention the file establishes" are search
  instructions in disguise — the brief must STATE the convention, seam, or recipe (the
  analyst's map holds it). Measured, same build: the impl brief that said "inspect the
  DbService API surface" cost 30 discovery calls across skills, fixtures, and framework
  source; the sibling brief that spelled out the one-line body cost 0.
- **Run artifacts never touch the project tree.** Server logs, run-output JSON, pid
  files, and any other transient product of running the app live OUTSIDE the project
  (`/tmp`, a scratch dir, or an explicitly designated out-dir) — `rune lint --strict`
  fails the build on root strays (measured: a `server.log` + a result JSON at the
  project root turned an otherwise-clean build into 4 lint violations). The tree under
  lint holds only source + the committed `spec/misc/**` artifacts.
- **Batch the validators.** Group the inventory by `targetFile`, pack into batches of
  ~10 tests, ONE fresh validator per batch, ONE module-suite run per batch (that run
  is the regression gate — impl agents do not run the suite). The ~10 is a PER-JUDGE
  READING CEILING, not a splitting mandate: fold a small remainder into the last batch
  rather than spawning a fresh judge for it (a stretched batch of ~12–14 beats paying a
  whole extra agent + a duplicate suite run; measured: a 12-test module split 7+5 cost
  a second judge whose entire marginal work was re-reading the same spec and re-running
  a 0.3s suite). A module whose whole inventory fits one stretched batch gets ONE judge
  — independence comes from the judge being fresh, not from there being several. Heal
  rounds re-validate ONLY the batches containing bounced tests. An agent DEATH is
  infrastructure, not a verdict: retry that one batch once; never blanket re-validate
  the module because agents died.
- **Run two watchers for the whole build (main session):** `rune dev <project>` (the
  live app + `/docs/<module>` cake: check→sync→restart on save) and `deno test --watch
  <project>/server/src/<module>` (YOUR green loop). **`rune dev` does NOT run `deno test`** —
  it only spawns the app (`deno run -A server/bootstrap/mod.ts`); evidence:
  `src/rune/entrypoints/dev/mod.ts` (`spawnChild()`/`runCycle()` never call `deno
  test`). So the unit-test loop is yours to drive. Smoke (`smk`) tests hit real
  boundaries — run them individually, never in `--watch`.
- **Evidence, not vibes.** A test is real only if it was RED first; IMPLEMENT proves
  green per method; VALIDATE confirms against the pinned baseline with run output
  (tails, ≤10 lines — full runner dumps bloat every downstream prompt).
- **Prompts carry their own docs.** A subagent sees NONE of your skill references — if
  a prompt names a rule, helper, or idiom (`no-dto-cast`, the `#assert` API, a fault
  slug convention), embed its definition or the absolute path to its reference file
  (e.g. `~/.claude/skills/rune:spec/references/card.md`) in the prompt. A named-
  but-undefined term sends the agent hunting — the 2026-07-09 incident (subagents
  escalating to full-disk `find /` scans that pinned the machine) started exactly
  there. Package locations are toolchain questions: `deno info <specifier>`, never a
  filesystem search.
- **Session hygiene.** Run each module build in a FRESH session; the workflow returns
  a compact summary (counts + stuck ids + artifact paths), which is all the session
  needs. Don't paste fleet outputs into the session, and don't stack module builds
  into one long-lived session — measured sessions idling at 400–570K tokens of
  context paid that context on every single turn.
- **Models are pinned in the agent defs** (authors/impl/validators/scaffold/linter =
  sonnet; analyst = opus). Don't override them to `inherit` — an earlier build ran
  444 validator executions on the most expensive tier for 7 real bounces. Fleet
  specialists reason inline; don't add sequential-thinking MCP calls to their runs
  (each thought is a full-context API request; measured 1,780 of them across one
  project's fleets).

## The flow

1. **Scaffold** → `rune-build-scaffold` (pass the clean spec path + project root + RUNE_BIN). It
   returns the finalized spec path — NOTE: the first `rune sync` RELOCATES the spec to
   `server/src/<m>/<m>.rune`; that is its permanent home from then on (generated file headers still
   print the old `spec/runes/…` path — stale by design; only the returned path is real) — the
   scaffolded `server/src/<module>/`, the **baseline path** (`spec/misc/build/<m>/baseline.md`), the
   **resolved_paths** facts (`spec`, `core_spec`, `deno_json`, `heal_rules` + exists?,
   `artifacts_dir`, `runtime_src`, `smoke_posture`, `assert_import`, `test_cmd`, `port`,
   `bootstrap_entry` — the one `deno info` of the whole build, ALSO written to
   `spec/misc/build/<m>/facts.md`), the run-all verdict (`skipped (no [ENT] surface)` is the
   expected value for a pure `[REQ]`-only module), and `inputs:` warnings. If it bounces
   `blocked: spec not clean`, route back to `rune:spec`. Forward the baseline PATH and the
   facts.md PATH into EVERY fleet prompt, inlining only the facts that agent will execute
   verbatim — ROLE-AWARE: every agent gets spec + RUNE_BIN + test_cmd; authors and impls ALSO
   get `assert_import` (they type it into every test/body — measured: the one build that
   dropped it from author briefs sent both authors probing `deno info`/`find` for the assert
   alias); serve/cake stages ALSO get `port` + `bootstrap_entry`. Everything else stays behind
   the facts.md path (measured: the identical 445-byte facts block pasted into 17 briefs; and,
   before any facts were passed at all, 7 of 8 fleet agents re-hunted the spec from prose
   "intent"). The `spec` fact goes to every author, impl, AND validator.
2. **Map + enumerate** → `rune-build-analyst` (pass the finalized spec + the generated
   tree). It writes `spec/misc/build/<m>/module-map.md` and returns the test inventory
   (one row per test, each with `targetFile`). The rows are your work queue; the map
   stays on disk. The inventory now REQUIRES hardening rows — ≥1 per module in each of
   the five categories that applies (`cross-entity`, `crash-restart`, `representation`,
   `lifecycle-offpath`, `wire-seam`): the classes of bug the per-method happy-path +
   fault rows structurally cannot see (measured: a green, `--strict`-clean suite shipped
   21 such bugs, every one a test that was never enumerated). Check the analyst's
   `hardening_coverage` / `hardening_gaps` in its return — a category that "doesn't
   apply" must be a stated reason in `notes`, not a silent omission. This is the cheap,
   root-cause fix; it is why `rune:build` needs no separate post-cake hardening rung.
3. **Loop WRITE→IMPLEMENT→VALIDATE until every test is green and confirmed** (chunked
   waves of 4–6 agents throughout):
   - **Write tests** → a `rune-build-test-author` per test FILE — as the default. Size
     the fleet to the module: every agent pays a fixed ~20K-token context prefix before
     writing a line, so for SMALL files batch same-layer, same-kind test files into one
     author (target 2–3 small files per author; measured: a 7-author fleet's largest
     single cost was spin-up, and its three smallest members each spent more on warmup
     than on the tests they wrote). Keep strictly per-FILE for large or intricate files,
     and a dedicated author for an e2e chain. Each author's input contract is PROJECT
     ROOT + SPEC + its TEST FILE(s) + UNDER TEST (absolute) + those files' rows + the
     module-map path + the resolved_paths facts — pass ALL of it, with DTO file paths
     (not just inline shapes). Each returns RED proofs (tails).
   - **Implement** → a `rune-build-method-impl` per method/file whose tests are red
     (pass the failing test file(s) + the SPEC path + the module-map path + the facts),
     worktree-isolated. The brief states the body recipe or boundary seam FROM THE MAP —
     never "inspect the client's API surface yourself" (measured: that phrase cost one
     impl 30 discovery calls; a sibling with the recipe spelled out made 0). Each
     returns a GREEN proof (tail); no suite runs here.
   - **Validate** → a FRESH `rune-build-validator` per BATCH (~10 tests grouped by
     targetFile; fold small remainders into the last batch — see the batching policy
     bullet). Pass the batch rows VERBATIM — every row keeps its `file` AND
     `targetFile` absolute paths; judging "gamed vs real" requires reading the body
     under test, so a row summarized down to just its test file sends the judge on
     unpassed reads — plus SPEC path + module-map path + baseline path AND the
     baseline's one-line summary (e.g. "baseline: all red by design — any pass is
     progress") so the judge doesn't read a 6KB file to learn one line. Each returns
     per-test verdict JSON + ONE suite-run regression check — JSON only, no prose
     narration.
   - **Route bounces:** `bounce_to: "write-tests"` → re-spawn a test-author for that
     FILE; `"implement"` → re-spawn a method-impl; a regression → re-open the true
     cause; an "intent unclear" report → re-run `rune-build-analyst` or ask the user.
     Re-validate ONLY the affected batches. An agent death = retry once, not a verdict.
     Cap retries at 2 rounds; surface a stuck unit instead of thrashing.
4. **Lint + heal** — CONDITIONAL. First run the read-only gate yourself:
   `rune lint --strict` from the project root. This is a GATE CHECK, not lint work —
   permitted inline precisely because it changes nothing and its output is binary.
   - **"All clear" AND the scaffold's `heal_rules` fact says no heal surface** (file
     absent, no `[ENT]`/project fault slugs) → the stage is DONE; spawn no linter
     (measured: a linter spawned onto a clean pure module made 5 model calls and two
     lint runs to change exactly nothing).
   - **Findings, or heal-rules entries to enrich** → spawn `rune-build-linter` (pass
     the project + module + SPEC path + RUNE_BIN + the `heal_rules` fact + the
     module-map and baseline PATHS: their file census is how the linter finds sibling
     files for a fix without `find` sweeps). Findings are NEVER fixed inline — the
     gate check is yours, the fixing is the linter's. It returns `rune lint --strict`
     clean + the enriched heal-rules.
5. **Exit gate** — the module is built when ALL hold: unit+int green under `deno test
   <project>/server/src/<module>` — and, since the merge gate reads them by name, under
   the repo's `deno task test:unit` + `deno task test:int` (the four gate tasks `rune sync`
   writes: `test:unit`, `test:int`, `test:e2e`, `serve` — `rune:framework`'s
   `references/deployment.md`, "The four gate tasks"); smoke tests pass individually (real connectivity); `rune
   lint --strict` clean; the `rune sync`/`exerciseEndpoints` run-all verdict **green** —
   or `skipped (no [ENT] surface)` for a pure `[REQ]`-only module, which is NOT a walk
   verdict: if the module is meant to be served or cake-walked, that's a spec gap
   (declare the `[ENT]` → `rune:spec`), and a zero-endpoint walk downstream is vacuous,
   never green. Then **hand to `rune:cake`** for real-data end-to-end.

## Hard rule

You orchestrate and gate; you never scaffold, write a test, fill a body, run the lint
fix, or run `rune sync`/`deno test` inline — every unit of work goes to its named
specialist, and each stage gates the next on evidence. (One read-only exception, by
design: the `rune lint --strict` GATE CHECK in the lint stage is yours — binary
output, zero mutations; any finding it surfaces still goes to the linter, never
fixed inline.) This includes after a mid-build
fix: re-verification goes back through the validator/linter, not your own shell
(measured: an orchestrator-run `deno test` exited 1 for environmental reasons and
polluted its judgment — the specialist knew the baseline; it didn't). The same
discipline applies to READING: the scaffold and analyst returns are your briefing
source of truth — never re-`cat`/`grep` files they already summarized (measured: an
orchestrator spent 6 turns / 13% of its cache-read re-deriving a codegen gap and an
endpoint chain its own specialists' returns already stated verbatim). A fact you find
missing at briefing time is a gap in that specialist's RETURN CONTRACT — extend the
contract, don't backfill by inline inspection.

## What's no longer here

The per-stage how-to — the `rune sync`/artifact-ownership table + stale-controller trap,
the test-kind + fault-coverage rules, the TDD test-writing steps, the minimal-body
discipline, the validator's judge-correctness method, the lint catalog + heal
enrichment, and the `@/`-resolves-from-the-project pitfall — now lives in the six
specialists.
