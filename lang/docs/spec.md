# Rune

Defines the notation used in `rune` files.

## Requirement

- Format: `[REQ] noun.verb(InputDto): OutputDto`
- Input **must** be a DTO (ends in `Dto`) or inline `{}`
- Output **must** be a DTO (ends in `Dto`)
- Last step of REQ **must** return the REQ's output DTO
- Represents the happy-path outcome (e2e test)
- Faults live under steps, not on the REQ line
- One requirement per externally-triggerable feature
- A `[REQ]` has **no HTTP surface of its own** — it is exposed only through an
  `[ENT]` that dispatches to it (see Entrypoint). A `[REQ]`-only module is a pure
  library module.
- `[REQ:open]` is the **openness marker** — the one modifier `[REQ]` takes. It
  declares that the endpoint is reachable **without a credential**. Unmarked
  means authenticated (the backend slot's default), so openness is always
  something the spec STATES, never something a reader infers.

```
[REQ] recording.set(GetRecordingDto): RecordingSetResponseDto
[REQ] recording.get(GetRecordingDto): RecordingDto
[REQ] recording.addMetadata(AddMetadataDto): AddMetadataResponseDto
[REQ:open] health.check({}): HealthDto
```

### Openness — where a route's policy comes from

The marker is not decoration; it is the whole of the endpoint's policy, and it
travels mechanically:

`[REQ:open]` → `access: "open"` on the generated `@Endpoint` →
`x-bedrock-auth: { access: "open" }` on the operation's OpenAPI →
a row in the policy table the backend hands the composition root, which resolves
it and answers.

An unmarked `[REQ]` emits no extension at all — which the root reads as the slot
default. Silence and an explicit "authenticated" stay distinguishable, so nothing
downstream has to guess what silence meant.

Mark an endpoint open when a caller with no credential must reach it: a health
check, a public read, the sign-in POST. Everything else stays unmarked. Getting
this wrong is now a one-line spec diff rather than a decorator someone has to
re-apply to generated code after every regeneration.

## Step

- Indented 4 spaces under parent requirement
- Format: `noun.verb(args): return-type`
- Args and return types can be types or DTOs
- No blank lines between steps within a requirement
- Double blank line between requirements

### Static vs Instance methods

Use `.` for instance methods and `::` for static methods:

```
    provider.getRecording(externalId): data         // instance method
    provider::pick(providerName): provider          // static method
```

**Instance methods** (`noun.verb()`):

- Operates on an instance
- `noun` must be returned by a previous step (in scope)

**Static methods** (`noun::verb()`):

- Class-level operation, no instance needed
- `noun` does NOT need to be in scope

The noun casing matches its `[TYP]` definition. If the type is defined as `[TYP] provider: Class`, use `provider::` for static calls and `provider.` for instance calls.

**Scope rules:**

```
    provider::pick(name): provider    // static - no scope check
    provider.getRecording(id): data   // instance - 'provider' must be in scope
    data.transform(): result          // instance - 'data' must be in scope
```

Each step's return value is added to scope for subsequent steps.

### Constructor shorthand

Use `[NEW]` to instantiate a class (the tag `[CTR]` is an accepted **synonym** —
the parser treats them identically — but `[NEW]` is canonical and is what the
whole example corpus uses; prefer it):

```
    [NEW] metadata
    [NEW] storage
```

- No parentheses, no return type
- Return type is always the class itself (implied)
- Adds the class name to scope for subsequent steps
- Signature intentionally unspecified - constructor details are implementation concerns

This keeps design specs focused on flow, not construction details.

### Built-in return step

Use `[RET]` to return a value created earlier in the flow. This is useful when the last operation is a side effect (like saving to DB) but you need to return a DTO created earlier:

```
    id::create(providerName, externalId): id
    id.toDto(): IdDto                    // create the DTO to return
    db:metadata.set(id, metadata): void  // side effect - returns void
    os:storage.save(id, data): void      // side effect - returns void
    [RET] IdDto                          // return the DTO created earlier

[SRV] (SIDECAR)db: DB_URL                      // backs db:metadata.set
    the project's primary datastore
    @docs https://docs.example.com/db
[SRV] (SDK)os: OBJECT_STORE_URL            // backs os:storage.save
    object storage for recording blobs
    @docs https://docs.example.com/storage
```

- Format: `[RET] value`
- `value` must be in scope (returned by a previous step)
- Sets the step output to `value` (satisfies REQ output requirement)
- No class or instance required - it's a built-in

### Boundary tags

A boundary step crosses a system boundary into a **backing service**. It is written `service:noun.verb(args): ret` — a single-colon service prefix. This is distinct from `Noun::verb()` (static, double colon) and `noun.verb()` (in-module business step). Business logic steps stay untagged.

The service name in the prefix **must** be declared once, in the project's shared `src/core/core.rune`, by a matching `[SRV]` block (see **`[SRV]` — backing services** below). There are no built-in boundary kinds anymore — `db:`, `fs:`, `ex:`, `os:` are not fixed tags but plain service names, and each one used as a prefix requires its own `[SRV]`. An undeclared `service:` prefix is a spec error.

**Boundary constraints:** Parameters and return types must be DTOs or primitives (`string`, `number`, `boolean`, `void`, `Uint8Array`). Custom types are not allowed at system boundaries.

Example: `db:task.save(TaskDto): void` (backed by `[SRV] (SIDECAR)db: DB_URL`).

### `[SRV]` — backing services (shared, in `src/core/core.rune`)

Services are **shared infrastructure**: every service referenced by a `service:` boundary prefix is declared exactly once, in a single `src/core/core.rune` (module `core`), and every other spec in the project resolves its boundary services from there. There is no import syntax — the engine always loads `<root>/src/core/core.rune`. A `[SRV]` declared in any other spec is an error (`rune-service-core-only`); move it to core.rune.

```
// src/core/core.rune
[MOD] core
[SRV] (SIDECAR)db: DB_URL
    the project's primary datastore
    @docs https://docs.example.com/db
```

Each `[SRV]` generates a shared client at `src/core/data/<service>/mod.ts` (a `<Name>Service` class). A module's per-noun data adapter imports and constructs that shared client for any boundary it calls.

- Format: `[SRV] (TRANSPORT)<service>: <ENV_VAR, ENV_VAR2>`
- `transport` is a closed set: `SDK`, `HTTP`, `WEBSOCKET`, `SIDECAR`, `NATIVE`. `NATIVE` is an **in-process runtime/std-lib boundary** (filesystem, subprocess, crypto, clock) — neither a network surface nor a co-located process; its declared faults map to synchronous throws. Its env-var list is optional (a root dir / binary path is legitimate config, but many `NATIVE` services need none)
- `<service>` is the name used in `service:` boundary prefixes (here `db:` in `db:task.save`)
- The trailing list names one or more environment variables (comma-separated) the generated adapter reads
- A one-line prose description is **required** on the next line, indented 4 spaces
- An `@docs <url>` line is **required**, indented 4 spaces and within the 80-column limit — its URL survives the inline-comment stripper. An `[SRV]` missing it is a hard parse error (`[SRV] <name> requires an @docs <url> line`). `rune codegen` surfaces the URL as an `@see <url>` JSDoc tag on the generated data-adapter method
- An undeclared `service:` prefix — one with no matching `[SRV]` — is a spec error

Here `db:task.save` is a boundary call to the service named `db`, declared by the `[SRV]` block; `SIDECAR` is the sidecar transport; `DB_URL` is its env var; the `@docs` line is the required documentation link.

### Polymorphic steps

When a step Noun names an interface rather than a concrete class, the step is polymorphic. Use `[PLY]` to mark the polymorphic step and `[CSE]` for each concrete case. Block scope is determined by indentation.

```
    [PLY] provider.getRecording(externalId): data
        [CSE] genie
        ex:provider.search(externalId): SearchDto
          not-found timed-out invalid-id
        ex:provider.download(url): data
          not-found timed-out
        [CSE] fiveNine
        ex:provider.search(externalId): SearchDto
          not-found timed-out invalid-id
        ex:provider.download(url): data
          not-found timed-out
    [NEW] metadata

[SRV] (HTTP)ex: PROVIDER_API_URL              // backs ex:provider.*
    the external recording provider's API
    @docs https://docs.example.com/provider
```

- `[PLY]` at 4 spaces opens a polymorphic block
- `[CSE]` at 8 spaces defines each concrete case (camelCase name)
- Steps inside cases at 8 spaces (same level as `[CSE]`)
- Faults inside cases at 10 spaces (2 deeper than step)
- Block ends when indentation returns to 4 spaces (no explicit closer)
- Each case can have different sub-steps; they share the interface return type

### Dto suffix

Args ending in `Dto` are external inputs requiring validation. Internal args (passed between steps) have no suffix.

### Inline DTO

Define a DTO shape inline using curly braces:

```
{prop:type, prop:type}
```

- Comma-separated fields
- Properties reference types (not primitives)
- Nested DTOs allowed: `{user:{id:id, name:name}, timestamp:timestamp}`
- Multi-line allowed for readability

Example:

```
[REQ] recording.set({provider:provider, externalId:externalId}): {internalId:internalId, status:status}
```

## Type Definition

Define named types using `[TYP]` blocks. Types are the primitive building blocks:

```
[TYP] id: string
[TYP] provider: Class
[TYP] metadata: Record<string, Primitive>
```

- Format: `[TYP] name: primitive`
- Built-in primitives: `string`, `number`, `boolean`, `void`, `Uint8Array`, `Class`
- `Primitive` is a built-in alias for `string | number | boolean`
- `Class` indicates a class type (use `::` for static methods, `.` for instance methods after returned)
- Generic types allowed: `Array<url>`, `Record<string, Primitive>`
- Tuple types allowed: `[id, name]`, `[x, y, z]`
- Types give semantic meaning to primitives (e.g., `id` vs raw `string`)
- Types that resolve to primitives (e.g., `url: string`) are valid at system boundaries

### Type modifiers

The bracket slot takes a comma-separated modifier list:

```
[TYP:uuid] id: string
    a unique identifier
[TYP:min=0,max=100] qty: number
    an order quantity
[TYP:ext,uuid] memberId: string
    minted by the members module
```

- Format: `[TYP:mod,mod,...] name: primitive` — one bracket slot, commas
- Routing/source modifiers (`core`, `ext`) and constraint modifiers
  (`uuid`, `min=0`, ...) compose freely in the same list
- Constraint modifiers become class-validator decorators on generated DTO
  fields — see **Constraint Modifiers** below for the full table

### Type Descriptions

Types can include multi-line descriptions indented 4 spaces below the definition:

```
[TYP] storage: Class
    a class representing the storage system used to save
    and retrieve recording data

[TYP] url: string
    a URL string pointing to a resource
```

- Description lines are indented 4 spaces
- Multiple lines are joined into a single description
- Descriptions appear in LSP hover tooltips
- Blank line ends the description block

## DTO Definition

Define reusable DTOs using `[DTO]` blocks. DTOs are composed of types:

```
[DTO] UrlDto: url
    a URL wrapper for external service responses

[DTO] GetRecordingDto: providerName, externalId
    input for retrieving a recording by provider and external ID

[DTO] SearchDto: url(s)
    a list of URLs returned by provider search
```

- Format: `[DTO] DtoName: prop1, prop2, ...`
- Name must end in `Dto`
- Properties are comma-separated inline
- Properties reference types or other DTOs (property name = type/DTO name)
- Description required on next line, indented 4 spaces
- DTOs can nest other DTOs (all ultimately resolve to primitives)
- Blank line ends the description block
- Defined after all requirements
- Referenced by name in requirements and steps

### Array properties

Use parenthesized suffix to indicate an array of a type:

```
[DTO] SearchDto: url(s)
    URLs returned by provider search endpoint
```

- `url(s)` → property name `urls`, type `Array<url>`
- `address(es)` → property name `addresses`, type `Array<address>`
- `child(ren)` → property name `children`, type `Array<child>`

The base type (before parentheses) must be a defined `[TYP]`. The suffix in parentheses is appended to form the property name.

## Fault

- Indented 2 spaces deeper than parent step (6 spaces under normal steps, 10 spaces inside poly cases)
- Multiple faults on single line, space-separated (e.g., `not-found timed-out invalid-id`)
- Line must not exceed 80 characters; wrap to next line if needed
- Fault names are lowercase, hyphen-separated (e.g., `not-found`, `timed-out`, `network-error`)
- Fault names describe _why_ something didn't succeed (not just "failed")
- Each fault implies a test case
- Steps with no faults cannot fail

## Comments

Inline comments use `//` syntax:

```
    provider.getRecording(externalId): data  // fetches from provider API
    // This step handles the main retrieval
    db:metadata.set(id, metadata): void
```

- Comments start with `//` and extend to end of line
- Can appear on their own line or after code
- Comments are ignored during validation

## File Conventions

- File extension: `.rune`
- Maximum 80 characters per line
- Indentation: 4 spaces for steps, 6 spaces for faults
- No blank lines between steps; double blank line between requirements

## Validation Rules

The LSP enforces these rules:

### Requirement validation

- REQ input must be a DTO (ends in `Dto`) or inline `{}`
- REQ output must be a DTO
- Last step must return the REQ's output DTO

### Scope validation

- Instance methods (`noun.verb()`) require `noun` to be returned by a previous step
- Static methods (`Noun::verb()`) have no scope requirements
- Parameters must be in scope: either returned by a previous step OR provided by the REQ input DTO
- REQ input DTO properties (including nested DTOs) are automatically in scope

### Indentation validation

- REQ at column 0
- Steps at 4 spaces
- Faults at 6 spaces (2 deeper than parent step)
- `[PLY]` at 4 spaces (step level)
- `[CSE]` at 8 spaces (inside poly block)
- Steps inside cases at 8 spaces
- Faults inside cases at 10 spaces

### Boundary validation

- Boundary parameters must be DTOs or primitives
- Boundary return types must be DTOs or primitives
- Every `service:` prefix must have a matching `[SRV]` declaration in the project's `src/core/core.rune`; an undeclared service is an error
- `[SRV]` may be declared ONLY in `src/core/core.rune` — one in any other spec is an error (`rune-service-core-only`)
- Every `[SRV]` must have a description line and an `@docs <url>` line; a missing `@docs` line is a hard parse error
- An `[SRV]` transport must be one of `SDK`, `HTTP`, `WEBSOCKET`, `SIDECAR`, `NATIVE`

### Type validation

- Parameters must reference defined types or DTOs
- Return types must reference defined types, DTOs, or `void`

### Signature consistency validation

- The same `noun.verb` or `Noun::verb` must have identical signatures throughout the document
- Parameters and return types must match across all calls to the same method
- Error shows the first occurrence's signature for reference

### Duplicate definition validation

- Each `[TYP]` name must be unique
- Each `[DTO]` name must be unique
- Duplicate definitions generate errors referencing the first occurrence

### Unused element validation

- All defined types (`[TYP]`) must be used somewhere
- All defined DTOs (`[DTO]`) must be used somewhere
- Unused elements generate warnings

### Constructor validation

- `[NEW] class` is the canonical constructor syntax (`[CTR]` is an accepted synonym)
- Constructor must reference a defined `[TYP]` with type `Class`

### DTO description validation

- Every `[DTO]` must have a description on the following line
- Description must be indented 4 spaces
- Missing descriptions generate an error

### Modifier validation

`[TYP]` modifiers are validated (the LSP and `rune check` emit identical
messages):

- Unknown modifier:
  `[TYP] unknown modifier "<m>" (allowed: ext, core, uuid, email, url, nonempty, json, int, min=<n>, max=<n>, positive, example=<value>, from=<path|path*|query|header>)`
- Constraint on the wrong base primitive:
  `[TYP] modifier "<m>" requires a <string|number> type, but "<name>" is <declaredType>`
- Missing or non-numeric value on `min`/`max`:
  `[TYP] modifier "<m>" requires a numeric value (e.g. min=0)`
  — and a value on a modifier that takes none:
  `[TYP] modifier "<m>" does not take a value`
- A `from=` source outside the closed set:
  `[TYP] modifier "from" must be one of path, path*, query, header (got "<v>")`

`[REQ]` takes exactly one modifier, `:open` (the openness marker). Any other is
an error: `[REQ] unknown modifier "<m>" — the only one is :open`. `[REQ:core]`
keeps its specific message — coordinators are module-level by definition.

## Module Directive

A `.rune` file describes one module. The `[MOD]` directive at the top of the file names it.

```
[MOD] recording
```

- Format: `[MOD] name`
- One per file, on the first non-comment line
- The name fills the `<module-name>/` slot in canonical-paths.json
- Optional — defaults to the rune filename without the `.rune` extension
- Names are kebab-case in the file system (`[MOD] my-feature` → `src/my-feature/`)

## Core Modifier

By default, every `[REQ]`, `[DTO]`, `[TYP]`, and untagged business step belongs to the current module (`src/<module-name>/...`). The `:core` modifier routes an element to the shared kernel (`src/core/...`) instead.

```
[DTO:core] CommonDto: a, b
    shared across all modules

[TYP:core] timestamp: number
    Unix epoch milliseconds
```

- Allowed on: `[DTO:core]`, `[TYP:core]`
- **Not allowed** on `[REQ:core]` — coordinators are module-level by definition; `core/` has no `coordinators/` slot
- Without the modifier, the element belongs to the current `[MOD]`
- Core elements are importable from any module; module elements are not

## Constraint Modifiers

Beyond routing (`core`) and sourcing (`ext`), the `[TYP]` bracket slot takes
**constraint modifiers** — runtime validation rules attached to the type.
Every generated DTO field of that type carries the matching class-validator
decorator, and the generated coordinator asserts them at every seam.

```
[TYP:uuid] id: string
    a unique identifier
[TYP:min=0,max=100] qty: number
    an order quantity
[TYP:ext,uuid] memberId: string
    minted by the members module
```

| Modifier   | Requires | Decorator (scalar)  | Decorator (`(s)` array)                |
| ---------- | -------- | ------------------- | -------------------------------------- |
| `ext`      | —        | —                   | —                                      |
| `core`     | —        | —                   | —                                      |
| `uuid`     | `string` | `@IsUUID()`         | `@IsUUID(undefined, { each: true })`   |
| `email`    | `string` | `@IsEmail()`        | `@IsEmail(undefined, { each: true })`  |
| `url`      | `string` | `@IsUrl()`          | `@IsUrl(undefined, { each: true })`    |
| `nonempty` | `string` | `@IsNotEmpty()`     | `@IsNotEmpty({ each: true })`          |
| `json`     | `string` | `@IsJSON()`         | `@IsJSON({ each: true })`              |
| `int`      | `number` | `@IsInt()`          | `@IsInt({ each: true })`               |
| `min=N`    | `number` | `@Min(N)`           | `@Min(N, { each: true })`              |
| `max=N`    | `number` | `@Max(N)`           | `@Max(N, { each: true })`              |
| `positive` | `number` | `@IsPositive()`     | `@IsPositive({ each: true })`          |
| `example=V`| any      | `@ApiProperty({ example: V })` | `@ApiProperty({ example: [V] })` |

- Modifiers are comma-separated in the single bracket slot; order is kept
- `example=<value>` takes free text (no commas — the list splits on them) and
  requires a non-empty value; it emits the swagger example keep's runner/cake
  fill required, unbound input fields from. Typed by the declared primitive.
- `ext` / `core` keep their semantics and compose with constraints
  (`[TYP:ext,uuid]` is both an external input and a UUID)
- `json` marks a `string` field that carries a JSON-encoded object/array over
  the wire (no typed `[DTO]`); `@IsJSON()` validates it PARSES at the boundary,
  so invalid JSON 422s at the seam instead of degrading silently downstream
- Only `min` / `max` take a value (`min=0`); the value must be numeric
- A constraint requires its base primitive: string constraints on `string`
  types, number constraints on `number` types
- `int` **replaces** `@IsNumber()` on the field (it is strictly narrower)
- A DTO array property of a constrained type (`qty(s)`) uses the
  `{ each: true }` decorator forms

## Entrypoint

`[ENT]` declares an inbound entrypoint — the inverse of a boundary call. Where `service:` boundary calls (e.g. `db:`, `os:`, `ex:`, each backed by an `[SRV]`) describe outbound calls to backing services, `[ENT]` describes an incoming surface (HTTP route, CLI command, queue handler).

```
[ENT] http.postRecording(GetRecordingDto): IdDto
    [REQ] recording.set(GetRecordingDto): IdDto
```

- Format: `[ENT] surface.action(InputDto): OutputDto`
- Maps to `src/<module>/entrypoints/<surface>/mod.ts` + `e2e.test.ts`
- The body of an `[ENT]` references the `[REQ]` it dispatches to
- The surface name (`http`, `cli`, `queue`, etc.) becomes the entrypoint folder name
- **`[ENT]` is the ONLY source of an HTTP surface.** Codegen emits an `@Endpoint`
  controller solely from `[ENT]` declarations — there is no auto-exposure of
  `[REQ]`s. A module with `[REQ]`s but no `[ENT]` generates **no controller, no
  route, no OpenAPI doc, and no rows in the cake walk**: `/docs/<module>` 404s and
  a headless run-all over it is vacuously empty. If the module is meant to be
  served, walked, or documented, declare an `[ENT]` per exposed `[REQ]`.
  (Entrypoint controllers are generated artifacts — never hand-write one.)

### HTTP verb & explicit route (`@ METHOD /template`)

Without a clause, an `[ENT]` is a **`POST`** at a route auto-derived from the action
name (plus any `[TYP:from=…]` fields). An optional `@ METHOD [/template]` clause
**between the name and the parens** overrides either or both:

```
[ENT] http.getTask    @ GET    /tasks/{id}(TaskRefDto): TaskDto
[ENT] http.listTasks  @ GET(ListTasksDto): TasksDto
[ENT] http.removeTask @ DELETE /tasks/{id}(TaskRefDto): OkDto
[ENT] http.proxy      @ POST   /proxy/{target}/{rest*}(ProxyReqDto): ProxyResDto
```

- Verbs: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` — anything else is an error
  (`[ENT] HTTP method must be one of GET, POST, PUT, PATCH, DELETE`). Uppercase by
  convention; matching is case-insensitive.
- `@ METHOD` alone (no template) sets just the verb — the route is still auto-derived.
- A template's `{name}` segments (and one trailing `{name*}` catch-all, which may span
  `/`) bind URL parts to same-named **input DTO fields** — the explicit-template twin
  of `[TYP:from=path|path*]`. Fields the template doesn't name stay where their
  `from=` puts them (body by default) — for a `GET`, route every input field via the
  template, `from=query`, or `from=header` (a GET carries no JSON body).
- **The verb is part of the contract, not free styling** (the waist rule — sprig's
  `contract.md`): reads are `GET` **queries** returning current-state DTOs
  (`<type>.all`, `<type>.get`); writes stay `POST` **command verbs**. `PUT`/`PATCH`
  exist for edge cases (an upstream contract you don't control) — never to model an
  "edit-this-record" endpoint.

### Process flows (branches)

The module's endpoints form a *process* (the cake walks them in order, chaining
outputs into inputs — metadata derived from the DTO field graph). A bracket modifier
names the **flow** an endpoint belongs to, expressing a branch:

> **Outputs declare what an endpoint *mints*, not what it *echoes*.** A field that
> appears in both an endpoint's input and output DTO is not treated as produced by
> it — only genuinely-minted outputs feed another endpoint's input. (Echo-fields
> would otherwise derive bogus producers and circular `dependsOn`.)
>
> **Process direction follows declaration order — declare `[ENT]`s in the order the
> process runs.** A producer edge only points backward to an earlier-declared
> endpoint; a `dependsOn` on a later endpoint would contradict the derived `order`.
> A field minted only by LATER endpoints is treated as an external input at that
> point in the process: it binds as `$field` (shown on the Module-inputs card;
> resolved from seeds, a captured same-named output on a later runner pass, or the
> schema `example=` at send time). Note a load-through output (a field an endpoint
> returns from storage rather than creates — e.g. a mutator echoing the record it
> loaded) still *counts* as minted statically; declaring endpoints in process order
> is what keeps such fields from deriving a backwards chain.

```
[ENT] http.start(StartDto): TicketDto
[ENT:card] http.payCard(PayDto): PaymentDto
[ENT:cash] http.payCash(PayDto): PaymentDto
[ENT] http.fulfill(FulfillDto): DoneDto
[ENT:optional] http.survey(SurveyDto): ThanksDto
```

- `[ENT:card]` / `[ENT:cash]` — the endpoint exists only in that named flow. Untagged
  endpoints are part of every flow. The cake shows a flow selector and walks one
  branch at a time; `exerciseEndpoints({ flow })` does the same headlessly.
- When the same field is produced by endpoints in **different** flows (here
  `paymentId`), the consumer (`fulfill`) is generated depending on all of them with
  the alternatives bound first-resolvable-wins — the join after the branch.
- `[ENT:optional]` (reserved) — the step is attempted but not required: its failure
  doesn't stop the cake's run-all or fail the harness report.

### WebSocket entrypoints (`[ENT:ws]`)

`[ENT:ws]` declares a **WebSocket** entrypoint instead of an HTTP route. It is a *socket
header* that names the surface and the handshake path once; the indented lines below it are
its **topics** — one message handler each:

```
[ENT:ws] chat @ /rooms/{room}
    join(JoinDto): JoinedDto      # topic "join"
    send(ChatDto): EchoDto        # topic "send"
    leave(LeaveDto): void         # topic "leave" — no reply
```

- Format: `[ENT:ws] <surface> @ /path`, then indented `verb(InputDto): OutputDto` topics.
- The client connects once to the handshake path; each message it sends is a JSON envelope
  `{ "topic": "<verb>", "data": <InputDto> }`. The matching topic handler validates `data`
  against its input DTO and may **return a reply DTO**, sent back **to that sender**. A
  `void` topic sends no reply.
- The verb is the message **topic**; the surface groups the topics into one socket. Each
  topic still dispatches to the `[REQ]` it matches by `(input, output)` signature, exactly
  like an HTTP `[ENT]`.
- **Handshake bindings are connection-scoped.** A `{name}` path segment (or a
  `[TYP:from=query]` field — e.g. an auth token, since a WS handshake can't set an
  `Authorization` header) is read **once at connect**, not per message: the per-message
  context carries only the topic and its `data`. Capture what a handler needs at connect.
- A WS entrypoint carries no HTTP verb, so it never appears in the OpenAPI document or the
  cake/headless endpoint walk. Maps to `src/<module>/entrypoints/<surface>/mod.ts` (a
  `@WsEndpointController` with one `@WsEndpoint` per topic). A surface is either HTTP or WS,
  never both.
- Out of scope today: server-initiated **broadcast** to other clients (a handler replies
  only to the sender) and binary / streaming frames.

### External inputs

`[TYP:ext]` marks a value as produced **outside this module** (another module's
endpoint, a human). An input field of that type which no endpoint in the module
produces is generated as a `$name` external-input bind — the cake lists it under
"module inputs" (set once, shared across docs pages; it can reference another
module's capture, e.g. `{{members:create.memberId}}`), and the headless runner takes
it from `overrides.seeds`:

```
[TYP:ext] memberId: string
    minted by the members module
```

#### Ghost stubs (the stub lifecycle)

An external input is a promise that *someone else* produces the value. Until that
producer exists, `rune sync` keeps the project runnable by generating
`bootstrap/stubs.ts` — a **ghost stub module** with one trivial GET endpoint per
unfulfilled `[TYP:ext]` input (`mint-<name>`, marked `stub: true`), each minting a
placeholder value of the declared primitive. It mounts like any module (cake at
`/docs/stubs`, badged `stub`), so dependent modules run end-to-end before their real
producers are built — the consumer's `$name` input auto-resolves from the stub's
capture.

- **Production exclusion** — the generated `bootstrap/modules.ts` registry skips the
  stub module when `DENO_DEPLOY=true` (every Deno Deploy revision sets it, and so
  does `env/prod`; `env/dev` carries it as `false` — the value is the signal, an
  app cannot set `DENO_*` on Deploy) or `DENO_ENV=production` elsewhere; stubs can
  never ship.
- **Evaporation** — the moment a synced module's endpoint outputs the field (a real
  producer anywhere in the project), the input is fulfilled and the next `rune sync`
  removes the stub endpoint — and deletes `bootstrap/stubs.ts` entirely once every
  input has a real producer. Business code never references the file, so nothing
  breaks when it goes.
- The file is generated-owned (header-guarded): a hand-written `bootstrap/stubs.ts`
  or a real module named `stubs` disables ghost stubs instead of being overwritten.

### `rune dev` (the live loop)

`rune dev [path]` runs the spec→cake loop unattended: it boots the project's app
(`deno run -A bootstrap/mod.ts`) under `KEEP_DEV=<status file>` and watches `src/`,
`specs/`, `bootstrap/`, and `deno.json` (never the bare root; sync's own writes are
muted so the loop can't feed on itself). On save:

- **spec changed** → `rune check` first. Errors are published to the status file
  **only** — keep's `/docs/_dev` serves them and the open cake pages show them in
  a red banner while the **last good server keeps serving**. A clean check runs
  `rune sync` and restarts the app.
- **source changed** → restart only (no sync).

Each restart mints a new `bootId`; the cake/map pages poll `/docs/_dev` and
reload themselves when it changes. Cake session state (statuses, captures,
edited bodies, module inputs) lives in `localStorage`, so it **survives every
restart and reload** — fix a spec, save, and re-run the failed step where you left
off.

## Keyword Tags

All keyword tags are exactly 3 letters inside brackets (`[XXX]`). This ensures content after the tag always starts at column 7, maintaining visual alignment.

| Tag     | Purpose                       |
| ------- | ----------------------------- |
| `[MOD]` | Module directive (top of file)|
| `[REQ]` | Requirement definition        |
| `[ENT]` | Inbound entrypoint            |
| `[SRV]` | Backing service declaration   |
| `[PLY]` | Polymorphic step              |
| `[CSE]` | Case inside polymorphic block |
| `[NEW]` | Constructor shorthand (synonym: `[CTR]`) |
| `[RET]` | Return value from scope       |
| `[TYP]` | Type definition               |
| `[DTO]` | DTO definition                |

Modifiers (appended inside the bracket; `[TYP]` takes a comma-separated list):

| Modifier                             | Applies to       | Effect                                 |
| ------------------------------------ | ---------------- | -------------------------------------- |
| `:core`                              | `[DTO]`, `[TYP]` | routes to `src/core/...`               |
| `:ext`                               | `[TYP]`          | value produced outside this module     |
| `:uuid` `:email` `:url` `:nonempty`  | `[TYP]` (string) | constraint → class-validator decorator |
| `:json`                              | `[TYP]` (string) | JSON-encoded blob; `@IsJSON()` parseability check |
| `:int` `:min=N` `:max=N` `:positive` | `[TYP]` (number) | constraint → class-validator decorator |

See **Constraint Modifiers** for the full decorator table.

## Traced Example

See `./example.rune` for a complete example demonstrating:

- REQ lines with DTO inputs and outputs
- Steps with `service:` boundary prefixes (`ex:`, `db:`, `os:`), each backed by an `[SRV]` declaration
- Polymorphic step with `[PLY]` and `[CSE]` cases
- Faults under steps
- Type definitions with `[TYP]` blocks
- DTO definitions with `[DTO]` blocks
