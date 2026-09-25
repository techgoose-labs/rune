---
name: "rune:cake"
description: >-
  Prove a rune backend actually does what it's supposed to, end to end, through
  the per-module **cake** at `/api/docs/<module>` — real data, no mocks, real service
  connectivity — and fix the cake when a walk goes red. Use when the user says
  "run the cake", "exercise the endpoints", "walk the process", "does the app work
  end to end", "Emulate process / Run all in order", "the cake is red / a step
  fails / won't bind", "$input won't resolve", "run-all is red", "pin an
  expectation / save fixtures", "save/replay a scenario", "fix the heal rules /
  heal panel", or "drive the whole composed app headless" (`POST /api/docs/_run`,
  `exerciseEndpoints`). Covers serve-and-walk, the real-data e2e discipline,
  headless replay, Expectations→`spec/misc/cake.json`, Scenarios, response-diff,
  the system map, and the FIX-CAKE assist (stale entrypoint controller, missing
  schema example, unproduced `$input`, 422 assert failure, heal panel rules→Claude).
  NOT for writing/editing the `.rune` spec → use `rune:spec`; NOT for generating
  + filling bodies + unit/smoke tests + enriching heal-rules → use `rune:build`;
  NOT for runtime/auth/runner internals (`bootstrapServer`, 401/403, the
  `exerciseEndpoints` full option surface, mounting/deploy) → use `rune:framework`;
  NOT for per-endpoint Swagger examples → use `rune:docs`.
user-invocable: true
argument-hint: "[module to exercise, or the cake problem to fix]"
---

# rune:cake — orchestration playbook

The cake is rune's **end-to-end tier**: a per-module guided walk at `/api/docs/<module>`
that runs your real endpoints, in dependency order, against **real services with no
mocks**. The main session drives the **interactive** browser walk and pins the
contract itself; it delegates the **unattended/headless** drive-and-heal loop to a
specialist, and routes every real fix to the owning sibling skill.

## Conduct (applies to you, the orchestrator, and every agent you spawn)

- **Never search the filesystem for references or artifacts.** Every skill reference lives at
  `~/.claude/skills/<skill>/references/<file>` — read exact paths. No `find /`, `find ~`, or
  whole-disk/home scans, ever (a measured orchestrator ran `find /` for a file whose path it knew).
- **Brief completely — an agent that has to search was under-briefed.** Every path you pass is
  ABSOLUTE and copied verbatim from a prior stage's return, never retyped. An agent reporting
  `blocked: missing path` means the brief was wrong: fix the brief and re-delegate; never answer
  "search for it."
- **After spawning agents, END YOUR TURN** — task notifications re-invoke you; never `sleep`-poll
  (measured: 32% of a build's wall-clock was orchestrator sleeps).
- **The server is yours or the user's, never an agent's to find**: pass the running base URL + port
  as facts; an agent that finds the server unreachable reports blocked — it never `lsof`-scans or
  restarts it.
- **Entrypoint controllers are generated, never hand-written.** Only an `[ENT]` in the spec
  generates an `@Endpoint` controller — a `[REQ]`-only module has NO HTTP surface: `/api/docs/<module>`
  404s and any walk over it is vacuous. Never hand-create `src/<m>/entrypoints/*` or a hand-rolled
  bootstrap to force a walk (measured: a hand-wired controller + bootstrap turned a lint-clean
  build into 4 `--strict` violations) — declare the `[ENT]` in the spec (→ `rune:spec`) and
  re-sync (→ `rune:build`). **A zero-endpoint walk is RED (vacuous), not green**, whatever `ok`
  says.
- **Run artifacts never touch the project tree.** The server log, `/api/docs/_run` output JSON, and
  pid files go to `/tmp` / a scratch dir / a designated out-dir — `rune lint --strict` fails on
  root strays like `server.log` or a result JSON at the project root.
- **Canonical and certified facts are trusted, not re-verified.** No pre-flight `ls` of
  `~/.claude/skills/**` reference dirs (the paths are canonical), and no re-`rune check` of a
  spec the task hands you as check-clean (measured: ~96K cache-read of pure pre-flight
  re-verification in one walk).

## When this skill applies

"Does the composed app work right now, with real data?" or "the cake / heal / run-all
is broken — get it green". Serving and walking `/api/docs/<module>`, pinning
expectations/scenarios, replaying headless, or fixing a red walk.

## Specialist roster

- **`rune-cake-e2e-driver`** — drives the e2e walk UNATTENDED against a running
  localhost server (dryRun → `POST /api/docs/_run` → diagnose each failed row → heal →
  re-run to green), reports remaining failures with the owning sibling. Owns the
  headless diagnosis/heal procedure; reads `references/cake.md` + `references/heal-rules.md`.

## The interactive tier (main session runs this itself)

A subagent can't share the browser or talk to the user, so the interactive walk stays here:

```text
deno run -A server/bootstrap/mod.ts     # serve the backend directly (docs at bare /docs/*)
open http://localhost:<port>/api/docs/<module>
# — or, against the composed app (`deno task start`; the merge gate uses `deno task serve`
#   on its own $PORT and hands test:e2e a BASE_URL — see rune:framework deployment.md,
#   "The four gate tasks"): the backend layer mounts
#   everything under /api, so the same pages live at /api/docs/<module>
   ├─ Emulate process    # send the next step, read the response, capture its output
   └─ Run all in order   # walk the active flow top-to-bottom, stop at the first failure
green ✓ on every step ⇒ the logic actually works (not just type-checks)
```

- Request bodies are generated from the input DTO schema; bound fields carry
  `{{step.field}}` refs resolved at send time. Captures + variables are shared across
  docs pages via `localStorage`. A `flows` module shows a **flow selector** (default
  **main** = untagged-only, so a destructive `teardown` never auto-runs). `/api/docs/_map`
  is the whole composed app as one live process graph.
- Prefer **`rune dev`** for the edit loop (watch → re-check/sync → restart; open pages
  self-reload). `rune dev` does **not** run `deno test` — that loop is `rune:build`'s.
- **Pin the contract (interactive):** **Expectations → `spec/misc/cake.json`** (each
  step's Expect block pins status + body checks; **Save fixtures** writes setup +
  expectations + variables) and **Scenarios → `spec/misc/scenarios/<name>.json`** (the
  Scenarios card freezes the whole walk). Full cake-page behavior, the Expectations
  grammar, Module setup, and response-diff are in **`references/cake.md`**.

## Real data, no mocks — the e2e discipline

The whole point: the cake hits **real services**. Do not stub the boundary, mock the
adapter, or hand-fake a response to force green — a green walk is only meaningful
because it proves the real call path (auth, the real DB/HTTP/queue adapter, real DTO
validation) works against a live dependency. This shares the smoke-connectivity premise
with `rune:build`'s `smk` tests. An unreachable service is an environmental failure to
fix or visibly seed past, never a reason to mock.

## When to delegate to `rune-cake-e2e-driver`

For unattended / CI / "drive it headless" runs, or an automated get-it-green loop:

1. **Pick the dispatch path.** `POST /api/docs/_run` (and `/api/docs/_heal`) are **open
   routes in dev and with no auth unit composed** (D-11), so a plain
   `curl http://localhost:<port>/api/docs/_run` works against a dev server (no
   token, no bearer). Under an auth unit outside dev the row resolves
   `authenticated`, and a headless dispatch is SCOPE-LESS — pass a `credential`
   the auth unit recognizes (D-19), in the body or as `Authorization`. Against an already-running server → drive it over HTTP. With no
   server running (typical sandbox/CI) → the leanest path is **in-process
   dispatch** via the composed app's `backend.fetch` (`bootstrapServer` →
   `{ backend }`) — and **do NOT start a listening server for it**: importing the
   bootstrap already boots the composed app, so a listener is a redundant second
   boot serving zero walk requests (measured: an orchestrator started, polled, and
   tore down a server its in-process walk never touched). Start a listener only
   for the HTTP path, the interactive browser walk, or when something else
   genuinely needs the port.
2. **Delegate** to `rune-cake-e2e-driver` (Task tool). Pass: the dispatch path (base
   URL, or — for in-process — the project root, `<project>/server/bootstrap/mod.ts`
   and `<project>/server/deno.json`), the modules in scope, each module's SPEC path
   (`spec/runes/<m>.rune` — the durable home sync reads in place; legacy projects
   may still hold it at `src/<m>/<m>.rune`), the controller path (`src/<m>/entrypoints/<surface>/mod.ts`)
   and the out-dir for saved artifacts, any known `seeds`, and the absolute paths to
   `claude/skills/rune:cake/references/cake.md` + `references/heal-rules.md` +
   `~/.claude/skills/rune:framework/references/endpoints.md` (the runtime recipe the
   in-process script follows).
3. It returns the final verdict + each remaining failure with its diagnosed cause and
   the owning sibling. **Summarize** that and route the fixes (below).

## Routing a red walk to its owner

The driver (headless) and you (interactive) classify a failure, then hand the real fix
to the owner — this is the coordination map:

| Diagnosed cause | Owner |
| --- | --- |
| walk WIRING — a backwards/wrong `order`/`dependsOn`/`bind` in the controller decorator | **the driver, in-loop** (its Edit covers exactly this surface; it re-runs and reports the change) — the underlying spec-level cause still routes to **`rune:spec`** |
| stale entrypoint controller; unimplemented/wrong body; heal-rule enrichment | **`rune:build`** |
| missing `[TYP:example=]`; an echo that should mint; a contract fix | **`rune:spec`** |
| **vacuous walk** — `/api/docs/<m>` 404 / dryRun `order` empty / 0 rows exercised (no `[ENT]` in the spec) | **`rune:spec`** (declare the `[ENT]`), then **`rune:build`** (re-sync) — never hand-wire |
| the runner option surface; `bootstrapServer`/auth/trust posture | **`rune:framework`** |
| a per-endpoint Swagger example/description | **`rune:docs`** |

The orchestrator NEVER applies a fix itself — not even a two-line decorator edit
(measured: an orchestrator that became the hands paid 7 turns — the edits, a failed
agent resume, a poll, and an induced re-lint — for a fix the driver now owns). And a
returned driver is COMPLETE: never resume it mid-walk with a message and wait; if a
fix outside its ownership was applied by its owner, spawn a FRESH driver run.

This skill **owns the heal-rules schema** (documents it) but never authors rules —
`rune sync` scaffolds them from fault slugs and **`rune:build`** enriches them.

## Hard rule

The main session runs the interactive browser walk + GUI pinning itself and delegates
the unattended headless drive-and-heal to `rune-cake-e2e-driver`; it never mocks a
boundary to force green, and it routes every real code/spec fix to the owning sibling.

## What's no longer here

The detailed headless drive/heal procedure and the symptom→cause diagnostic method now
live in `rune-cake-e2e-driver` + `references/cake.md` + `references/heal-rules.md`; this
playbook keeps only the interactive walk and the cause→owner routing.
