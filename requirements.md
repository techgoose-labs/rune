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

## REQ-018 — faults are `! name name` under a step, well-known or with a status; codegen emits typed fault classes and the runtime maps them; `rune fmt` migrates bare faults

> okay do all the other phases on a single branch — Phase 2, item 2.1 of `todos/09-one-source.md` (REQ-012). — Raphael, 2026-10-15

A fault line declares its kind by its first token, the registry's marker
(`lang/keywords.json` → `faults.marker`, `!`); indentation is cosmetic. The
registry's `faults.wellKnown` table carries the HTTP status of each well-known
name (`not-found` 404 … `invalid-*` 422); any other name declares its own
(`! card-expired=402`) or is a `fault-status` error. Codegen emits
`src/<module>/dto/faults.ts` — one `<Name>Fault extends RuneFault` class per
fault with its status (spec-owned, regenerated) — and keep's bootstrap answers
a thrown `RuneFault` with that status and `{ name, fault, status, message }`.
`rune fmt` rewrites a bare fault line (the pre-marker form) to `! …`; the
engine reports it as `fault-marker` with that fix. Every tracked spec was
migrated.

- unit: `src/rune/domain/business/rune-parse/test.ts` —
  `REQ-018: a fault line is \`! name name\`; a custom fault carries its status`;
  `src/rune/domain/business/rune-checks/test.ts` —
  `REQ-018: a fault is well-known (status from the registry) or carries =NNN, else fault-status`;
  `src/rune/domain/business/rune-manifest/test.ts` —
  `REQ-018: the module's faults.ts declares one typed class per fault with its status`;
  `keep/src/faults/test.ts` — `REQ-018: a RuneFault maps to its status and body`;
  `lang/cli/src/commands/format.rs` — `req_018_bare_fault_lines_are_rewritten_with_the_marker` (cargo test)
- integration: the corpus gate (`fixtures/corpus/invalid/fault-bare.rune`,
  `fault-custom-no-status.rune` with their sidecars); `lang/cli/tests/format_cli.rs`
- e2e: n/a — a language rule and a status mapping, no page

## REQ-019 — an `[ENT]` names its `[REQ]` on an indented body line; there is no matching by signature

> Phase 2, item 2.2. — Raphael, 2026-10-15

The body `[REQ]` line is required for every `[ENT]` and every `[ENT:ws]` topic
(`ent-delegate-required`, whose fix names the `[REQ]`(s) whose signature
matches); a body naming an undefined `[REQ]` is `ent-delegate-undefined`. The
signature matching and its `ent-ambiguous` error are deleted; the generated
controller wires only the named coordinator.

- unit: `src/rune/domain/business/rune-checks/test.ts` —
  `REQ-019: an [ENT] without a body [REQ] is ent-delegate-required and the fix names the signature match`;
  `src/rune/domain/business/rune-parse/test.ts` —
  `REQ-019: [ENT] with its body [REQ]; a body with a modifier or a bad signature`
- integration: the corpus gate (`invalid/ent-no-body.rune`, `invalid/ent-body-undefined.rune`)
- e2e: n/a — a language rule, no page

## REQ-020 — the value model: one live value per name, named by `as`; the registry's scope rules are enforced by the engine

> Phase 2, item 2.3; closes `todos/08`. — Raphael, 2026-10-15

A `[REQ]`'s scope starts with its input (by type) and the input's fields
(recursively); every step adds the value it yields under its `as` name or its
type; `[NEW]` adds the noun; a DTO value exposes its fields. A second value under
a taken name is `value-duplicate` (error; a fluent step on the value itself is
the same value). `[RET]` takes a value name resolved through the scope. The
rules the registry declared and nothing enforced — `noun-in-scope`,
`param-scope`, `undefined-ref`, `signature-consistency`,
`last-step-returns-output` — fire from `src/rune/domain/business/rune-checks/mod.ts`
under their registry ids, severities and messages. Codegen resolves value names
in the coordinator weave and types a value-named parameter by its value.

- unit: `src/rune/domain/business/rune-checks/test.ts` —
  `REQ-020: a second live value of one type must be named with \`as\`, and the name resolves in params and [RET]`,
  `REQ-020: the five registry scope rules fire under their ids`;
  `src/rune/domain/business/rune-parse/test.ts` — `REQ-020: a step names its value with \`as\``
- integration: the corpus gate (`invalid/value-duplicate.rune`, `scope.rune`,
  `signature-consistency.rune`, `last-step-not-output.rune`)
- e2e: n/a — a language rule, no page

## REQ-021 — retired duplicates: `[CTR]`, `Class`, `[TYP:from=path|path*]`, a redundant `[RET]`

> Phase 2, item 2.4 (D3: keep `@ METHOD /template`, D5: keep `[NON]`). — Raphael, 2026-10-15

`[CTR]` is `ctr-retired` (fmt rewrites it to `[NEW]`); `[TYP] x: Class` is
`class-retired` (a noun is a `[NON]`; `Class` left the builtins); `from=path`
and `from=path*` are `from-path-retired` (the `[ENT]` route template is the one
path binding; `from=query|header` stay); a `[RET]` right after a step that
already returns the output is `ret-redundant` (warning).

- unit: `src/rune/domain/business/rune-checks/test.ts` —
  `REQ-021: [CTR], Class, from=path and a redundant [RET] are findings with fixes`;
  `src/rune/domain/business/rune-parse/test.ts` —
  `REQ-021: [CTR] is retired with a fix; [NEW] stays`,
  `REQ-021: [TYP:from=path] and \`[TYP] x: Class\` are retired with fixes`;
  `lang/cli/src/commands/format.rs` — `req_021_ctr_is_rewritten_to_new`
- integration: the corpus gate (`invalid/ctr-retired.rune`, `class-retired.rune`,
  `from-path-retired.rune`, `ret-redundant.rune`)
- e2e: n/a — a language rule, no page

## REQ-022 — codegen partitions methods by step kind

> Phase 2, item 2.5. — Raphael, 2026-10-15

The business class carries a noun's untagged-step methods only; the data
adapter its boundary-step methods only (`collectNounMethods(ast, kind)`).

- unit: `src/rune/domain/business/rune-manifest/test.ts` —
  `REQ-022: the business class carries only untagged-step methods and the adapter only boundary-step methods`
- integration: the L3 manifest goldens (`fixtures/golden/manifest/*.json`, recaptured and reviewed)
- e2e: n/a — codegen, no page

## REQ-023 — the prose rules are lints

> Phase 2, item 2.6. — Raphael, 2026-10-15

`unbound-input-needs-example` (a required input field no earlier endpoint
produces and no `example=` seeds; `[TYP:ext]` exempt), `edit-record-endpoint`
(PUT/PATCH), `reserved-verb` (error — the verb names a generated function),
`duplicate-req-signature` (error). The spec-author agent's prose shrinks to the
loop.

- unit: `src/rune/domain/business/rune-checks/test.ts` — `REQ-023: the four prose rules are lints with ids`
- integration: the corpus gate (`invalid/unbound-input-needs-example.rune`,
  `edit-record-endpoint.rune`, `reserved-verb.rune`, `duplicate-req-signature.rune`)
- e2e: n/a — a language rule, no page

## REQ-024 — the undocumented is documented: `name?`, `tag(s?)`, quoted string enums, `[DTO:open]`

> Phase 2, item 2.7. — Raphael, 2026-10-15

Decided and documented from the registry's tag summaries: optional properties
(`name?`), lenient arrays (`tag(s?)`), string enums as QUOTED unions
(`"a" | "b"` — the one form; a bare-word union is an `undefined-ref`), and
`[DTO:open]`.

- unit: `scripts/gen-lang-docs.test.ts` —
  `REQ-024: the generated reference documents \`?\`, \`(s?)\`, string enums and [DTO:open] from the registry`
- integration/e2e: n/a — docs generated from the registry; the enum rendering is covered by the manifest's enum test

## REQ-025 — the tables live in `lang/keywords.json` and the engine loads them

> Phase 3, item 3.1. — Raphael, 2026-10-15

Modifiers with their full spec (kind, base, param, values, decorator, call,
eachCall), transports, the fault vocabulary, the indent table, the column limit
and the builtins are registry sections (schema 2.0.0); the engine reads them
through `src/rune/domain/business/registry/mod.ts` (validated at startup). The
TS `rune-modifiers` table, the LSP's and Rust parser's copies and the studio's
copies are deleted.

- unit: `src/rune/domain/business/artifact/test.ts` —
  `REQ-025: the engine's modifier, transport, fault and indent tables are the registry's`
- integration: the L1 and L7 gates (`deno run -A scripts/verify.ts`)
- e2e: n/a — data, no page

## REQ-026 — the rule catalogue is the registry's, hardened

> Phase 3, item 3.2. — Raphael, 2026-10-15

Every spec lint entry is a shape rule fully specified by `type` + `params`
(`max-line-length`, `tag-indent`, `name-suffix`, `required-description`,
`unique-names`, `unused`) or names a `checker` the engine implements (its id);
every entry carries `message`, `fix` where the rule can say so, and `doc`. The
engine renders every finding from the registry's template — no message lives in
code. A test asserts engine implementations ↔ registry ids in both directions.
The prose-only `rules: []` strings on tags are folded into `summary`.

- unit: `src/rune/domain/business/artifact/test.ts` —
  `REQ-026: every spec lint names a checker the engine implements and every engine checker is a registry lint`
- integration: the L1 gate
- e2e: n/a — data, no page

## REQ-027 — stale registry content removed

> Phase 3, item 3.3. — Raphael, 2026-10-15

`boundaries.prefixes` and every `new/generate.mjs` / `new/keywords.json`
reference are gone from the registry and the generated grammar headers.

- unit: `src/rune/domain/business/artifact/test.ts` —
  `REQ-027: the registry carries no boundary prefixes and no new/generate.mjs reference, and neither do the generated grammar headers`
- integration/e2e: n/a — data

## REQ-028 — the doc tables are generated between markers; `example.rune` is in the valid corpus

> Phase 3, item 3.4. — Raphael, 2026-10-15

`scripts/gen-lang-docs.ts` renders the tag, modifier, transport, fault, indent
and rule tables between `<!-- rune:gen … -->` markers in `lang/docs/spec.md`
and `lang/docs/constraints.md`; the Drift gate regenerates and diffs them.
`lang/docs/example.rune` checks clean and is the corpus' `example-e2e.rune`.

- unit: `scripts/gen-lang-docs.test.ts` —
  `REQ-028: the doc tables between the markers are the registry's and example.rune checks clean`
- integration: the Drift gate
- e2e: n/a — docs

## REQ-029 — the LLM language card

> Phase 3, item 3.5. — Raphael, 2026-10-15

`lang/docs/card.md` (generated): grammar by example (every valid corpus spec),
the tables, the rule catalogue with messages and fixes, and every invalid
fixture rendered as an error → fix pair (what `rune check` really reports).
`scripts/sync-spec-skill-refs.ts` ships the card and the cookbook into the
`rune:spec` skill instead of `spec.md` + `constraints.md`; the agent and the
skill read the card. Cost: the card is 8,168 words; `spec.md` + `constraints.md`
were ~9,300. The llmify quiz harness is not in this repo or the box, so the
correctness half is not proven here (`n/a` in `.wt/acceptance.md`).

- unit: `scripts/gen-lang-docs.test.ts` —
  `REQ-029: the card carries the valid corpus, the tables, every rule and every invalid fixture as an error → fix pair, and the skill ships it`
- integration: the Drift gate; `deno task check:spec-refs`
- e2e: n/a — docs

## REQ-030 — `rune check --explain <id>`

> Phase 3, item 3.6. — Raphael, 2026-10-15

Prints the registry's entry for a rule: id, severity, message, fix and doc; an
unknown id is a usage error listing the rules.

- integration: `src/rune/entrypoints/check/test.ts` —
  `REQ-030: runCheck --explain prints the registry doc for a rule id`
- unit/e2e: n/a — a CLI command over the registry module (REQ-025's test covers the module)

## REQ-031 — the engine parses through the grammar wasm

> Phase 4, item 4.1 (D4: tree-sitter everywhere; ADR 0009 supersedes 0003). — Raphael, 2026-10-15

`src/rune/domain/business/rune-parse/mod.ts` is a CST → AST lowering over
`lang/grammar/rune.wasm` (web-tree-sitter in Deno, loaded at startup; `deno
compile --include`s it). The grammar gained the fault marker, `as` value
names, `[MOD] name: prose`, kebab module names, an optional return clause,
multi-line parameters and quoted enums; the studio and the Rust side read the
same grammar. The 1,263-line hand parser is deleted.

- unit: `src/rune/domain/business/rune-parse/test.ts` —
  `REQ-031: the engine parses through the grammar wasm and the valid corpus lowers with no findings`
  (and the whole file)
- integration: the corpus, L0 and L2 gates
- e2e: n/a — a parser

## REQ-032 — the Rust side links the generated parser; `lang/parser` is deleted

> Phase 4, item 4.2. — Raphael, 2026-10-15

`lang/grammar` is the `tree-sitter-rune` crate; `rune-lsp` (hover, definitions,
references, completions from the registry and the document) and `rune-syntax
format` (over the CST, with the REQ-018/021 migrations) link it.
`lang/parser/src/lib.rs`, the dead `analyzer` module and the `validate`
subcommand (a second checker) are deleted.

- unit: `lang/lsp/src/main.rs` —
  `req_032_hover_and_definitions_come_from_the_tree_sitter_cst`,
  `req_032_completions_come_from_the_registry_and_the_document`;
  `lang/cli/src/commands/format.rs` — `req_032_value_names_and_statuses_round_trip`
  (`cargo test` from `lang/`; CI runs no cargo — run it by hand)
- integration: `lang/cli/tests/format_cli.rs`
- e2e: n/a — an editor protocol and a CLI

## REQ-033 — scanner constants are generated from the registry's indent table

> Phase 4, item 4.3. — Raphael, 2026-10-15

`scripts/generate.mjs` writes `lang/grammar/src/scanner-config.h` from the
registry's indent table and fault marker; the scanner includes it and keeps no
literal of its own (a tab is one indent unit; a line opening with the marker is
never prose). The installer embeds the header for the neovim parser build.

- unit: `scripts/gen-lang-docs.test.ts` —
  `REQ-033: scanner-config.h is generated from the registry's indent table`
- integration: the Drift and grammar gates
- e2e: n/a — generated C

## REQ-034 — malformed lines yield id'd findings by shape

> Phase 4, item 4.4. — Raphael, 2026-10-15

A line the grammar rejects is parsed on its own (an ERROR never hides the
lines after it) and mapped to a registry rule by its shape: the tag it opens
with → that tag's `shapeRule` with the tag's syntax in the message (`[REQ]` /
`[DTO]` modifiers checked first), a retired tag, a bare fault line, else
`unrecognized-line`.

- unit: `src/rune/domain/business/rune-parse/test.ts` —
  `REQ-034: a malformed line yields an id'd finding from its shape`
- integration: the corpus gate (every `invalid/*-shape` fixture)
- e2e: n/a — a parser

## REQ-035 — the studio parses and checks through the engine

> Phase 4, item 4.5 (closes gaps.md G6/G9 for parse and lint). — Raphael, 2026-10-15

`rune-studio/lib/engine.ts` is the studio's one door into the engine — check
(the wasm parse + the checks), generate, and the generated-code rules run in
memory over the engine's own output; `/api/check` serves it to the island.
`lib/parse.ts`, `lib/lint.ts` and the `generate-core.ts` copy are deleted; the
studio imports `scripts/generate-core.mjs`.

- unit: `rune-studio/tests/studio_test.ts` —
  `REQ-035: the studio parses and checks through the engine` (`cd rune-studio && deno task test`)
- integration: the L5 gate
- e2e: n/a — the studio's dev server is not the gate's serve task

## REQ-029 — AMENDMENT: the install manifest ships what the skill ships

> Judge finding on the first `wt-ready` run, 2026-10-16: `claude/skills/MANIFEST.txt`
> (the file list `install.sh` falls back to) still named the retired `spec.md`
> and `constraints.md` and omitted `card.md`.

`scripts/sync-spec-skill-refs.ts` now writes `claude/skills/MANIFEST.txt` from
the skills tree (and `--check` diffs it), so the manifest can never name a
reference that no longer ships. The generated-code runtime contract (the
`#assert` seams and the `RuneFault` classes) moved from `lang/docs/constraints.md`
to `claude/skills/rune:framework/references/endpoints.md`, which is installed;
the sixteen agents that cited it point there.

- unit: `scripts/gen-lang-docs.test.ts` — the `REQ-029` test also asserts the
  shipped cookbook matches its source and the manifest ships the card, names no
  retired reference, and names only files that exist
- integration: the Drift gate; `deno task check:spec-refs`
- e2e: n/a — docs

## REQ-041 — the tracked hooks are branch-model's current copies

> Raphael, 2026-10-17: "merge all wip in develop" — the develop checkout
> carried an uncommitted regeneration of `.githooks/pre-commit` and
> `.githooks/pre-merge-commit` written by `branch-model` (REQ-139): the lane
> names `/wt:new` → `/wt:merge` replace the retired `/worktree` commands, and
> the deploy lane falls back main → master when `branch-model.deploy-branch`
> is unset. Landed through a worktree, as trunk takes no direct edits.

- unit: `scripts/githooks.test.ts` — `REQ-041: the hooks name the wt:new /
  wt:merge flow, never the retired /worktree commands`; `REQ-041: the deploy
  lane falls back main → master when branch-model.deploy-branch is unset`
- integration: n/a — two shell hooks read as text; nothing composes them
- e2e: n/a — no page; the hooks run inside git
