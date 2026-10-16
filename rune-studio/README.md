# Rune Studio (Fresh 2)

The Rune playground rebuilt as a **Fresh 2** app (Deno + Preact + Vite). It
supersedes the static `../playground/` page.

A studio for _designing the Rune language_: edit keywords on the right, watch
the spec editor recolor live, and shape the code each keyword generates — all
from one source of truth. The hand-edited registry lives at
`../lang/keywords.json`; `data/keywords.json` is a generated copy bundled with the
studio (regenerate both, plus the grammar, with `deno run -A ../scripts/generate.mjs`).

## Run

```bash
cd new/studio
deno install          # first time (pulls CodeMirror etc. into node_modules)
deno task dev         # http://localhost:5173/
```

Code generation's "compare with rune binary" button needs the CLI built:

```bash
cargo build --release -p rune-cli     # from the repo root
```

## How it's wired

```
../lang/keywords.json  ← the single source of truth (registry, hand-edited)
        │  scripts/generate.mjs ▶ data/keywords.json (generated copy) + grammar + highlights
        ▼
data/keywords.json   ← the studio's bundled copy
        │  (read at request time in routes/index.tsx)
        ▼
   routes/index.tsx  ──serializable prop──▶  islands/Reference.tsx  (the whole tool)
                                                  │
        ┌────────────────────────┬────────────────┴───────────────┐
        ▼                        ▼                                 ▼
 lib/editor.ts             lib/parse.ts + lib/render.ts      routes/api/generate.ts
 CodeMirror, registry-      parse spec → model, render        shells out to the real
 driven highlight + lint    per-keyword templates (live)      `rune` binary (reference)
```

- **One island** (`Reference.tsx`, imported as `Studio` in `routes/index.tsx`)
  holds the editable registry and renders the editor + keyword panel + codegen.
  The route SSRs its shell.
- **Highlighting & linting** (`lib/editor.ts`) read the live registry, so
  keyword edits recolor/re-lint instantly.
- **Code generation** is template-driven: each keyword in the registry may carry
  `codegen: [{ path, body }]` templates (a tiny dependency-free Mustache subset
  in `lib/render.ts`). A keyword with no template emits nothing.
- **`/api/generate`** runs the compiled `rune` binary so you can diff the
  template output against the real CLI.

## Files

| Path                     | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `../lang/keywords.json`  | The single hand-edited registry (source of truth) — tags, modifiers, codegen, lint. |
| `lib/engine.ts`          | The one door into the engine: check (the grammar wasm + the checks), generate, lint. |
| `lib/editor.ts`          | CodeMirror setup: registry-driven highlighter.                                      |
| `../scripts/generate-core.mjs` | Registry → tree-sitter `grammar.js` / `highlights.scm` / `scanner-config.h` (shared). |
| `islands/Reference.tsx`  | The interactive studio (imported as `Studio` in `routes/index.tsx`).                |
| `routes/index.tsx`       | SSR shell; loads the registry.                                                      |
| `routes/api/check.ts`    | The engine, served: findings, generated files, generated-code lint (REQ-035).       |
| `routes/api/generate.ts` | The engine's generate.                                                              |

## Notes

- The dependency-free template engine replaced Handlebars: its CommonJS build
  crashes Vite's SSR module runner
  (`Cannot assign to read only property
  '__esModule'`). The mini-engine runs
  identically in SSR and the browser.
- `vite.config.ts` includes the always-full-reload dev plugin, and the registry
  is read at request time, so edits to code _and_ `keywords.json` reflect on
  save.
