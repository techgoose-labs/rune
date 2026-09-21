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
