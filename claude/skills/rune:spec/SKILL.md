---
name: "rune:spec"
description: >-
  Author and edit the `.rune` spec DSL — the shaping layer where you model a
  module's endpoints, services, DTOs, and validation, then drive it to a `rune
  check`-clean draft. Use whenever you touch/create a `.rune` file, "write a spec
  for X", "add an endpoint/feature/module", "wire two modules together", or decide
  modeling granularity (what becomes a `[REQ]`, when `[PLY]` vs a looped step,
  `[ENT]`/`[MOD]` scope); whenever you declare a shared service (`[SRV]` + `@docs`
  in `core.rune`) or a `[TYP]` validation modifier; whenever you run `rune
  check`/`rune fmt`; and whenever a spec "won't parse / won't lint" with a spec
  error — DTO-suffix, scope, value names, fault statuses, line-length,
  untyped-field, missing-[ENT]-body complaints. The spec is the source of truth; this skill produces a
  `rune check`-clean `spec/runes/<m>.in-prog.rune` and stops there. NOT generating the
  module, filling bodies, or the test fleet → use `rune:build`; NOT the runtime
  (`@Endpoint` semantics, `bootstrapServer`, auth, deploy) → use `rune:framework`;
  NOT the interactive cake / heal-rules schema → use `rune:cake`; NOT the Swagger
  doc surface (`@ApiProperty`, where `@docs`/`example=` show up) → use `rune:docs`.
user-invocable: true
argument-hint: "[what to spec / the feature or endpoint to add]"
---

# rune:spec — orchestration playbook

The shaping layer of rune: model a module in the `.rune` DSL and drive it to a
`rune check`-clean draft. The main session owns the **interactive modeling
decisions** and delegates the actual authoring + check/fix loop to a specialist.
The spec is the source of truth; this skill ends at a clean `.in-prog` draft.

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

## When this skill applies

Touching/creating a `.rune`; "write a spec for X"; adding an endpoint/module/feature;
declaring a `[SRV]`/`[TYP]`; or a spec that "won't parse / won't lint".

## Specialist roster

- **`rune-spec-author`** — authors/edits the `.rune` and drives it to `rune check`
  exit 0, consulting the bundled language references. Owns nothing (the references
  are auto-synced, read-only).

## The decisions the main session owns (interactive — do NOT delegate)

Granularity is the modeling call an LLM gets wrong first and worst; decide it WITH the
user **before** delegating authoring:

- **One `[REQ]` = one externally-triggerable endpoint** (an HTTP route, cron job, queue/
  webhook). Internal/domain logic is **steps inside** a REQ, never its own REQ. Author
  from the wiring / endpoint inventory, not from prose.
- **Exposure is explicit — a `[REQ]` alone has no HTTP surface.** Only an `[ENT]`
  generates an `@Endpoint` controller; there is no auto-exposure of `[REQ]`s. If the
  module will be served, hit over HTTP, cake-walked, or documented, the inventory MUST
  carry the `[ENT]` lines (typically one per exposed `[REQ]`). A `[REQ]`-only spec is a
  pure library module — a legitimate choice, but make it consciously: without an `[ENT]`
  the cake walk over it is vacuous (`/docs/<m>` 404s) and downstream builds report
  `run-all: skipped (no [ENT] surface)`.
- **The waist rule (the cross-repo contract):** every endpoint is a **query** (a
  current-state read DTO: `<type>.all`, `<type>.get`) or a **command** (an intent verb +
  input DTO) — **never an "edit-this-record" endpoint** (no `PUT`/`PATCH`-a-record CRUD).
  `rune:data` reshapes storage below this waist without touching the read DTOs or the
  command surface; history surfaces upward only additively, as a product decision.
  (Declared in sprig's `contract.md`, sibling to `coms.md`/`coordinate.md`.)
- **`[MOD]` = one deployable surface**, not one per concept or doc folder.
- **`[PLY]` = runtime dispatch** (exactly one arm executes per call), NOT a catalog of N
  things that all run.
- Confirm genuine modeling forks with the user (use `AskUserQuestion`): what is an
  endpoint vs a step, which boundary is a `[SRV]`, where polymorphism is real.

## Flow

1. **(main session)** Gather the endpoint inventory + entities + external services
   (often handed over by `rune:scope`). When a two-seam prototype exists
   (`spec/ui/<app>-prototype/` — or its snapshot in `spec/contract/draft/`, lifted by
   the `contract snapshot` CLI from `@dev-tools/contract`), it IS the
   seed inventory (bridge 1): ratify each `objects/<type>.json` into a type + read DTO +
   query endpoints, and each `commands.json` entry into a command verb + input DTO (its
   `kind` rides along as `rune:data`'s immutability hint); every seam entry is either
   ratified or explicitly dropped with the user. Then decide granularity per the rules
   above, clarifying genuine forks with the user.
2. **Delegate** authoring to `rune-spec-author` (Task tool). Pass: the decided modeling
   brief, the target `spec/runes/<m>.in-prog.rune`, the project root, and the absolute
   paths to `claude/skills/rune:spec/references/` (card.md — the generated language card:
   grammar by example, every table, every rule with its message and fix — cookbook.md,
   example-core.rune, example-tasks.rune) — or the installed `~/.claude/skills/rune:spec/references/`.
3. It returns the clean spec path + the `rune check` exit-0 proof + a summary (and any
   choice to confirm). **Summarize** for the user; if it flags a fork, resolve it with
   the user and re-delegate.
4. **(main session) Finalize seam:** once the clean draft is signed off, hand to
   **`rune:build`** to drop the `.in-prog` infix, `rune sync`, fill, test, lint.
   `rune:spec` stops at the clean draft.

## Routing to siblings

- finalize / sync / fill bodies / test / lint → **`rune:build`**
- `@Endpoint` semantics / runtime / auth / deploy → **`rune:framework`**
- the interactive cake / heal-rules schema → **`rune:cake`**
- where `@docs` / `example=` surface in the OpenAPI doc → **`rune:docs`**

## Hard rule

The main session owns the interactive granularity decisions; it delegates the actual
`.rune` authoring + `rune check`/`fmt` loop to `rune-spec-author` and never hand-writes
the spec inline.

## What's no longer here

The DSL syntax, the `[SRV]`/`[TYP]` rules, the rules-that-bite catalog, and the `rune
check`/`fmt` how-to now live in `rune-spec-author` + `references/`.
