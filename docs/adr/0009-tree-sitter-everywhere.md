# ADR 0009 — Parser of record: tree-sitter everywhere (supersedes 0003)

Status: **Accepted** · REQ-031 / REQ-032 / REQ-033 / REQ-034 · Supersedes ADR 0003

## Context

ADR 0003 chose a TS parser generated from the artifact's tag table for the
engine and left tree-sitter editor-only. In practice the engine's parser stayed
hand-written (`rune-parse/mod.ts`, 1,263 lines), the Rust side kept a second
hand-written parser (`lang/parser/src/lib.rs`, 1,374 lines) for the LSP and
`rune fmt`, the studio a third, and the tree-sitter grammar a fourth definition
that nothing in the engine consumed. They disagreed — the LSP rejected a step
at indent 2 the engine accepted; the engine enforced a rule the LSP only
checked for presence — and the corpus could not pin which error a tool gave.

## Decision

**The grammar built from `lang/keywords.json` is the one parser of record.**

- The engine parses through `lang/grammar/rune.wasm` (web-tree-sitter in
  Deno); `rune-parse/mod.ts` is a CST → AST lowering keyed by the tag ids, and
  a line the grammar rejects maps by its shape to the registry's per-shape rule
  (`tags[].shapeRule`), so a malformed draft still yields id'd findings.
- The Rust binaries (`rune-lsp` for hover, definitions, references and
  completions; `rune-syntax` for `rune fmt`) link the generated `parser.c`
  through the `tree-sitter-rune` crate. `lang/parser` is deleted.
- The external scanner's constants come from the registry's indent table
  (`src/scanner-config.h`, generated).
- The studio calls the engine (server-side) for parsing and linting and
  carries no parser of its own.
- `rune.wasm` is tracked; `scripts/build-grammar.ts` rebuilds it (tree-sitter
  CLI + emscripten) and the `grammar` gate verifies the build.

Every line declares its kind by its first token; indentation is presentation
owned by `rune fmt`, and only nesting is relative (a body line sits deeper than
its opener).

## Consequences

- One grammar, one lowering, one checker: the LSP's diagnostics are
  `rune check --json`, the studio's are the same findings, and the corpus
  sidecars pin them exactly (REQ-014).
- Adding a tag or a modifier changes the grammar, the highlights, the scanner
  config, the docs and the card from one edit of the registry; the wasm must be
  rebuilt (a toolchain step, verified by the gate), never hand-edited.
- The engine needs the wasm at runtime: `deno compile --include
  lang/grammar/rune.wasm`, and the studio's server does the parsing.
