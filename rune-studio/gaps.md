# Gaps: UI-authored artifacts → engine-consumed pipeline

_What we want vs. what exists today. Audited 2026-05-27._

> **2026-10-16 (REQ-031/035):** G6 and G9 are closed for parse and lint. The
> grammar built from the registry is the one parser of record (ADR 0009): the
> engine parses through `lang/grammar/rune.wasm`, the Rust binaries link the
> generated `parser.c`, and the studio carries no parser or linter of its own —
> `lib/engine.ts` calls the engine, served by `/api/check`.

## The target

A low-code product where **the Studio UI is the only authoring surface for the
Rune language**. Editing Rune (tags, grammar, codegen, lint) happens in the UI
and emits three artifact families:

1. **tree-sitter** — `grammar.js` + `highlights.scm` (parsing + editor colour)
2. **lint** — the rule set (spec-lint + output-lint)
3. **generation** — per-construct codegen templates + the expected file shape

A single **engine consumes those artifacts** to produce output (scaffolded
code + lint diagnostics). The engine has **no language knowledge of its own** —
it is a pure interpreter of the artifacts. Change the artifacts in the UI →
the engine's behaviour changes, with no recompile.

```
        ┌──────────── Studio UI (authoring) ────────────┐
        │  edit tags / grammar / codegen / lint rules     │
        └───────────────────┬────────────────────────────┘
                            ▼ emits
        ┌──────── artifacts (the only source of truth) ───┐
        │  grammar.js + highlights.scm │ lint rules │ codegen │
        └───────────────────┬────────────────────────────┘
                            ▼ consumed by
        ┌──────────────── one engine (interpreter) ───────┐
        │  parse → scaffold → lint, all driven by artifacts │
        └───────────────────┬────────────────────────────┘
                            ▼
                  output: code + diagnostics
```

## What's actually true today

**The Studio behaves as a simulator, not an authoring surface.** Its `lib/*`
modules read `data/keywords.json` and produce **in-browser previews**. It _can_
reach a real engine — `lib/runegen.ts` spawns the compiled Rust binary
(`Deno.Command … rune generate … -o tmp`) — but it feeds that binary a `.rune`
spec plus a **hardcoded** `CONFIG = "ts-deno-native-class-validator-esm"`
(`runegen.ts:5`), **never the edited artifact**. **No engine reads
`keywords.json`** — `grep -rln keywords.json src/` returns nothing. Each engine
carries its own hardcoded copy of every concern, so editing Rune in the UI
changes the preview and nothing the engine actually does.

Each concern is implemented **multiple times, sharing no code**:

| Concern | Implementations today | Artifact-driven? |
| --- | --- | --- |
| **Parse** (text→AST) | 4 definitions: 3 hand-written parsers — Rust `rune/parser/src/lib.rs`, shape-checker `src/shape-checker/domain/business/rune-parse/mod.ts` ("Mirrors rune/parser/src/lib.rs"), studio `lib/parse.ts` (337 L) — plus 1 tree-sitter grammar `rune/grammar/grammar.js` (editor-only; see G6) | No — hand-maintained in parallel |
| **Codegen** (AST→files) | 3: Rust `rune/cli/src/commands/generate.rs` + `cli/src/configs/ts_deno_native_class_validator_esm/*.rs` (layout built with `format!`); shape-checker `rune-manifest/mod.ts` + `assets/canonical-paths.json` + hardcoded `rune-bindings/mod.ts`; studio `lib/render.ts` (353 L) reading the registry's `codegen` templates | Only the studio preview |
| **Lint** | 3: Rust LSP (~40 diagnostics); shape-checker 23 TS rule modules registered by a hardcoded import list in `src/shape-checker/mod-root.ts`; studio `lib/lint.ts` (994 L) | Only the studio preview |
| **tree-sitter gen** | `lib/generate-core.ts` (289 L) and `rune/new/generate.mjs` emit `grammar.js`+`highlights.scm` from the registry | Partially — see G6 |

The three codegen implementations produce **three different layouts**: Rust →
`dto/ pure/ impure/ integration/`; shape-checker & studio templates →
`src/<module>/domain/{coordinators,business,data}/`. They cannot agree, yet
`lib/runegen.ts:1` calls the Rust binary "the single source of truth for code
generation" and the README offers a "compare your templates against the real
CLI" button — a diff of incompatible layouts.

---

## Gaps

### G1 — No artifact→engine flow at all _(blocker)_
The premise of the product (UI emits artifacts, engine consumes them) does not
exist. `keywords.json` is read only by the studio's own preview code. The Rust
binary consumes compiled-in Rust modules (`cli/src/configs/.../*.rs`);
shape-checker consumes `canonical-paths.json` + hardcoded TS. **Nothing the UI
edits reaches a real engine.** Until an engine reads the artifact, "low-code
language editing" is a sandbox demo.

### G2 — No shared interpreter; every concern is reimplemented _(blocker)_
4 parsers, 3 codegens, 3 linters (table above). Even if all read the same
artifact tomorrow, behaviour would still diverge because the *code* differs.
The target needs **one interpreter** for parse/codegen/lint that both the
engine and the Studio preview call — otherwise "what you see in the UI" never
provably equals "what the engine emits" (see G9).

### G3 — Lint is a closed checker library *configured* by data, not *defined* by data _(major)_
`data/keywords.json`'s `lint` entries are parameter bags (`"params": {}`) keyed
to a fixed `type` vocabulary (~32 types: `layer-restrictions`,
`barrel-discipline`, `module-isolation`, `no-relative-import`, …). The logic
for each `type` is hardcoded in `lib/lint.ts` via `GEN_CHECKERS[rule.type]`
(`lib/lint.ts:625,653,770,942-952`). So from the UI a user can toggle
`enabled`, tweak `severity`/`message`/`params.max` — **but cannot author a new
check.** New rule logic still means writing TypeScript (and writing it twice:
once in `lib/lint.ts`, once as a shape-checker rule module). Real rules carry
arbitrary AST/regex logic (`layer-restrictions` is 95 L,
`barrel-discipline` 40 L) plus `systemPrompt`/`buildPrompt` fields. **Decision
needed:** a declarative rule DSL covering most rules + a code escape-hatch for
the rest, or accept that lint authoring stays code.

### G4 — Codegen templates can't express derived / cross-cutting output _(major)_
`lib/render.ts` is a per-construct Mustache subset: one construct → its
files. But real generation needs outputs that aren't 1:1 with a construct:
- **purity split** — a noun is `pure/` vs `impure/` based on whether *any*
  step crosses a boundary (`rune/cli/src/analyzer/nouns.rs`); templates use an
  `isImpure` flag but the classification itself is engine logic, not data.
- **aggregated files** — `dto/_shared.ts` collects across all DTOs;
  `mod-root.ts` barrels the public API. No template owns these.
- **DTO→validation schema** generation (class-validator / Zod) from `[DTO]`
  properties.
- **idempotency & lifecycle** — "skip if the file exists anywhere in the
  project" (`generate.rs:41`), plus `sync`/`prune` of orphans. These are engine
  behaviours, not expressible in a path+body template.

### G5 — File layout is defined in two places _(major)_
The expected shape lives both in `assets/canonical-paths.json` (consumed by
shape-checker's `structure` rule and `rune-manifest`) **and** in the codegen
path templates in `keywords.json`. `MERGE.md` proposes the path templates
*become* the expected shape ("presence guaranteed by generation"), but that
isn't built, and it would drop the `$forbiddenDirNames` / `$looseFileNames` /
optional-file (`?`) semantics canonical-paths encodes. Single-source this:
either generate canonical-paths from the artifact, or derive both from one
schema.

### G6 — tree-sitter can be emitted but not *used* by the engine, and can't be compiled in-UI _(major)_
- `generate-core.ts` emits `grammar.js`/`highlights.scm`, but a tree-sitter
  grammar must be **compiled** (tree-sitter CLI → C → native/WASM) before it
  parses anything. A browser-only low-code UI can't run that toolchain → needs
  a server-side/build step or a WASM tree-sitter build pipeline.
- **Nothing in the parse→codegen→lint path uses tree-sitter.** shape-checker
  uses its hand-port (`rune-parse/mod.ts`); the Rust binary uses
  `parser/src/lib.rs`. The grammar's only consumer is **third-party editors**
  (Neovim/VS Code), to which it is shipped by `rune/cli/src/commands/install.rs`
  — `tree-sitter`/`tree_sitter` appears nowhere else in `cli/` or `lsp/`. So a
  freshly generated grammar only recolours external editors, never engine
  parsing. **Decision needed:** make the engine parse via the
  generated grammar (compiled tree-sitter, or an interpreted grammar), or keep
  tree-sitter editor-only and generate the engine parser from the same artifact
  by another route — but pick one parser of record.

### G7 — Two engines; one is compiled and can't be made artifact-driven _(decision)_
The Rust binary's codegen is Rust source (`configs/.../*.rs`) — it can never be
"edited in a UI." `new-product.md` already frames the product as shape-checker
(CLI-only, no LLM), and `design.md` is explicit: "port `rune/parser/src/lib.rs`
to TypeScript… Drop the Rust parser from the runtime path. Keep the Rust LSP
available for editor squiggles only — not part of this product." **Commit to
that:**
shape-checker (TS) is the single artifact-driven engine; retire the Rust binary
from the generation path (and stop the runegen.ts "compare against real CLI"
flow, which currently diffs the wrong layout). Otherwise every artifact change
must be mirrored into Rust by hand.

### G8 — No artifact contract, meta-validation, or versioning _(major)_
- **No schema** defines what a valid artifact is. There are three competing
  copies already (`studio/data/keywords.json`, `rune/new/keywords.json`,
  `lib/catalog.ts` which calls itself "the authoritative catalog"). Editing the
  language in the UI with no schema invites inconsistent artifacts (e.g. a
  codegen template referencing a removed tag; `follows`/`indent` that
  contradict each other).
- **No meta-lint** validates the artifact itself before the engine trusts it.
- **No versioning/migration.** If users can change the language, specs written
  against v1 break under v2. There's no artifact version stamp and no migration
  path for existing `.rune` files or already-generated code.

### G9 — Studio preview ≠ engine output _(major)_
Because the preview (`lib/render.ts`, `lib/lint.ts`, `lib/parse.ts`) is
different code from any engine, the UI can show a green/clean result the engine
would reject, or generate files the engine wouldn't. For a low-code tool whose
whole value is "edit the language and see the effect," **WYSIWYG must be
guaranteed by sharing the interpreter** (G2), not approximated.

### G10 — Existing drift / stale docs _(debt to clear first)_
- Three registries disagree (`studio/data/keywords.json` has `[MOD]`/`[ENT]`
  and rewritten codegen paths; `rune/new/keywords.json` doesn't; `catalog.ts`
  is a separate hand list).
- Tag mismatch with the real shape-checker parser: `rune-parse/mod.ts:326`
  accepts `[CTR]`/`[NEW]` as synonyms (`[CTR]` is the spec spelling); the
  registry only has `[NEW]`. `:core` is only half-modelled.
- The registry's own `description` claims it drives only "grammar, highlighter,
  playground" — it omits codegen/lint/shape-checker.
- `README.md` describes an island `Studio.tsx`; the real island is
  `Reference.tsx`.

### G11 — "low-code users can edit the Rune language" conflates three audiences _(framing — resolve before building)_
The premise merges roles with very different skill and authority:
- **language designers** — edit tags, indentation, `follows`, codegen
  templates, lint rules. This is the artifact authoring the whole pipeline
  targets, and it is **expert work**: a bad indent rule or template silently
  breaks every spec and every generated tree.
- **spec authors** — write `.rune` files in a *fixed* language. This is what
  most "users" do day to day, and it's the only genuinely low-code activity.
- **body-fillers** — write implementations; explicitly outside the product.

"Low-code" here mostly means "no recompile," **not** "no expertise." Building a
UI that lets any user mutate the language is a different (and riskier) product
than one that lets users author specs against a curated language. The product
must state which audience the Studio serves; the gaps below are sized very
differently depending on the answer. _(Today the Studio mixes both: it presents
a spec editor AND a live language-registry editor on one page.)_

### G12 — Editable language erodes the enforcement guarantee; no governance model _(major)_
shape-checker's entire value is that it **enforces invariants** (layer
boundaries, module isolation, fault coverage). If lint rules, layout, and
codegen are user-editable in the UI, a user can weaken or disable the very
guardrails that make output trustworthy — and there is today **no notion of
core/locked vs tunable rules, no ownership, no team-level governance, no audit
of who changed the language**. A linter you can edit to make yourself pass is
not a linter. The artifact model needs a locked baseline (org-owned) layered
under project-level opt-in tuning, with provenance.

### G13 — "Edit the language" and "pick a codegen target" are conflated _(major)_
Codegen output depends on a **target profile** — language, runtime, validator
lib, module system. The Rust engine already treats this as a swappable axis:
`CONFIG = "ts-deno-native-class-validator-esm"` selects one of potentially many
`cli/src/configs/<profile>/` trees. But the Studio bakes these into the
registry as fixed singletons (`vars.runtime: "deno"`,
`vars.validatorLib: "class-validator"`) and ships exactly one set of templates.
A real artifact model must separate **the language** (tags, grammar, lint —
target-independent) from **per-target codegen profiles** (multiple, selectable),
or the UI will only ever describe one target and "editing the language" will
keep colliding with "switching stacks."

---

## Decisions required (block the design)

0. **Who is the user, and what may they edit?** Spec authors against a curated
   language, or language designers mutating it? This frames everything below.
   _(G11)_
1. **One engine?** Confirm shape-checker (TS) is the sole artifact-driven engine
   and the Rust binary is retired from generation (LSP-only). _(G7)_
2. **Parser of record?** Compiled tree-sitter (needs a build service) vs an
   interpreted grammar vs a generated TS parser — which one both the engine and
   editor use. _(G6)_
3. **Lint expressiveness?** Declarative rule DSL + code escape-hatch, vs keep
   lint as code. Determines how much of "edit lint" is truly low-code. _(G3)_
4. **Layout source of truth?** Codegen templates vs `canonical-paths.json` vs a
   new unified schema. _(G5)_
5. **Versioning policy** for the language + migration story for existing specs
   and generated code. _(G8)_
6. **Governance:** which rules/layout are org-locked vs project-tunable, and how
   changes are owned/audited. _(G12)_
7. **Artifact axes:** one target-independent language + N selectable codegen
   profiles, vs one baked target. _(G13)_

## Suggested sequencing

1. **Clear drift (G10):** collapse to one registry; generate `rune/new`,
   `catalog.ts`, and `studio/data` from it. Fix the README/description. (Cheap,
   unblocks trust.)
2. **Define the artifact contract (G8):** a versioned JSON schema for
   tags+grammar+codegen+lint, plus a meta-validator the engine runs on load.
3. **Make shape-checker an interpreter (G1, G2, G4):** replace
   `rune-manifest`'s hardcoded bindings and the canonical-paths layout with
   reads from the artifact; move purity/aggregation/idempotency into the
   interpreter, configured by the artifact. _(This is the bulk of the work, not
   a single step — it's effectively a rewrite of the generation core; scope it
   as its own project.)_
4. **Share the interpreter with the Studio (G9):** the preview imports the same
   parse/codegen/lint code the engine runs.
5. **Lint as data (G3):** introduce the rule model + escape-hatch; port the 23
   rules onto it.
6. **tree-sitter build (G6):** stand up a compile step (WASM) so the emitted
   grammar actually parses, or commit to the interpreted-grammar route.
7. **UI authoring affordances:** only now does "edit the language in the UI"
   produce real engine behaviour change end-to-end.
