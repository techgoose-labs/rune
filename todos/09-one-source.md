# Task 09 — One source, one parser, one checker, LLM-first (roadmap)

Repo: **rune**. Read `00-context.md` first. Unlike 01–08 this is a **multi-phase
roadmap**, not one dispatchable task: each checkbox below becomes its own
worktree with a `REQ-NNN` (from `req-next`) and tests when it starts. Phase 1
needs no language change; Phase 2 changes the DSL (each item ships a `rune fmt`
migration); Phase 3 makes the registry the only source; Phase 4 deletes the last
duplicate parser. Dispatch in that order.

## Principles

1. **Each fact lives in exactly one place.** Tables in the registry, algorithms in
   one checker, semantics pinned by the corpus. Everything else is generated.
2. **The LSP is the LLM's channel.** Claude Code pushes LSP diagnostics after
   every edit, so the LSP must say exactly what `rune check` says, with the same
   rule ids. `rune check` is the gate; the LSP is the loop.
3. **Every line declares its kind by its first token.** Indentation is
   presentation, owned by `rune fmt`, never a source of meaning.
4. **One form per concept.** No synonyms, no implicit links, no parallel
   mechanisms.
5. **Every rule the agent is told in prose becomes a lint with an id.** The agent
   definition shrinks to the loop.

## Evidence this is needed (current state)

- Three hand-written parsers for one grammar: `src/rune/domain/business/rune-parse/mod.ts`
  (1224 lines), `lang/parser/src/lib.rs` (1374), `lang/grammar/src/scanner.c` (175),
  plus the generated `grammar.js`. Nothing in the engine or LSP consumes the
  compiled grammar (`rune-studio/gaps.md` G6).
- Two checkers that disagree: the LSP rejects a step at indent 2
  (`lang/lsp/src/main.rs:419`), the engine classifies by threshold
  (`rune-parse/mod.ts:347,759`). The engine enforces `rune-service-core-only`;
  the LSP checks presence only.
- Spec rules are policy without logic: the registry declares `tag-indent`,
  `signature-consistency`, `noun-in-scope`, `param-scope`, `undefined-ref` as
  enabled errors/warnings; no engine code references those ids
  (`lint-config/mod.ts` bridges generated-code rules only; `todos/08`).
- The "valid" corpus violates documented scope: `fixtures/corpus/valid/all-tags.rune`
  ends with `[RET] ReceiptDto` and no step produced one.
- The modifier allowlist is defined in 5 code sites + 5 docs; the transport set
  in 3 code sites + docs; the registry carries transports only as prose.
- Corpus parity asserts only "valid → 0 diagnostics, invalid → ≥1"; no expected
  messages. Two checkers can disagree on *which* error and both pass.
- Codegen hands one method list per noun to both the business class and the
  adapter (`rune-manifest/mod.ts:175,512,523`): `examples/todos` business `Task`
  has `save`/`load`; the adapter `Task` has `fill`/`toDto`/`markDone`.
- Docs drift: `constraints.md` says any `[REQ:x]` is rejected (parser accepts
  `:open`); says `[SRV]` lives in the same spec (core-only rule rejects that);
  `keywords.json` still lists the six retired boundary prefixes and references
  `new/generate.mjs` (lives at `scripts/generate.mjs`); `lang/docs/example.rune`
  uses a noun-less REQ, a `woof` fault, `MetadataDto?` and a string enum, none
  documented.
- The spec-author agent reads ~9,300 words of hand-written, mutually
  contradictory reference and loops on untyped string errors.
- No Claude Code LSP plugin exists for `.rune`; the installer targets six editors.

---

## Phase 1 — One checker, one channel (no language change)

- [ ] **1.1 `rune check --json`.** Stable output: `{ id, severity, line, col,
      message, fix }` per finding, ids = registry lint ids. Add `--stdin
      --path <file>` so a buffer can be checked with correct root/core
      resolution. Text output unchanged but prefixed with the id.
- [ ] **1.2 LSP diagnostics come from the checker.** On didChange (debounced) the
      LSP runs `rune check --json --stdin --path` and publishes the result.
      Delete `compute_diagnostics` and `check_sig` / `validate_typ_modifiers`
      ports in `lang/lsp/src/main.rs`. Hover/defs/completions keep the Rust parse
      for now (Phase 4 replaces it).
- [ ] **1.3 Corpus sidecars + exact parity gate.** `fixtures/corpus/invalid/<name>.diag.json`
      lists expected `{id, line}`; valid fixtures assert empty. `scripts/verify.ts`
      gate diffs the exact list for engine, LSP (via the binary path), and studio.
      Fix `all-tags.rune` (or move it to invalid) once scope is enforced (2.3).
- [ ] **1.4 Claude Code code-intelligence plugin.** `claude/plugin/.lsp.json`
      mapping `.rune` → `rune-lsp`; `scripts/install.sh` / `rune update` install
      or register it (`--plugin-dir` or marketplace). Document: cloud sessions
      don't start plugin LSPs; boxes need `rune-lsp` on PATH.
- [ ] **1.5 Agent loop rewrite.** `claude/agents/rune-spec-author.md`: write →
      read pushed diagnostics → fix → `rune fmt` → final `rune check` gate.
      Remove prose rules that become lints (2.6).

## Phase 2 — DSL changes (each ships with a `rune fmt` migration)

- [ ] **2.1 Fault marker + fault vocabulary.** Faults are `! name name` under a
      step; indent becomes cosmetic. Registry table of well-known faults with
      HTTP status (`not-found` 404, `conflict` 409, `timeout` 504, `unavailable`
      503, `declined` 402, `unauthorized` 401, `forbidden` 403, `invalid-*` 422);
      custom faults carry a status (`! card-expired=402`). Codegen emits typed
      fault classes; the runtime maps them. `rune fmt` rewrites old bare faults
      to the marked form. `[DECIDE]` the glyph — default `!`.
- [ ] **2.2 Explicit-only `[ENT]` → `[REQ]` link.** The indented `[REQ]` body
      line is required; signature matching and its ambiguity error are removed.
- [ ] **2.3 Value model + scope enforcement.** One live value per type per REQ,
      enforced; a second value of the same type must be named (`[DECIDE]` syntax,
      default `: TaskDto as loaded`). Port `noun-in-scope`, `param-scope`,
      `undefined-ref`, `signature-consistency`, `last-step-returns-output` into
      the engine keyed by registry ids (closes `todos/08`). `[RET]` takes a value
      name, resolved through the same scope.
- [ ] **2.4 Retire duplicates.** Drop `[CTR]`. Keep `[NON]`, drop `Class` as a
      `[TYP]` primitive. Lint redundant `[RET]` after a step that already returns
      the output. `[DECIDE]` path binding: keep `@ METHOD /template` on `[ENT]`
      and drop `[TYP:from=path|path*]` (recommended; query/header `from=` stay).
- [ ] **2.5 Codegen partition by step kind.** Business class gets untagged-step
      methods only; adapter gets boundary-step methods only. No DSL change.
- [ ] **2.6 Prose rules → lints.** `unbound-input-needs-example` (a required
      input field with no producer, bind, or `example=`), `edit-record-endpoint`
      (PUT/PATCH on a record = waist-rule violation, warning), `reserved-verb`,
      `duplicate-req-signature`, `srv-outside-core` already exists.
- [ ] **2.7 Doc the undocumented.** Decide and document or reject: optional `?`
      on DTO props, string enums in `[TYP]`, `[DTO:open]`.

## Phase 3 — The registry is the single source

- [ ] **3.1 Tables into `lang/keywords.json`.** Modifiers with full spec (base,
      value kind, closed set, decorator, each-form), transports, fault vocabulary,
      indent table (incl. "fault is N deeper than step"), column limit, builtins.
      Engine loads them at runtime (it already loads the artifact). Delete the
      TS `rune-modifiers` table, the LSP and Rust-parser copies, the studio copy.
- [ ] **3.2 Registry schema hardening.** Every `lint` entry is either a shape
      rule fully specified by params or names a `checker` id. A startup/CI test
      asserts engine implementations ↔ registry ids, both directions. Prose-only
      `rules: []` strings on tags move to `summary` or become real rules.
- [ ] **3.3 Remove stale registry content.** `boundaries.prefixes`, the
      `new/generate.mjs` references (registry description, `grammar.js` and
      `highlights.scm` headers).
- [ ] **3.4 Generated doc tables.** Tags, modifiers, transports, faults, indent,
      rule catalogue rendered between markers in `lang/docs/spec.md` and
      `constraints.md` by a `scripts/gen-lang-docs.ts`; the drift gate diffs.
      Make `lang/docs/example.rune` check-clean and part of the valid corpus.
- [ ] **3.5 Generated LLM language card.** One file: grammar by example (valid
      corpus), the tables, the rule catalogue with messages and fixes, the
      invalid corpus rendered as error → fix pairs. `sync-spec-skill-refs.ts`
      ships the card instead of `spec.md` + `constraints.md`; `cookbook.md`
      stays hand-written. Prove cost/correctness with the llmify quiz harness.
- [ ] **3.6 `rune check --explain <id>`** prints the registry's doc for a rule.

## Phase 4 — One parser of record

`[DECIDE]` tree-sitter everywhere (recommended) vs. TS hand-written parser as
record with tree-sitter editor-only.

- [ ] **4.1 Engine parses via `lang/grammar/rune.wasm`** (web-tree-sitter in
      Deno); `rune-parse/mod.ts` becomes a CST → AST lowering keyed by tag ids.
- [ ] **4.2 Rust side links the generated `parser.c`** for `rune fmt`, hover,
      defs; delete `lang/parser/src/lib.rs`.
- [ ] **4.3 Scanner constants generated** from the registry's indent table.
- [ ] **4.4 Error reporting over ERROR/MISSING nodes** with per-line-shape
      messages from the registry, so malformed drafts still yield id'd diagnostics.
- [ ] **4.5 Studio parses with the same wasm** (closes gaps.md G6/G9 for parse).

## Order

Phase 1 → 2 → 3 → 4. Phase 1 needs no language change and makes the LSP the
LLM's channel; Phase 2 fixes what the LLM gets wrong; Phase 3 makes the docs
unable to lie; Phase 4 deletes the last duplicate. Each phase lands as its own
worktree(s) with `requirements.md` entries and the four gate lanes green.

## Open decisions

| # | Decision | Recommended default |
|---|----------|---------------------|
| D1 | Fault marker glyph | `!` |
| D2 | Named-value syntax when two values share a type | `: TaskDto as loaded` |
| D3 | Path binding: `@ METHOD /template` vs `[TYP:from=path]` | keep the template, drop `from=path` |
| D4 | Parser of record | tree-sitter everywhere |
| D5 | `[NON]` vs `[TYP] x: Class` | `[NON]` |
| D6 | Plugin distribution: marketplace vs `--plugin-dir` from the install dir | install dir + `--plugin-dir`, marketplace later |
