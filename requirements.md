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
