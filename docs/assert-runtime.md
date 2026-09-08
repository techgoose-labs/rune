# The assert runtime

Rune-generated coordinators validate every seam at runtime — request inputs,
data-adapter reads and writes, and core outputs — with a single tiny runtime:
`assert`. This document is the canonical reference for **where it lives, how it
ships, how generated projects reach it, and the invariants that keep it
correct.** For the *spec-authoring* side (which seams get asserted, context
labels, the `no-dto-cast` lint), see
[`rune:spec` → constraints.md, "Generated code: validated seams"](../claude/skills/rune:spec/references/constraints.md).

## Where it lives — bundled in keep, exported from JSR

The runtime is a single module in the keep backend framework:

- **Source:** `keep/src/assert/mod.ts` (this monorepo).
- **Package:** `@techgoose-labs/rune` (keep's JSR package — see `keep/deno.json`).
- **Subpath export:** keep declares `"./assert": "./src/assert/mod.ts"` in its
  `exports`, so consumers import it as **`@techgoose-labs/rune/assert`**.

There is **one** copy of this code and it is maintained in keep. Generated
projects do not vendor or inline it — they pull it from JSR. (Historically the
helper circulated as a standalone `assert.ts` snippet; the keep module is its
canonical, strictly larger successor and the only supported source.)

## How generated projects reach it — the `#assert` alias

Generated coordinator code imports the runtime through a stable alias:

```ts
import { assert } from "#assert";
```

`rune` writes the `#assert` alias into the consuming project's `deno.json`
import map. Two entrypoints do this, and they agree:

- **`rune sync`** — `REQUIRED_IMPORTS` in `src/rune/entrypoints/sync/mod.ts`
  writes both the framework pin and the assert subpath:

  ```jsonc
  "@techgoose-labs/rune": "jsr:@techgoose-labs/rune@^4",
  "#assert":            "jsr:@techgoose-labs/rune@^4/assert",
  ```

- **`rune init`** (sprig overlay) — `src/rune/entrypoints/init/mod.ts` merges the
  same map **additively** into the `deno.json` the sprig CLI wrote. It never
  clobbers sprig's own keys, so a sprig-scaffolded project keeps *its*
  `@techgoose-labs/rune` main pin; rune only *adds* the keys sprig lacks (here,
  `#assert`).

## The single-copy invariant

`class-transformer`'s `@Type` metadata store is **per module copy**. If the
project's DTO classes and the assert runtime resolve to two different copies of
`class-transformer` (or `class-validator`, or `reflect-metadata`), the second
copy sees no `@Type` registrations and nested validation silently degrades — or
`bootstrapServer()` throws at load because danet's `design:paramtypes` metadata
was wiped by a second `reflect-metadata` polyfill.

Two rules preserve the single copy. Both are load-bearing:

1. **Decorator-stack ranges match keep's.** The `class-validator` /
   `class-transformer` / `reflect-metadata` (and `@danet/swagger`) ranges that
   `rune sync` emits MUST equal the ranges keep declares in `keep/deno.json`.
   This is machine-checked by `scripts/check-keep-lockstep.ts`
   (`deno task check:lockstep`).

2. **The framework pin and the assert pin share a major.**
   `@techgoose-labs/rune` and `#assert` both resolve to *one* keep copy only if
   they pin the same major (`@^4` / `@^4/assert`). **Retarget both on every keep
   major bump** — the 3.0.0 release did `@^2 → @^3`; this doc's `@^4` is the
   4.x retarget. For a sprig-overlaid project, sprig's own `@techgoose-labs/rune`
   major must match this one too (rune preserves sprig's main pin but adds
   `#assert` at rune's major — a mismatch reintroduces two copies).

   > Note: rule 2 is **not** covered by the lockstep guard (which only checks the
   > decorator-stack ranges). Keep the two pins' major in step by hand when keep
   > releases a new major.

## API surface

From `keep/src/assert/mod.ts`:

| Call | Behavior |
|------|----------|
| `assert(Cls, plain, context?)` | Validate a plain object (or existing instance) against a class-validator DTO class. Returns the typed instance. Throws `RuneAssertError` on failure. |
| `assert.arrayOf(Cls, plain, context?)` | Validate every element; aggregates failures with index-prefixed paths (`0.title`, `2.qty`). |
| `assert.string(v, context?)` | Type guard → `string`. |
| `assert.number(v, context?)` | Type guard → `number`. **Finite only** — `NaN`/`Infinity` are rejected. |
| `assert.boolean(v, context?)` | Type guard → `boolean`. |
| `assert.uint8Array(v, context?)` | Type guard → `Uint8Array`. |

`context` is an optional label (e.g. `"task.load"`, `"task.create input"`) that
rune's generated code fills from the REQ's `noun.verb` and the boundary step —
it flows into the error so a 422 says *where* the check ran.

### Validation semantics

- **Whitelist strip.** Validation runs with `whitelist: true` — properties with
  no class-validator decorator are stripped. The DTO class *is* the contract;
  fields meant to carry free-form data are generated with `@Allow()`.
- **`[DTO:open]` (opaque inbound payload).** A DTO marked open carries
  `static __keepOpen = true`. `assert` validates the declared fields strictly
  (whitelist on — declared and nested DTOs keep their contracts) and then
  re-attaches the inbound payload's *extra top-level* fields. Absent the marker,
  behavior degrades gracefully to a plain strict whitelist across the
  rune/keep release boundary.
- **`enableImplicitConversion: false`.** No silent string→number coercion; the
  contract is checked as written.

## Failure → HTTP 422

A failed contract throws **`RuneAssertError`**:

```ts
class RuneAssertError extends Error {
  name = "RuneAssertError";
  target: string;              // "TaskDto", "TaskDto[]", "string"
  context: string | null;     // where the check ran, e.g. "task.load"
  failures: {                  // one leaf per violation
    path: string;              // dotted: "title", "lines.1.qty", "" for non-object
    constraint: string;        // class-validator id, or "type"
    message: string;
  }[];
}
```

keep's `bootstrapServer` recognizes this error (by name + failures shape) and
maps it to **HTTP 422** with a `{ target, context, failures }` body and dotted
failure paths. Entrypoint controllers stay validation-free — validation lives in
the coordinator.

## The escape hatch: `RUNE_ASSERT=off`

Setting `RUNE_ASSERT=off` turns every assert (instance, array, and primitive)
into a passthrough — a trusted-production mode that skips the per-request
validation cost. The flag is read **once at module load**; if the process lacks
env-read permission, asserts stay **on** (fail-safe).

## Related

- `claude/skills/rune:spec/references/constraints.md` — the seam-assert authoring
  rules and the `no-dto-cast` lint.
- `claude/skills/rune:framework/references/assert.md` — the framework
  specialist's operational reference (same facts, agent-facing).
- `scripts/check-keep-lockstep.ts` — the decorator-stack lockstep guard.
