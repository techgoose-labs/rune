---
name: "rune:scope"
description: >-
  The scoping layer that comes BEFORE `rune:spec` — interactively turn a raw
  product idea into two founding, human-readable artifacts: a product spec
  (`spec.md`) and `user-stories.md`. Use at the very start, before any `.rune`
  exists: "help me scope this", "I have an idea for an app/feature", "write a PRD
  / product spec", "turn this idea into a spec", "what should we build", "figure
  out the requirements", "scope out a new product/module", "draft a spec.md and
  user-stories.md", "write the user stories". Drives a structured discovery
  interview — thesis, roles/users, goals & non-goals, the core mechanism (the
  "heart"), the hard product decisions (each surfaced as a `[DECIDE]` carrying a
  recommended default so build can start), a walking-skeleton-first `M0..Mn`
  milestone ladder, risks & mitigations, a feasibility verdict — converges on a
  spec the user signs off on, then derives role-grouped "As a <role>, I want
  <capability>, so that <benefit>" stories from it. It produces the prose product
  intent the rest of the rune pipeline consumes; it ends the moment both
  artifacts are signed off. NOT the `.rune` DSL — modules, `[REQ]` endpoints,
  `[DTO]`s, `[SRV]` services, `[TYP]` validation, and `rune check` are
  **`rune:spec`** (this skill STOPS at the prose spec and hands the module/
  endpoint inventory to `rune:spec`); NOT data/store design (`data.json`) →
  **`rune:data`**; NOT the UI prototype or design system (`spec/ui`) →
  **`sprig:prototype`** / **`sprig:design`**; NOT generating, filling, or testing
  code → **`rune:build`**.
user-invocable: true
argument-hint: "[the product or feature idea to scope]"
---

# rune:scope

The **product-definition layer** of rune — the step *before* any `.rune` exists.
Every other rune skill operates on artifacts that already encode a decision:
`rune:spec` shapes modules, `rune:data` places entities, `rune:build` writes code.
This skill is where those decisions are *made*. It takes a raw idea — a sentence, a
paragraph, a brain-dump — and through a **structured discovery interview** converges
on two founding, human-readable documents:

- **`spec.md`** — the product/scoping spec: the thesis, what's in and explicitly
  out, the one central mechanism everything hangs on, the architecture, the open
  decisions (each with a recommended default), a milestone ladder, the risks, and a
  feasibility verdict.
- **`user-stories.md`** — role-grouped "As a `<role>`, I want `<capability>`, so
  that `<benefit>`" stories, *derived from* `spec.md`.

These are the **founding documents**: prose intent that the machine pipeline
(`rune:spec` → `rune:data`/`sprig` → `rune:build` → `rune:cake`) turns into a typed,
tested backend. This skill ends the moment the user has **signed off on both** —
then it hands the module/endpoint inventory to **`rune:spec`**.

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

## Specialist & what's delegated

This skill is **mostly a main-session playbook**: the discovery interview, drafting
`spec.md`, and the review/sign-off loop are **interactive**, so the main session runs
them itself (a subagent cannot converse with the user). Exactly one job is delegated:

- **`rune-scope-story-deriver`** — once `spec.md` is drafted/signed off, derive
  `user-stories.md` from it (non-interactive). The main session owns everything else
  below.

> **This skill is self-contained — do not go spelunking.** Everything you need is
> in this skill's **`references/`** folder: a complete, real, well-structured
> exemplar pair — **`example-spec.md`** and **`example-user-stories.md`** (a
> portable dev-workstation product). Read them once to internalize the house style;
> copy their section order and decision discipline. You do **not** need to find the
> rune toolchain, read `lang/docs/`, or inspect any binary — there is no tool to run
> here. The deliverable is **prose the user agrees with**, validated by the user's
> sign-off, not by a compiler.

## This skill vs its siblings

- **`rune:scope` (here)** — *what to build and why*. Interactively produces
  `spec.md` + `user-stories.md`: human prose, product decisions, scope, milestones.
  **You end when the user signs off on both artifacts.** No `.rune`, no code.
- **`rune:spec`** — *the technical contract*. Turns the product intent into the
  `.rune` DSL: `[MOD]` modules, `[REQ]` endpoints, `[DTO]`s, `[SRV]` services,
  `[TYP]` validation, driven to a `rune check`-clean draft. The seam: **a module in
  your `spec.md` becomes a `[MOD]`; an endpoint in your inventory becomes a `[REQ]`;
  an entity becomes a `[NON]`/`[DTO]`; an external dependency becomes a `[SRV]`.**
  Hand off the instant the prose is signed off; *granularity* (one `[REQ]` = one
  endpoint) is `rune:spec`'s decision, but you make it *possible* by naming the real
  endpoint inventory here (see **Feeding `rune:spec`**).
- **`rune:data`** — *where the data lives* (`spec/misc/data.json`: store choice,
  immutability, retention). Consumes the entities your spec names; runs after
  `rune:spec`.
- **`sprig:prototype` / `sprig:design`** — *what it looks like* (`spec/ui/`: the
  clickable prototype + design system). Your `spec.md` describes the UX in prose and
  ASCII; sprig makes it real. The two-seam prototype (`spec/ui/<app>-prototype/`) is
  born carrying the draft backend contract — `objects/` (the read model) +
  `commands.json` (intent verbs) — which `rune:spec` ratifies (bridge 1 of sprig's
  `contract.md`).
- **`rune:build` / `rune:cake` / `rune:framework` / `rune:docs`** — *making it run*.
  Everything downstream of a finalized `.rune`. Far from here; named only so you know
  where the prose eventually lands.

## The loop you own

```text
raw idea ─▶ structured discovery interview ─▶ draft spec.md (scaled to the idea)
                       ▲                                  │
                       │  iterate: propose default,       ▼
                       │  user corrects, never block   derive user-stories.md
                       │                                  │
                       └──────────── review ◀─────────────┘
                                       │  user signs off on BOTH
                                       ▼
                         hand module/endpoint inventory to rune:spec
```

You stay in prose. You drive the interview, propose a recommended default for every
fork (so the doc is always complete enough to move), write both artifacts, and
iterate with the user until they sign off. You **never** write a `.rune`, design a
store, or touch code — your deliverable is *agreed product intent*.

## The interactive method — this is the skill

The word the user reached for is **interactively**. `rune:scope` is not a
transcription service that dumps their words into a template; it is a **product
partner that runs a discovery interview** and fills the gaps with informed,
clearly-labelled defaults. Three rules govern every exchange:

1. **Propose, don't interrogate.** Never fire a bare list of open questions. For
   each unknown, state the *most likely answer as a recommended default*, then ask
   the user to confirm or correct. "I'm assuming macOS-first with an abstracted
   keymap (cross-platform later) — good, or do you need Windows/Linux in v1?" beats
   "Which OS?". A user can accept a good default in one word; they can't author a
   spec from a blank page.
2. **Never block the document on an open question.** If a fork is genuinely the
   user's call and they haven't answered, **write the recommended default into the
   spec and mark it `[DECIDE — D-<slug>]`** (see *The decision discipline*). The spec
   is always complete enough that `rune:spec` could start from it today; open items
   are visible, defaulted, and collected — not blanks.
3. **Batch the forks; use the question tool for real choices.** Group related
   unknowns and ask them together. For genuine either/or product decisions, use the
   **`AskUserQuestion`** tool with the recommended option listed **first** and
   labelled "(Recommended)"; for everything else, propose inline in prose and let the
   user redline. Don't ask about things you can infer or that have an obvious default
   — infer, state the inference, move on.

### The discovery checklist — what you must pin down

Run the interview against these dimensions (they map 1:1 onto the `spec.md`
sections, so the interview *is* the outline). For each, you either get an answer or
you write a defaulted `[DECIDE]`:

- **The thesis** — the one-sentence pitch, and the **core insight** beneath it
  ("the constant is *you*; everything else is pluggable"). If you can't state the
  product in one sentence, the interview isn't done.
- **The users (roles)** — who acts on the system. Name each role; they become the
  `user-stories.md` groupings and hint the auth posture. (The exemplar has two:
  *developer*, *operator*.)
- **The core job & main flow** — the single most important thing a user does, end
  to end. This anchors `M0`.
- **Non-goals** — what you are deliberately **not** building in v1. This is the
  highest-leverage question in the whole interview: it's where scope is won or lost.
  Push for explicit non-goals; a spec with none is under-scoped.
- **The heart** — the *one* central mechanism or model the whole design rests on
  (the exemplar's is "where state lives: laptop holds only secrets"). Find it and
  give it its own section called out as the heart. Most products have exactly one;
  surface it.
- **Constraints** — platform/OS, stack preferences, who hosts/owns infra, budget,
  timeline, team size, compliance. These bound every later decision.
- **The hard forks** — every place two reasonable designs diverge. Each becomes a
  `[D-<slug>]` decision with a recommended default.
- **Risks** — what could sink it (UX traps, latency, security, recovery). Each gets
  a mitigation.
- **The milestone ladder** — how it gets built, walking-skeleton first.

You will rarely get all of this up front. Start from whatever the user gives,
reflect back a first-cut thesis + non-goals to anchor the conversation, then fill
the rest through batched propose-and-correct rounds.

### The decision discipline — `[DECIDE]` markers carry a default

This is the single most important convention to copy from the exemplar, and what
makes the spec *buildable while still open*. Every unresolved product choice is:

- **Marked inline** where it bites — `**[DECIDE — D-host]**` next to the relevant
  prose — with the **recommended default written into the body so build can start**.
- **Collected** in a `## Decisions to confirm` section near the end: one line per
  `[D-<slug>]`, each naming the options and the recommended default.
- **Promoted to "Settled"** once the user picks: move it to a short "Settled this
  round" recap and bake the choice into the body. A resolved decision keeps its id so
  the history reads.

```md
### Who hosts the environments? **[DECIDE — D-host]**
- **You host them** (one box per context on your VPS) — pragmatic, buildable now —
  **recommended for MVP.**
- **Employers host them** — the universal-client future; not the MVP.
```

The rule: **a spec never stalls on an open question.** It records the question, the
options, and the default you'd ship — so the user reviews *decisions*, not blanks,
and `rune:spec` can proceed from the defaults the moment sign-off lands.

## Anatomy of `spec.md`

The bundled **`references/example-spec.md`** is the canonical template — read it
once, in full. Its section order is a strong default for any non-trivial product;
reproduce it, scaling depth to the idea (see *Scale to the idea* below):

1. **Title + one-paragraph thesis** — the product in a single dense paragraph a
   stranger could grasp. Lead with the core insight.
2. **Status note** — "scoping draft"; state that `[DECIDE]` sections are open and
   each carries a recommended default so build can start.
3. **Product thesis / the core insight** — the one idea everything hangs on, stated
   as a principle ("The constant is *you*. Everything else is pluggable.").
4. **Goals / Non-goals (v1)** — bulleted. **Non-goals are not optional** — they are
   how the spec defends its scope. Each non-goal is a deliberate cut, not an
   omission.
5. **The heart of the design** — the central mechanism gets its own section, named
   as the heart (a state model, a protocol, a data-flow, an algorithm). Use a table
   or diagram. This is what a reviewer should remember.
6. **Architecture** — an ASCII diagram of the tiers/components, then a short
   subsection per component describing its job and boundaries. Name the **trust
   boundary** if there is one.
7. **Key flows / lifecycle / protocol** — the precise contracts (the exemplar's
   attached/detached/stopped table; its WS message table). Tables beat prose for
   state machines and message shapes.
8. **Data / control-plane model** — the entities and where they live, in prose +
   pseudo-schema. (Detailed store/immutability design is `rune:data`'s job later;
   here, just name the entities and their relationships.)
9. **Tech stack** — the concrete building blocks, per tier.
10. **Milestones** — a table `M0..Mn`, each row a **demoable** deliverable, walking
    skeleton first (see *The milestone ladder*).
11. **Key risks & mitigations** — numbered; each risk paired with its mitigation and
    a pointer to the section that handles it. Flag the *highest* risk.
12. **Decisions to confirm** — the `[D-<slug>]` collection (see *The decision
    discipline*), plus a "Settled this round" recap of what's locked.
13. **Verdict** — an honest feasibility call: is it buildable with known parts, what
    is the **one thing to nail first**, and the recommended build order (usually
    "build `M0` to de-risk X, then `M<k>` to prove the core mechanism").

Voice: dense, opinionated, concrete. Prefer a table or ASCII diagram to a paragraph
whenever you're describing structure, state, or message shapes. Mark uncertainty
honestly (`[DECIDE]`) rather than papering over it.

### The milestone ladder

Milestones are **demoable slices**, ordered to retire risk earliest, not by
architectural layer:

- **`M0` = walking skeleton** — the thinnest end-to-end thread that proves the
  *riskiest assumption* (the exemplar's `M0`: "Electron + 1 xterm ↔ gateway WS ↔ a
  container's shell. No auth. Proves the transport."). Always start here.
- **Each later `M<k>`** adds one demoable capability; order them so the **core
  mechanism** (the "heart") is proven as early as possible after the skeleton.
- Half-steps (`M7.5`) are fine for a slice that's smaller than a milestone but worth
  calling out.

State, in the Verdict, which milestone proves the heart — that's the one to reach
fast.

## Deriving `user-stories.md` — delegate to `rune-scope-story-deriver`

`user-stories.md` is **derived from `spec.md`**, not invented alongside it — so once
`spec.md` is drafted, **delegate** the derivation to **`rune-scope-story-deriver`** (Task
tool). Pass: the `spec.md` path, the directory to write into (co-located with `spec.md`),
and the absolute path to `references/example-user-stories.md`. It returns the written
`user-stories.md`, the role/capability groups, and any capability it could not trace to a
spec section. **Summarize** that for the user and fold any flagged gap back into `spec.md`.

The agent owns the story shape — roles up front, the canonical **"As a `<role>`, I want
`<capability>`, so that `<benefit>`"** form, edge/persistence annotations, and
spec-traceability — so this playbook does not restate it.

## Feeding `rune:spec` — what makes this a *rune* skill

A generic PRD writer stops at "here's the product." `rune:scope` writes the product
spec **so that `rune:spec` can mechanically pick up the technical contract**. That
means `spec.md` must make four things explicit, because they are exactly what
`rune:spec` needs (and what it most often has to *guess* when handed vague prose):

- **The deployable surfaces → `[MOD]`s.** Name the modules/services the system
  ships (the exemplar's gateway, client, environment). `rune:spec` maps one
  deployable surface to one `[MOD]` — so name them as surfaces, not as doc chapters.
- **The endpoint/trigger inventory → `[REQ]`s.** For each module, list what is
  **externally callable**: HTTP routes, cron/queue/webhook triggers.
  `rune:spec`'s hardest rule is *one `[REQ]` = one endpoint, authored from the wiring
  not the prose* — you make that possible by surfacing the real inventory here (e.g.
  the protocol/message table, the route list), so the REQ count and names fall out of
  your spec instead of being invented.
- **The entities → `[NON]`/`[DTO]`s.** Name the nouns and their field shapes in the
  data-model section. These become `rune:spec`'s `[NON]` declarations and DTOs, and
  later `rune:data`'s stored entities.
- **The external dependencies → `[SRV]`s.** Name every outside service the system
  calls (DB, auth provider, a SaaS API, a sidecar). Each becomes a `[SRV]` in
  `rune:spec`'s `core.rune`. Naming them now means the boundaries are designed, not
  discovered mid-build.

**When a two-seam prototype exists, it IS the seed inventory (bridge 1).** A
prototype built after this scope (`spec/ui/<app>-prototype/`) carries the draft
contract pre-extracted: `objects/<type>.json` names the entities + read model, and
`commands.json` names the write verbs (+ their `kind` immutability hints). Point
`rune:spec` at those two files (or the snapshot in `spec/contract/draft/` — the
`contract snapshot` CLI lifts it) as the
endpoint/entity inventory — it ratifies them into canonical DTOs instead of
re-deriving them from prose. Your four inventories above still matter: they cover
what the prototype can't show (cron/queue triggers, external `[SRV]`s, non-UI
modules). Either way the endpoint surface stays **queries + commands** — never an
"edit-this-record" endpoint (the waist rule; see sprig's `contract.md`).

You don't write any rune syntax — you write prose and tables that *name these four
things clearly*. The handoff summary you give at the end (see the procedure) is
literally this inventory: modules, their endpoints, the entities, the external
services — the raw material `rune:spec` shapes into `.rune`.

## Scale to the idea

Match the artifact to the ambition. The exemplar is a platform, so it earns all 13
sections, ASCII tiers, and an `M0..M8` ladder. **Most requests are smaller** — a
single feature, one new module, a tool. For those, produce a **lean spec.md**:
thesis, goals/non-goals, the core flow, the entities, the handful of endpoints, the
2–4 decisions that matter, a short milestone list, and a verdict. Drop the sections
that would be ceremony (a one-module feature rarely needs a tiered architecture
diagram). The discipline is identical at every size — thesis, explicit non-goals,
defaulted decisions, demoable milestones, a handoff inventory — only the depth
changes. When unsure, ask the user how deep they want to go, defaulting to "as lean
as covers it."

## Where the artifacts live

Write **`spec.md`** and **`user-stories.md`** into **`spec/product/`** under the
**shared `spec/` folder at the git root** — the sibling of `.git` that, in a
monorepo, both the frontend (sprig) and the backend (rune) resolve to. The product
docs are the founding layer of that single shared contract, sitting above its machine
artifacts:

```text
<git-root>/            # the dir containing .git
  spec/
    product/           # ← spec.md + user-stories.md   (this skill)
    runes/             # .rune backend specs           (rune:spec)
    ui/                # prototype + design system      (sprig:prototype / :design)
    misc/              # data.json, cake.json           (rune:data / rune:cake)
```

To place them, **find the git root yourself** — walk up from the working directory to
the nearest ancestor containing `.git`, and write to `<that-dir>/spec/product/`. Keep
the two files **together** there; `user-stories.md` links back to `spec.md` with a
relative link, so they must be co-located. If there is **no git repo yet** (a
brand-new product, not yet `git init`'d), write to `./spec/product/` in the working
directory — these two docs may be the **first** files written, before even `rune
init`, and they'll travel with the repo once it exists. Either way, the product is
defined before it's scaffolded.

> Why the git root: `spec/` is one shared surface spanning the whole product — the
> backend reads `spec/runes`, the frontend reads `spec/ui`, the data design reads both
> — so it lives above the per-package code, as a sibling of `.git`. (The rune↔sprig
> contract for this is `sprig/coordinate.md`.)

## The procedure

> **Terminal gate — you do not hand off until the user has SEEN and signed off on
> BOTH artifacts.** `rune:scope` produces *agreed* intent; agreement is the
> deliverable. A drafted `spec.md`/`user-stories.md` the user hasn't reviewed is not
> done. Present both, iterate on their feedback, and only summarize the handoff
> inventory to `rune:spec` *after* explicit sign-off. Never skip review because the
> draft "looks complete" — the whole point is that the user's product judgment shapes
> it. Steps 5–6 enforce this.

1. **Take the seed.** Start from whatever the user gave — a sentence, a paragraph, a
   pasted brain-dump, a link. If it's thin, reflect back a first-cut **thesis +
   non-goals** to anchor the conversation; if it's rich, mine it for the checklist
   dimensions before asking anything.
2. **Run the discovery interview.** Work the *discovery checklist* via batched
   **propose-and-correct** rounds: for each unknown, state your recommended default
   and ask the user to confirm or redirect; use `AskUserQuestion` (recommended option
   first) for genuine forks. Never fire a bare questionnaire. Pin down the thesis,
   roles, core flow, non-goals, the heart, constraints, the hard forks, risks, and a
   rough milestone ladder.
3. **Draft `spec.md`** — scaled to the idea (lean for a feature, full for a
   platform). Follow the *Anatomy of `spec.md`* section order. Every unresolved fork
   becomes a `[DECIDE — D-<slug>]` with its recommended default written into the
   body and collected in *Decisions to confirm*. Make the four `rune:spec` inputs
   (modules, endpoints, entities, external services) explicit.
4. **Derive `user-stories.md`** — delegate to **`rune-scope-story-deriver`** (pass the
   `spec.md` path, the output dir, and the `references/example-user-stories.md` path); it
   writes the role-grouped stories traced back to the spec. Summarize its return and fold
   any flagged gap back into `spec.md`.
5. **Present both for review — always.** Show the user `spec.md` and
   `user-stories.md` (write them to disk and point at the paths, and summarize the
   key decisions + open `[D-<slug>]`s in chat). Walk them through the non-goals and
   the defaulted decisions specifically — those are where their judgment matters most.
   Iterate on their feedback: resolve `[DECIDE]`s into "Settled", adjust scope,
   re-derive stories. Loop until they sign off on **both**.
6. **Hand off to `rune:spec`.** Only after sign-off: summarize the **handoff
   inventory** — the modules (deployable surfaces), each module's endpoints (the
   `[REQ]` inventory), the entities (`[NON]`/`[DTO]`s), and the external services
   (`[SRV]`s) — plus, when a two-seam prototype exists, the paths to its `objects/`
   + `commands.json` (the bridge-1 seed `rune:spec` ratifies) — and stop. The next step is `rune:spec` turning each module's endpoint
   inventory into a `rune check`-clean `.rune`. Do not write any `.rune`, design a
   data store (`rune:data`), prototype the UI (`sprig`), or build code (`rune:build`).

## Worked reference

Two real, signed-off artifacts ship with this skill — read them before you start, as
the canonical example of the house style and the spec→stories relationship:

- **`references/example-spec.md`** — a portable dev-workstation product spec. Study
  its section order, its single called-out **heart** ("the state model — where state
  lives"), its explicit **non-goals**, its `[DECIDE — D-host]`/`[D2]`/… decision
  discipline with recommended defaults, its `M0..M8` walking-skeleton-first ladder,
  its numbered risks-with-mitigations, and its honest **Verdict** naming the one
  thing to nail first. This is the shape to reproduce (scaled to your idea).
- **`references/example-user-stories.md`** — the stories *derived from* that spec:
  two roles, grouped by capability, every story in "As a … I want … so that …" form,
  with `_(detached)_`/`_(stopped)_` edge-state annotations. Note how each story
  traces back to a section of the spec — that traceability is the quality bar.

Copy their discipline, not their content. When both your artifacts read as cleanly as
these and the user has signed off, hand the module/endpoint inventory to
**`rune:spec`**.
