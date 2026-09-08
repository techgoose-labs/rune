---
name: "rune:docs"
description: >-
  The Swagger/Danet OpenAPI documentation surface of a rune-generated keep
  backend: set up the docs, and make a generated swagger doc more specific and
  useful per endpoint. Covers how DTO classes drive the schema (`@ApiProperty`
  and class-validator both emit the `design:type` the builder reads), the
  `[TYP:example=V]` modifier → `@ApiProperty({ example })` and why a required
  unbound field needs an example (else a guaranteed 422 in any walk), the three
  per-module pages `/api/docs/<m>` / `/api/docs/<m>/swagger` / `/api/docs/<m>/json` (the JSON
  is token-gated), the `@docs <url>` line on a `[SRV]` surfacing as an `@see`
  JSDoc tag on the generated adapter method, the smaller swagger exports
  (`@SwaggerDescription`, `DanetDocumentBuilder`, `setupWithSwagger`), and a
  summary of the browser docs-access token flow. Trigger when the user says "the
  swagger docs for this endpoint need a better example", "set up / customize the
  API docs", "the OpenAPI example is wrong", "document this endpoint", or names
  `@ApiProperty`, `example=`, `/api/docs/<m>/swagger`, `/api/docs/<m>/json`, or "@docs
  url". NOT the interactive cake walk at `/api/docs/<m>` (run/exercise the endpoints,
  red walk, heal) → use `rune:cake`; NOT the auth/trust posture on the docs
  routes (who may read `/json`, localhost/token rules) → use `rune:framework`;
  NOT the `[SRV]` declaration or the `@docs` REQUIREMENT itself, nor the
  `example=` modifier as a spec construct → use `rune:spec`.
---

# rune:docs — orchestration playbook

The Swagger/OpenAPI documentation surface of a rune backend. This skill delegates to
a single read-only specialist; the main session routes the diagnosis and then routes
the actual fix.

## Conduct

- **Never search the filesystem for references or artifacts.** Every skill reference lives at
  `~/.claude/skills/<skill>/references/<file>` — read exact paths. No `find /`, `find ~`, or
  whole-disk/home scans, ever (a measured orchestrator ran `find /` for a file whose path it knew).

## When this skill applies

A per-endpoint swagger doc/example needs to be sharper or is wrong; "document this
endpoint"; setting up/customizing the API docs; questions naming `@ApiProperty`,
`example=`, `/api/docs/<m>/swagger`, `/api/docs/<m>/json`, or `@docs <url>`.

## Specialist roster

- **`rune-docs-advisor`** — read-only: diagnoses a doc-surface issue and prescribes the
  exact spec edit + where it surfaces. Owns `references/swagger.md`.

## Flow

1. **Delegate** the question to `rune-docs-advisor` (Task tool). Pass: the symptom/endpoint,
   the project root + the relevant `spec/runes/<m>.rune` and generated DTO path, and the
   absolute path to `claude/skills/rune:docs/references/swagger.md` (or the installed
   `~/.claude/skills/rune:docs/references/swagger.md`).
2. It returns the diagnosis + the exact spec edit + where it surfaces. **Summarize** that.
3. **Apply the fix via `rune:spec`** (the `.rune` edit); the schema regenerates on the next
   `rune sync` (`rune:build`). The doc surfaces are static — tune them by tuning the spec,
   never by hand-editing generated code.

## Routing to siblings

- the interactive cake walk at `/api/docs/<m>` (Run-all, heal) → **`rune:cake`**
- the docs-route trust posture (who may read `/json`, localhost/token) → **`rune:framework`**
- the `[TYP:example=]` / `[SRV]` / `@docs` constructs as spec syntax → **`rune:spec`**

## Hard rule

The main session delegates the diagnosis to `rune-docs-advisor` and routes the actual
spec edit to `rune:spec`; it does not diagnose the doc surface inline.

## What's no longer here

The DTO→schema mechanics, the `@ApiProperty` merge, and the doc-setup exports now live in
`rune-docs-advisor` + `references/swagger.md`.
