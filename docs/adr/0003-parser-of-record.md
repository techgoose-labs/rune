# ADR 0003 — Parser of record: generated TS parser; tree-sitter editor-only (D2)

Status: **Superseded by [ADR 0009](./0009-tree-sitter-everywhere.md)** (2026-10-16) · Closed the decision behind G6

## Context

There are four parse definitions today (Rust `parser/src/lib.rs`, shape-checker
`rune-parse/mod.ts`, Studio `lib/parse.ts`, and the tree-sitter `grammar.js`),
all hand-maintained in parallel. A tree-sitter grammar must be **compiled**
(tree-sitter CLI → C → native/WASM) before it parses anything — a browser-only
low-code UI cannot run that toolchain. And nothing in the engine's
parse→codegen→lint path uses tree-sitter at all; its only consumer is
third-party editors. We must pick one parser of record.

## Decision

**The engine parses with a TS parser generated from the artifact's
`language.tags` table.** Adding/removing a tag in the artifact changes engine
parsing with no parser hand-edit. **tree-sitter is editor-only**, generated from
the same artifact and compiled to WASM out-of-band (WO-6); it never sits on the
engine's hot path.

## Consequences

- WO-4c generates the engine parser from `language.tags`, replacing the
  hand-maintained tag handling in `rune-parse/mod.ts` (gate L2).
- The artifact's tag table is the single source for both the engine parser and
  the tree-sitter grammar, so they cannot drift.
- WO-6 stands up the WASM build; the UI consumes pre-built WASM, never compiles.
</content>
