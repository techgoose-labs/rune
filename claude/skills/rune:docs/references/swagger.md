# The Swagger / Danet documentation surface

The static OpenAPI doc a rune-generated keep backend publishes per module, and
how to make it specific and useful. The interactive walk on the same `/docs`
prefix belongs to the **`rune:cake`** skill; the trust posture on the docs
routes belongs to **`rune:framework`** (`references/auth.md`).

## DTO classes drive the schema

Each `@Endpoint(opts)` carries `input` / `output` DTO classes — they drive the
Swagger schema **and** the cake's generated request bodies. The schema builder
reads `design:type` reflection metadata off the DTO fields, and that metadata
is emitted by **either** `@danet/swagger`'s `@ApiProperty()` **or**
class-validator decorators (`@IsString()`, `@IsUUID()`, …). rune's codegen
emits class-validator decorators from the spec's `[TYP]` constraint modifiers,
and additionally merges everything documentable into **one** `@ApiProperty({…})`
umbrella per field — so every generated field is both validated and documented.

Everything in the doc derives from the `x-keep-process` vendor extension that
`@Endpoint` stamps into each module's OpenAPI doc, plus these DTO schemas. You
do **not** hand-edit the generated DTOs; you edit the `.rune` spec (see
**`rune:spec`**) and `rune sync` (see **`rune:build`**) regenerates them.

## The `@ApiProperty` umbrella — what each modifier maps to

`rune sync` builds one options object per field and emits a single
`@ApiProperty({…})` (two `@ApiProperty` on one property is undefined in
Swagger, so the merge is mandatory). The mapping from `[TYP]` modifiers and
DTO field markers:

| Spec | `@ApiProperty` key |
| --- | --- |
| `[TYP]` description (prose under the field) | `description` |
| `[TYP:example=V]` | `example` |
| `?` optional field | `required: false` |
| `(s)` array field | `isArray: true`, `type: String\|Number\|Boolean` (or `() => NestedDto`) |
| `min=N` / `max=N` | `minimum` / `maximum` |
| `positive` | `exclusiveMinimum: 0` (NOT `minimum: 1` — `@IsPositive` allows 0.5) |
| `int` | `type: "integer"` |
| `uuid` / `email` / `url` | `format: "uuid" \| "email" \| "uri"` |
| `nonempty` (scalar string) | `minLength: 1` |
| a `\|`-union of string literals (`[TYP]`) | `enum: [...]` (+ `@IsIn([...])`) |
| `Uint8Array` | `{ type: "string", format: "binary" }` |

Example — `[TYP:min=0,max=100,example=5] qty` written `qty(s)?`:

```ts
  @ApiProperty({
    description: "an order quantity",
    example: [5],
    required: false,
    isArray: true,
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @Min(0, { each: true })
  @Max(100, { each: true })
  qtys?: number[];
```

This is the surface you tune to make a generated swagger doc more
specific/useful **per endpoint**: a real description on each `[TYP]`, a
realistic `example=` on each required field, and the right constraint
modifiers so the schema documents the contract precisely.

## `example=` and the guaranteed 422

`[TYP:example=V]` is not a validator. It emits the swagger example the
runtime's headless runner and the cake **fill required, unbound input fields
from**. A required field with no producer, no `bind`, and no example is a
**guaranteed 422 in any headless walk** — `rune sync` warns about exactly
those fields. Typed zeros count as a real example; the empty-string
placeholder does not. So per-endpoint examples are load-bearing for the cake
and the runner, not decoration. When a walk goes red on a missing example,
diagnose with **`rune:cake`** and fix the `example=` in the spec via
**`rune:spec`**.

The value runs to the next comma/`]` (no commas inside) and is typed by the
declared primitive: `[TYP:example=3,min=1] qty: number` → `example: 3`. It
composes with `ext`: `[TYP:ext,example=orders]`.

## `@docs <url>` → `@see` on the generated adapter method

Every `[SRV]` block in `src/core/core.rune` requires an `@docs <url>` line.
(The `[SRV]` declaration and the requirement live in **`rune:spec`**.) Codegen
surfaces that url as an **`@see <url>` JSDoc tag on the generated data-adapter
method** — the per-noun adapter that fronts the service. Hovering the adapter
call in an editor links straight to the backing service's API docs. This is
the documentation payoff of the `@docs` requirement.

## The maximal codegen-enrichment story

rune's codegen surfaces far more of the discarded spec AST into generated code
as documentation than just `@ApiProperty`: `[NON]` descriptions become class
docs, declared faults become `@throws` JSDoc, `[TYP]` descriptions become DTO
field JSDoc and `@param`/`@returns`, the ordered step recipe becomes a comment
in `<verb>Core`, etc. Do not reproduce that here — point at the full spec:
`/Users/raphaelcastro/Documents/programming/rune/lang/docs/codegen-enrichment.md`
(it accounts for 100% of the parsed-then-discarded AST fields and the channel
each is surfaced through).

## Setting up / customizing the docs — the exports

Swagger is on by default through `bootstrapServer`. The lower-level exports
(the "smaller exports" of the keep package):

- `setupWithSwagger(server)` — configure an existing `Server` with the Swagger
  routes, **without starting it**. Use when you bootstrap by hand.
- `@SwaggerDescription(text)` — a module-level Swagger description.
- `DanetDocumentBuilder` — the lower-level OpenAPI builder; `Server` is the
  lower-level registry. Reach for these to construct the doc by hand.
- `InjectValue` / `InjectFactory` / `InjectClass` — DI container builders
  (not doc-specific, but they ride alongside the lower-level setup).

`@Endpoint({ description })` sets the per-endpoint description text in the
swagger doc; `@EndpointController(surface, { description })` sets the
controller-level description. `bootstrapServer` is bundler-safe — it
lazy-loads the Swagger builder and its CJS `handlebars` dep, so importing the
backend from a Fresh frontend works in both `deno task dev` and the production
build.

## The three pages, and docs access

| Path | What |
| ---- | ---- |
| `/api/docs/<module>` | the cake — guided ordered walk (→ **`rune:cake`**) |
| `/api/docs/<module>/swagger` | standard Swagger UI |
| `/api/docs/<module>/json` | the raw OpenAPI spec — **gated: in-process OR a `dev`-grant infra bearer** |

Module pages are named after the module class, lowercased, without the
`Module` suffix (`endpointModule("Orders", …)` → `/docs/orders`). The same
pages work mounted under Fresh (`/api/docs/...`).

### Docs access (summary)

**Where the pages live:** on the composed app the backend layer mounts every
backend route under `/api`, so the docs surface is `/api/docs/<module>` (spec at
`/api/docs/<module>/json`); a bare backend serves the same pages at `/docs/*`.
In-process dispatch is always unprefixed (`backend.fetch("/docs/app/json")`).

Since keep 5.0 the doc pages AND the OpenAPI spec (`/api/docs/<module>/json`) are
**open routes** — keep ships zero built-in auth, so a browser just opens them;
no token, no bearer. The legacy `?token=` → `localStorage` seeding script still
rides along in the pages but is inert (a stray token is ignored). If a
deployment composed its own guard over the app, satisfy that guard the app's
way. Auth model details → **`rune:framework`**'s `references/auth.md`.
