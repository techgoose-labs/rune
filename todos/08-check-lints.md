# Task 08 — `rune check`: signature consistency across callers + step-arg resolution

Repo: **rune**. Read `00-context.md` first. Standalone — depends on none of 01–07.
Source: coms ticket 20260921T050158Z-w15-47057 (#rune, ppwk-crm, 2026-09-21), its
"also observed" half; the `rune fmt` half shipped as REQ-001/REQ-002 (`requirements.md`).

## Goal

Two spec checks that `lang/keywords.json` already declares but `rune check` (the TS
engine) never raises. Both confirmed on rune 7.0.1 against a `rune check`-clean spec
(`lang/cli/tests/fixtures/payments.rune`):

1. **signature-consistency** — declared as an error, "{key} has an inconsistent
   signature ({got} vs {first})". `card::toDto(cardId): CardDto` in one `[REQ]` and
   `card::toDto(cardId, pan): CardDto` in another → `OK — no errors`. The rule exists
   only in the editor: `check_sig` in `lang/lsp/src/main.rs` ("Inconsistent signature
   for '{key}': expected (…) -> … (from line N), got (…) -> …"). Port it to the engine
   so the CLI / CI gate sees it: same key (`noun.verb` / `Noun::verb`), first
   occurrence wins, an error.
2. **step-arg resolution** — declared as warnings `param-scope` ("parameter isn't in
   scope") and `undefined-ref` ("is not a defined [TYP], [DTO], [NON], or primitive").
   `ex:nmi.tokenise(bogus): cardId` with `bogus` declared nowhere → `OK — no errors`.
   Every step argument must resolve to a `[TYP]`/`[DTO]`/`[NON]` name, a field of the
   REQ's input DTO, or a value an earlier step of the same REQ returned. Today only DTO
   *properties* are checked (`[DTO] X: prop` → "property has no [TYP] or [DTO]").

## Files

- `src/rune/domain/business/rune-parse/mod.ts` — the AST already carries every step's
  noun / verb / params / output per REQ; nothing to add here.
- the check pass that emits `rune check`'s errors (locate it from the DTO-property
  message above) — add both rules there, keyed to their keywords.json ids so
  `enabled` / `severity` are honoured.
- `lang/cli/tests/fixtures/payments.rune` — a check-clean base to cut the red cases from.

## Verification

- unit tests in the check pass: the two snippets above go red with the declared
  messages; the fixture stays green.
- `rune check` over `examples/` and `e2e/` specs still exits 0 — no false positives; in
  particular a `[PLY]`'s cases legitimately share one signature.
- tick the README table row and answer on the ticket thread.
