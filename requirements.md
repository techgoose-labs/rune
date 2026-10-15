# Requirements

Append-only. One entry per requirement; ids come from `~/.claude/tools/req-next`
(never "last + 1"). Each entry quotes the requirement in the requester's words and
links the tests that prove it, at every level that applies (unit / integration /
e2e — "n/a — <why>" where a level does not).

## REQ-001 — `rune fmt` keeps every top-level declaration at column 0, modifier or not

> rune 7.0.1 (73df493) `rune fmt` corrupts a spec that `rune check` accepts: on
> spec/runes/payments.rune (ppwk-crm, worktree main/nmi-payments) it indents …
> top-level `[REQ:open] …` lines to 4 spaces (e.g. `-[REQ:open] health.check({}):
> HealthDto` → `+    [REQ:open] health.check…`). The formatted copy still passes
> `rune check`, so the corruption is silent. Repro: copy the spec, run `rune fmt`
> on the copy, diff.
> — coms ticket 20260921T050158Z-w15-47057 (#rune, from box 15 / ppwk-crm), 2026-09-21

Cause: `format_content` (lang/cli/src/commands/format.rs) matched tags by bare
prefix — `[REQ]`, `[DTO]`, `[TYP]`, `[NON]` — so any `[TAG:modifier]` form fell
through to the `noun.verb(...)` step heuristic and was indented to 4; `[MOD]` and
`[SRV]` were never recognised at all. The parser (`match_tag`, lang/parser) accepts
a `:modifier` on every top-level tag; fmt now recognises the same set.

- unit: `lang/cli/src/commands/format.rs` —
  `req_001_req_open_stays_at_column_zero`,
  `req_001_modified_dto_typ_non_stay_at_column_zero`,
  `req_001_mod_and_srv_stay_at_column_zero`
  (`cd lang && cargo test -p rune-cli req_001`)
- integration: `lang/cli/tests/format_cli.rs` — the built `rune-syntax` binary on
  `lang/cli/tests/fixtures/payments.rune`, a spec `rune check` accepts, shaped like
  the reporter's: `req_001_canonical_spec_round_trips_byte_identically`,
  `req_001_check_mode_accepts_the_canonical_spec`,
  `req_001_mis_indented_top_level_tags_are_pulled_to_column_zero`
- e2e: n/a — `rune fmt` is a verbatim pass-through to that binary
  (`src/bootstrap/mod.ts`, `SYNTAX_CMDS`) and the CI test job has no Rust
  toolchain; the pass-through was exercised by hand on the built binary (see the
  ticket thread).

## REQ-002 — `rune fmt` never re-indents a comment line

> … it indents standalone comment lines … to 4 spaces … The formatted copy still
> passes `rune check`, so the corruption is silent.
> — same ticket

Cause: a `//` line inside an open block was lumped with description prose and
re-indented to 4, and it also reset the "after a step" state, so a fault written
below a comment was demoted to prose. Both parsers skip comment lines outright, so
a comment's indent is the author's alone: fmt now emits comment lines verbatim and
they are transparent to its block/step tracking.

- unit: `lang/cli/src/commands/format.rs` —
  `req_002_column_zero_comment_after_a_body_stays_at_column_zero`,
  `req_002_indented_comment_keeps_its_indent`,
  `req_002_comment_between_step_and_fault_keeps_the_fault_a_fault`
- integration: `lang/cli/tests/format_cli.rs` —
  `req_002_comment_lines_are_left_exactly_as_written` (plus the canonical fixture
  above, which carries column-0 and fault-level comments)
- e2e: n/a — as REQ-001

## REQ-003 — `deno.lock` is committed fully populated, so the gate never dirties the tree

> (maintainer, m-rune-1, while merging REQ-001/002) `worktree-merge` refused the
> approved content: the ready receipt was bound to a tree that included a
> `deno.lock` rewritten by the gate's own `deno test -A`, and the clean tree did
> not match.

Cause: since 2d77e93 ("move to the @techgoose-labs scope") the committed
`deno.lock` carried only the bedrock specifier, so every `deno` invocation —
including the merge gate — repopulated it and left the worktree dirty. The lock
`deno test -A` writes is deterministic (a further run leaves it byte-identical),
so it is committed as-is; no dependency version changed.

- no tests — lockfile content, no behaviour; proven by running `deno test -A`
  then a second deno command and `cmp`-ing the lock (identical).

## REQ-004 — `rune sync` never adds a root-only import to a workspace member's `deno.json`

> rune sync re-adds "@techgoose-labs/bedrock": "jsr:@techgoose-labs/bedrock@^1"
> to server/deno.json imports, which sprig says must be ROOT-ONLY … Expected:
> rune sync leaves the member import map's bedrock line alone when the workspace
> root already pins it (server/bootstrap/mod.ts resolves it through the root).
> — coms #rune 20260923T000559Z-w208-103513 (box 208, ppwk-crm)

Cause: `ensureImportMap` (sync) adds every `REQUIRED_IMPORTS` key a project's
`deno.json` lacks, and `@techgoose-labs/bedrock` is in that list — while `rune
init` and sprig both declare it `hoistOnly` (bedrock's `ensureWorkspace` strips
it from every member: a member's own pin gives the composed app two composition
roots). So every sync of a workspace member put the pin back.

Rule: the specifiers in `HOIST_ONLY` are never written into a `deno.json` that
is a workspace member (a parent `deno.json` whose `workspace` lists it). When
the workspace root lacks the pin, it is added THERE (additively). A project that
is not a member keeps the old behaviour.

- unit: `src/rune/entrypoints/sync/test.ts` —
  `ensureImportMap — REQ-004: a workspace member never receives the root-only bedrock import`,
  `ensureImportMap — REQ-004: a workspace root missing the pin gets it there, the member still does not`,
  `ensureImportMap — REQ-004: a standalone project still pins bedrock in its own deno.json`
- integration: `src/rune/entrypoints/sync/test.ts` —
  `runSync — REQ-004: syncing a workspace member leaves its deno.json without the bedrock import, twice`
- e2e: n/a — `rune sync` is a direct dispatch to `runSync` (`src/bootstrap/mod.ts`);
  the CLI was driven by hand on a temp workspace (see the ticket thread).

## REQ-006 — the generated stubs gate treats any Deno Deploy revision as production

> rune sync's generated server/bootstrap/modules.ts gates the ghost-stubs module
> on Deno.env.get('DENO_ENV') === 'production'. On Deno Deploy DENO_* env vars
> are reserved and cannot be set by the app, so the stubs module ships to
> production on every Deploy revision. Expected: use the platform's own
> DENO_DEPLOY=true (set by Deno Deploy on every running revision) as the
> production signal.
> — coms #rune 20260925T001931Z-w5-11548 (box 5, infra)

Verified against docs.deno.com/deploy/reference/env-vars-and-contexts: Deploy
sets `DENO_DEPLOY=true` on every running revision, and user keys "cannot start
with DENO_" — so `DENO_ENV=production` is unsettable there and the old gate never
fired. Rule: the generated registry excludes `stubsModule` when `DENO_DEPLOY`
is set (any non-empty value — the platform's, not a value we compare) OR when
`DENO_ENV=production` (kept for hosts that are not Deploy). A plain dev run
still mounts the stubs.

- unit: `src/rune/entrypoints/sync/test.ts` —
  `ensureBootstrap — REQ-006: the generated registry gates the stubs on DENO_DEPLOY, not on DENO_ENV alone`
- integration: `src/rune/entrypoints/sync/test.ts` —
  `ensureBootstrap — REQ-006: the generated stubs gate excludes stubs when DENO_DEPLOY is set (Deno Deploy), evaluated under the real runtime`
  (the generated gate expression is run in a deno subprocess under
  DENO_DEPLOY=true, DENO_ENV=production and no env)
- e2e: n/a — needs a live Deno Deploy revision; the platform contract is
  documented and the expression is evaluated under the real Deno runtime above.

## REQ-007 — `rune sync` emits the four merge-gate tasks, additively, at the workspace root

> the merge gate is now four tasks BY CONVENTION — deno.json tasks `test:unit`,
> `test:int`, `test:e2e`, `serve` … `wt-gate` REFUSES a repo missing any of
> the four … each lane's runner must be parallel … the gate starts `deno task
> serve` on a free $PORT and hands `BASE_URL` to test:e2e (tests never start
> servers) … ASK: (1) `rune sync` should emit the four tasks
> — coms #rune 20260925T020327Z-w8-947540 (box 8, claude-tools, REQ-278..283)

Rule: after the import map, `rune sync` ensures the deno.json the gate reads —
the WORKSPACE ROOT when the codegen root is a member, else the project's own —
carries the four tasks, adding only what is missing (a task the user already
has is theirs). The strings are repo-wide and tool-neutral so sprig can emit
the identical ones and the additive merge never fights:

- `test:unit`: `deno test -A --unstable-kv --parallel --permit-no-files --ignore="**/int.test.ts,**/smk.test.ts,**/e2e.test.ts,e2e/" .`
- `test:int`: `deno test -A --unstable-kv --parallel --permit-no-files "**/int.test.ts" "**/smk.test.ts" "**/e2e.test.ts"` — rune's generated
  `src/**/e2e.test.ts` are in-process `bootstrapServer` runs (no BASE_URL), so they are int-lane
- `test:e2e`: `shots run` (the top-level `e2e/<name>/<name>.e2e.test.ts` stories)
- `serve`: `deno serve -A --unstable-kv --port "$PORT" serve.ts` when a `serve.ts` sits beside that deno.json,
  else `deno run -A --unstable-kv <member>/bootstrap/mod.ts` (its config reads PORT). `--unstable-kv`
  because a rune store may be Deno KV (the gate's own advice); harmless otherwise. deno's task shell
  does not expand `${PORT:-8000}` (verified), so `serve` needs PORT — the gate sets it;
  humans keep `deno task start`.

`rune init` writes the same four into the neutral workspace it creates.

- unit: `src/rune/entrypoints/sync/test.ts` —
  `ensureGateTasks — REQ-007: writes the four gate tasks into the workspace root, never the member`,
  `ensureGateTasks — REQ-007: additive — a task the user already has is never overwritten`,
  `ensureGateTasks — REQ-007: a standalone project gets the tasks in its own deno.json, serving its bootstrap`
- integration: `src/rune/entrypoints/sync/test.ts` —
  `runSync — REQ-007: a sync writes the four tasks once and a re-sync leaves deno.json untouched`,
  `REQ-007: the emitted test:unit and test:int commands run exactly their lanes under deno task`
  (the emitted strings executed by `deno task` in a temp workspace with marker tests)
- e2e: n/a — `wt-gate` and `shots` are claude-tools' and not yet released; the CLI was driven by hand
  on a temp workspace (ticket thread).

## REQ-008 — the rune skills document the four gate tasks, `env/` and `e2e/` via `#shots`

> (2) the rune (and sprig) skills document the four names + env/ + e2e/ via #shots
> so an agent just knows. — same ticket

`claude/skills/rune:framework/references/deployment.md` gains "The four gate
tasks" (names, lanes, `serve` on $PORT, `env/dev` + tracked `env/example` with
the `DENO_DEPLOY` key and its REQ-006 interaction, `e2e/<name>/<name>.e2e.test.ts`
via `import { story, http } from "#shots"`); `rune:build` and `rune:cake` name
the lanes where they say "run the tests" / "serve the app".

- no tests — documentation; sprig's skills are sprig's channel.

## REQ-006 AMENDMENT — the stubs gate tests the VALUE `DENO_DEPLOY=true`, never the key's presence

> DENO_DEPLOY — please gate on the VALUE, not on presence. Raphael's rule
> (REQ-282): the key is ALWAYS present in every env file, `true` only in
> env/prod; our installer writes DENO_DEPLOY=false into env/dev and env/example
> ships the key empty. A non-empty check would drop your ghost stubs on every
> dev box the day env/dev lands. Test Deno.env.get("DENO_DEPLOY") === "true".
> — box 8 (claude-tools) on coms #rune 20260925T020327Z-w8-947540

REQ-006 as merged excluded the stubs on any non-empty `DENO_DEPLOY`. Under
claude-tools REQ-282 every env file carries the key (`false` in `env/dev`), so
that check would have emptied `/docs/stubs` on every dev box. The generated gate
is now `Deno.env.get("DENO_DEPLOY") === "true" || Deno.env.get("DENO_ENV") === "production"`;
`DENO_DEPLOY=false` keeps the stubs. The rune:spec reference (`lang/docs/spec.md`,
the SOURCE — the skill copy is regenerated from it by `scripts/sync-spec-skill-refs.ts`;
REQ-006 had edited the copy, which the regen reverts) says the same.

- unit/integration: the REQ-006 tests in `src/rune/entrypoints/sync/test.ts`,
  with a `DENO_DEPLOY=false → stubs kept` case added to the runtime evaluation.

## REQ-012 — a markdown roadmap of the one-source / one-parser / one-checker changes

> alright lets make a markdown files with the changes we are going to make
> — Raphael, talk-mode review of the rune DSL, 2026-10-15

`todos/09-one-source.md`: the roadmap agreed in the review — five principles,
the evidence (file:line) for each defect found, four phases of checkbox items
(one checker + LSP as the LLM's channel; DSL changes with `rune fmt`
migrations; the registry as the single source with generated docs and an LLM
language card; tree-sitter as the one parser of record), the dispatch order, and
six open decisions with a recommended default each. `todos/README.md` gains
its row and status line. Every item becomes its own `REQ-NNN` when it starts.

- no tests — docs only

## REQ-013 — `rune check --json`: every finding carries a stable rule id, line and severity; `--stdin --path` checks a buffer

> Phase 1, item 1.1 of `todos/09-one-source.md` (REQ-012), started on "well go."
> — Raphael, 2026-10-15

Every error `rune check` reports is a `Finding { id, severity, path, line, message, fix? }`
with an id from one catalogue (`src/rune/domain/business/diagnostics/mod.ts`;
Phase 3.2 moves the catalogue into the registry). The text output renders each
finding as `path:line: message [id]`; `--json` prints `{ path, ok, findings }`
on stdout; `--stdin --path <file>` reads the spec from stdin and resolves root
and core services as if it were at `<file>`, so an editor buffer can be checked
without saving. `plan.errors` is the rendered form of `plan.findings` — one
source, one rendering.

- unit: `src/rune/domain/business/diagnostics/test.ts` —
  `REQ-013: renderFinding is path:line: message [id]`,
  `REQ-013: diagnostic ids are unique`;
  `src/rune/domain/business/rune-parse/test.ts` —
  `REQ-013: parse errors carry a stable id`;
  `src/rune/domain/business/rune-manifest/test.ts` —
  `REQ-013: plan.findings carry ids and plan.errors is their rendering`
- integration: `src/rune/entrypoints/check/test.ts` —
  `REQ-013: runCheck --json prints findings with ids`,
  `REQ-013: runCheck --stdin --path checks a buffer`,
  `REQ-013: runCheck text output names the rule id`
- e2e: n/a — a CLI with no page; the LSP consumer is REQ-014 (Phase 1.2)

## REQ-014 — the corpus pins WHICH findings: invalid fixtures carry a `.diag.json` sidecar and the parity gate diffs it exactly

> Phase 1, item 1.3 of `todos/09-one-source.md` (REQ-012). — Raphael, "well go.", 2026-10-15

`fixtures/corpus/invalid/<name>.diag.json` lists the exact `[{ id, line }]`
`rune check` must report for `<name>.rune`; every `fixtures/corpus/valid/*.rune`
must check clean. `corpusParity()` (`src/rune/domain/business/diagnostics/corpus.ts`)
is the one comparison, used by the `corpus` gate in `scripts/verify.ts`;
`--update-goldens` captures a MISSING sidecar only (a changed verdict is a
reviewed edit). Two checkers can no longer disagree on which error and both pass.

- unit: `src/rune/domain/business/diagnostics/test.ts` —
  `REQ-014: the valid corpus checks clean and every invalid fixture matches its sidecar`,
  `REQ-014: an invalid fixture without a sidecar is a mismatch, and a wrong sidecar names the difference`
- integration: the `corpus` gate of `deno run -A scripts/verify.ts` (same function over the real corpus)
- e2e: n/a — no page; the LSP side of parity is REQ-015

## REQ-015 — the LSP's diagnostics ARE `rune check --json` over the buffer; the engine gains the 80-column rule

> Phase 1, item 1.2 of `todos/09-one-source.md` (REQ-012); "the lsp tells the llm
> if what it did was fucked." — Raphael, 2026-10-15

`rune-lsp` no longer computes a verdict: on open/change it pipes the buffer to
`rune check --json --stdin --path <file>` (`RUNE_BIN`, else the `rune` beside
its own executable, else PATH) and publishes the findings as diagnostics — the
rule id as the code, the 1-based line mapped to the editor's, severity kept, a
`fix` appended to the message. A checker that cannot run or returns no report
is one `checker-unavailable` diagnostic naming the cause. The hand-written
diagnostics port (`compute_diagnostics` and its helpers and tests) is deleted.
The one rule only the LSP enforced, 80 columns, moves into the engine as
`line-length` so nothing is lost.

- unit: `lang/lsp/src/main.rs` —
  `req_015_diagnostics_are_rune_check_json_over_the_buffer`,
  `req_015_missing_checker_is_one_diagnostic_naming_the_cause`,
  `req_015_garbage_report_is_one_diagnostic_with_stderr` (cargo test -p rune-lsp;
  CI runs no cargo — run it by hand before handing off);
  `src/rune/domain/business/rune-parse/test.ts` —
  `REQ-015: a line over 80 characters is a line-length finding`
- integration: REQ-014's corpus gate is the parity oracle both sides now share
- e2e: n/a — an editor protocol, no page

## REQ-016 — rune ships a Claude Code code-intelligence plugin for `.rune`, and the spec-author agent works from the pushed diagnostics

> Phase 1, items 1.4 and 1.5 of `todos/09-one-source.md` (REQ-012). — Raphael, 2026-10-15

`claude/plugin/` is a local Claude Code plugin marketplace named `rune`; its
`rune-lsp` plugin registers `rune-lsp` for `.rune` files (`.lsp.json`), so
Claude Code reports `rune check`'s findings after every edit of a spec. The
installer copies the marketplace to `~/.claude/rune-plugins`, registers it and
installs the plugin when the `claude` CLI is present (else prints the two
commands); the uninstaller removes it; the release tarball carries it as
`plugin/`. `claude/agents/rune-spec-author.md` now loops on the pushed
diagnostics (pulling `rune check --json` only when no plugin is loaded), runs
`rune fmt`, and keeps `rune check` exit 0 as the gate it returns.

- unit: `src/rune/domain/business/diagnostics/test.ts` —
  `REQ-016: the rune-lsp plugin registers rune-lsp for .rune under the marketplace entry of the same name`;
  `claude plugin validate claude/plugin` → "Validation passed" (run by hand)
- integration: n/a — the installer's `claude plugin …` calls need a user's Claude Code; verified by hand on this box
- e2e: n/a — no page; the agent definition is a markdown deliverable (no tests — docs only)
- `build:rust` (the gate's optional `build` step runs it first) finds cargo in
  `$HOME/.cargo/bin` when the gate's shell has no rustup profile sourced — the
  gate on this box died with `cargo: command not found` (exit 127) otherwise.
