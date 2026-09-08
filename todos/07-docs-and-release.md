# Task 07 — Docs, skill, cross-repo sweep, release order

Repos: **both**. Read `00-context.md` first.
**Prerequisite: tasks 01–06 all complete and verified.**

## Goal

Document every new surface where its users will look for it, sync the rune skill, prove both
repos fully green, and record the release sequencing. Nothing ships undocumented.

## Steps

1. **keep `README.md`** — extend the existing sections (don't restructure):
   - the `@Endpoint` options paragraph: `stub`;
   - the cake section: the `auto:` snap-together affordance and the stub badge;
   - a short `/docs/_map` paragraph (what it shows, that it's live, the deep links);
   - a dev-loop note: `KEEP_DEV=<status file>` env → `/docs/_dev` endpoint + page auto-reload
     (and that `rune dev` drives it);
   - `exerciseEndpoints`: the `$`-fallback resolution order (seeds → captured producer).
2. **rune `lang/docs/spec.md`** — in the Entrypoint section (which already documents flows and
   `[TYP:ext]`): add the stub lifecycle (unfulfilled ext inputs → generated `bootstrap/stubs.ts`,
   `DENO_ENV=production` exclusion, evaporation on a real producer) and a `rune dev` subsection
   (what it watches, the error banner, session survival).
3. **rune skill** — edit `skills/rune/SKILL.md` IN THE RUNE REPO (source of truth):
   - the commands block: add `rune dev`;
   - "Branching, external inputs, optional steps" section: add the stub lifecycle and the
     snap-together composition story (declare `[TYP:ext]` → develop against the ghost →
     compose → auto-wires; stub evaporates);
   - the verify-via-cake section: mention `/docs/_map` and `rune dev`.
   Then copy it over the installed one:
   `cp skills/rune/SKILL.md ~/.claude/skills/rune/SKILL.md` and `diff -q` to confirm sync.
4. **rune CLI help** — ensure `deno run -A src/bootstrap/mod.ts --help` (or the no-arg usage
   output) lists `dev` with a one-liner.
5. **keep sweep** (from the keep root; every line must be green):
   ```
   deno task test
   deno task test:browser
   KEEP_BROWSER=1 deno task test:e2e
   deno fmt --check src/
   deno lint src/foundation/domain/business/emulator-ui/ src/foundation/domain/business/map-ui/ src/foundation/domain/business/endpoint-decorator/ src/foundation/domain/business/endpoint-spec/ src/foundation/domain/coordinators/exercise-harness/ src/foundation/domain/coordinators/bootstrap-server/
   deno task check:jsr
   ```
6. **rune sweep**:
   ```
   deno test -A src/rune/domain/business/rune-parse/ src/rune/domain/business/rune-manifest/ src/rune/domain/business/rune-stubs/ src/rune/entrypoints/dev/
   deno run -A scripts/verify.ts        # capture the gate pattern
   git stash && deno run -A scripts/verify.ts && git stash pop   # baseline
   ```
   The two gate patterns must be IDENTICAL (5 gates — L1–L4, L6 — fail on clean `develop`
   today; zero new failures allowed).
7. **Release order note** — append to `todos/README.md` under a "Release" heading: publish keep
   first (minor version; new `@Endpoint` `stub` option, `/docs/_dev`, `/docs/_map`,
   `emulatorShellHtml` opts are all additive), then rune (its generated code targets
   `jsr:@techgoose-labs/rune@^1`, so no pin change). keep's release flow is documented in keep's
   README (JSR publish via CI; never cancel a hung publish).
8. **Demo pass with screenshots** (Playwright or browser MCP), one image each:
   - `rune dev`: edit a spec, the page updates;
   - `/docs/stubs`: mint step green;
   - compose-and-snap: checkout's Module-inputs showing `auto:` and a no-typing green walk;
   - `/docs/_map`: the full graph with a dashed `$` edge and a green dot.
9. `git status` review in BOTH repos: only intended files modified; still no commits.

## Definition of done

- [ ] keep README, rune spec.md, rune SKILL.md (repo + installed copy, diff-clean) all updated
- [ ] CLI help lists `dev`
- [ ] keep sweep: 6/6 commands green
- [ ] rune sweep: tests green; verify.ts gate pattern identical to stashed baseline
- [ ] Release-order note appended to todos/README.md
- [ ] 4 demo screenshots captured; `git status` clean of surprises in both repos; no commits
