# DX roadmap — orchestrator guide

This folder is a work plan designed for **agent dispatch**. You (the orchestrator) hand each
worker agent exactly two files and nothing else:

1. `00-context.md` — shared background (repos, conventions, hard rules). Every worker gets this.
2. `NN-<task>.md` — the one task they execute. Each is self-contained.

Workers need no other session history. Do not summarize the task files for them — give them the
full file contents verbatim.

## Dispatch order

Run tasks **sequentially in numeric order**. The only safe parallelization is `01` alongside
`02` (disjoint repos, disjoint files). Everything else conflicts:

| Task | Title | Repo(s) | Depends on |
| ---- | ----- | ------- | ---------- |
| 01 | Generated isolation seeds in the per-surface e2e | rune | — |
| 02 | Contract auto-wiring + `stub` metadata | keep | — |
| 03 | Ghost stub module generation + evaporation | rune | 02 |
| 04 | Lifecycle acceptance fixture | keep | 02 |
| 05 | `rune dev` — the live loop | keep then rune | 02 |
| 06 | System map at `/docs/_map` | keep | 02 (04 helps verification) |
| 07 | Docs, skill, cross-repo sweep, release order | both | all of the above |

Do **not** parallelize 03 with 05 (both edit rune `src/rune/entrypoints/sync/mod.ts`) or any of
04/05/06 with each other (all edit keep `emulator-ui/` and/or `bootstrap-server/`).

## Status tracking

After a worker reports completion, verify their Definition of Done yourself (each task file ends
with one — it contains runnable commands), then tick the task's row here:

- [x] 01 — isolation seeds
- [x] 02 — auto-wiring + stub metadata
- [x] 03 — ghost stubs
- [x] 04 — lifecycle fixture
- [x] 05 — rune dev
- [x] 06 — system map
- [x] 07 — docs + sweep

## Non-negotiable policies (repeat these to every worker)

- Never `git commit` or `git push`. Leave changes in the working tree.
- All existing tests must stay green. A worker who breaks an unrelated test must fix it or stop
  and report — never delete or weaken an assertion to pass.
- Do not reformat code beyond the files you touch. In the rune repo, do not run `deno fmt` at
  all (the repo is intentionally not fmt-clean; match surrounding style by hand).
- If reality contradicts the task file (a function moved, a line number drifted), trust reality,
  adapt, and note the deviation in your report.

## Release

Publish **keep first, then rune** — generated rune code targets keep's published JSR package:

1. **keep** — a **minor** version bump: the new `@Endpoint` `stub` option, the `/docs/_dev`
   dev channel, the `/docs/_map` system map, and the `emulatorShellHtml` options argument are
   all additive (no breaking changes). keep's release flow is documented in keep's README
   ("Releasing"): every push to `main` publishes to JSR via CI — a `feat:` commit in the push
   produces the minor bump automatically. **Never cancel a publish run that looks hung** (JSR
   holds the package lock; server-side processing has taken ~22 min).
2. **rune** — release after keep is live on JSR. Its generated projects pin
   `jsr:@techgoose-labs/rune@^1`, which the new keep minor still satisfies — **no pin change
   needed**; freshly synced projects pick the new keep up on first `deno` run.
