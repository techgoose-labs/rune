---
name: "rune:framework"
description: >-
  The runtime that rune-generated Deno backends run on — the "back end" half of
  rune's world. Use when you tune or debug the *running* app rather than the
  `.rune` spec: what `bootstrapServer` returns (since keep 7.0 a **bedrock
  `Unit`** — the backend half of an app — plus keep's own `listen`/`stop`/
  `backend`/`docs`/`mount`/`policy` surface), the one in-process client and its
  WIRE paths (`bag.fetch("/api/users")`, never `/users`), the composition root
  `Bedrock({ ui, backend, auth })` in the git-root `serve.ts`, and why a request
  401s/403s. Covers auth as the THIRD SLOT (keep still ships none of its own;
  an auth unit's `verify` runs above every unit on every channel — network,
  in-process, scope-less — and `[REQ:open]` in the spec is what marks a route
  reachable without a credential), the `#assert`→`RuneAssertError`→HTTP 422
  mapping, the `@Endpoint`/`@EndpointController` option semantics
  (`order`/`dependsOn`/`bind`/`access`), the `exerciseEndpoints` headless runner
  + `POST /api/docs/_run`, the `/api/docs/_map` system map, and deployment
  (standalone via `Bedrock({ backend: api }).listen()`, the composed `ui/` +
  `server/` layout, Deno Deploy, and the one observability boundary). Trigger
  phrases: "why is auth failing / 401 / 403", "add auth to my app",
  "host the backend under a sprig UI", "deploy a sprig+keep app",
  "deploy to Deno Deploy", "what does bootstrapServer return",
  "what is Bedrock / the composition root", "why is my in-process call 404ing",
  "run exerciseEndpoints in CI". NOT the `.rune` language or modeling → use
  `rune:spec`; NOT generating/filling/testing a module → use `rune:build`; NOT
  the interactive cake walk / `/api/docs/<m>` UI / heal panel → use `rune:cake`;
  NOT Swagger examples / `@ApiProperty` / `/api/docs/<m>/json` doc content → use
  `rune:docs`.
---

# rune:framework — orchestration playbook

The runtime the generated code runs on, as a **router**. This skill is advisory
knowledge split across three reference-expert specialists; the main session reads
the request, routes it to the right specialist, and synthesizes the answer. It
does **not** answer runtime questions inline — it delegates.

## Conduct

- **Never search the filesystem for references or artifacts.** Every skill reference lives at
  `~/.claude/skills/<skill>/references/<file>` — read exact paths. No `find /`, `find ~`, or
  whole-disk/home scans, ever (a measured orchestrator ran `find /` for a file whose path it knew).

## When this skill applies

Tuning or debugging the *running* app (not the `.rune` spec): a 401/403, what
`bootstrapServer` returns, `@Endpoint` order/deps/bind, the headless runner, or
deploying / hosting under a sprig UI.

## Specialist roster

- **`rune-framework-auth`** — auth & trust: why a request 401s/403s, auth as
  the THIRD SLOT (an auth unit's `verify` above every unit on every channel),
  `[REQ:open]` and where a route's policy actually comes from, reading the
  caller with `identity(ctx)`, and the removed trust stacks + their inert env
  vars. Owns `references/auth.md`.
- **`rune-framework-runtime`** — the process layer: `bootstrapServer`, in-process
  `backend.fetch`, `@Endpoint`/`@EndpointController` semantics, the
  `exerciseEndpoints` runner + `POST /api/docs/_run` + `/api/docs/_map`,
  `@WsEndpoint`. Owns `references/endpoints.md`.
- **`rune-framework-deploy`** — deployment & hosting: the composition root
  `Bedrock({ ui, backend, auth })`, standalone `listen()`, `withBasePath` /
  `mountsSelf`, wire paths, Deno Deploy, the one observability boundary. Owns
  `references/deployment.md`.

## Flow

1. **Classify the question by domain** (main session):
   - auth / 401 / 403 / guard-layer placement / removed auth vars → `rune-framework-auth`
   - `bootstrapServer` / `@Endpoint` semantics / `order`·`dependsOn`·`bind` / the
     `exerciseEndpoints`·`/api/docs/_run`·`/api/docs/_map` runner surface / WS
     sockets → `rune-framework-runtime`
   - serving / the composition root / hosting under sprig / `withBasePath` /
     Deno Deploy / logging → `rune-framework-deploy`
2. **Delegate** to that specialist via the Task tool. Pass: the question/symptom
   (with the failing request + origin + any response body), the project root,
   optionally a running server's base URL, and **the absolute path to the
   specialist's reference file** (`claude/skills/rune:framework/references/<auth|endpoints|deployment>.md`,
   or the installed `~/.claude/skills/rune:framework/references/…`). The agent
   reads its own reference; do not paste it into the prompt.
3. **Summarize** the specialist's return (cause + cited rule + evidence + minimal
   fix) for the user. If the answer spans domains (e.g. "my deployed sprig app
   401s" = deploy mount + auth trust), call the second specialist with the first's
   finding as context, then synthesize both.
4. **Route real fixes out**: a spec change → `rune:spec`; a generated-body/test fix
   → `rune:build`; a real-data e2e walk → `rune:cake`; a per-endpoint Swagger
   example → `rune:docs`.

**Cross-cutting note (`#assert` → 422):** the runtime maps a failed `RuneAssertError`
to HTTP 422; `rune-framework-runtime` explains the mapping, but the *authoring* side
(where asserts/`[TYP]` modifiers come from) is **`rune:spec`**.

## Hard rule

The main session delegates to the named specialist; it does not answer the runtime
question itself. Each specialist is read-mostly and owns exactly one reference —
keep their domains distinct so routing stays unambiguous.

## What's no longer here

The per-domain how-to (the trust model, the `@Endpoint`/runner option surface, the
mounting recipes) now lives in the three specialists and their reference files —
this playbook only routes.
