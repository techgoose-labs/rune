# Rune

Defines the notation used in `.rune` files. The tables in this document are
generated from `lang/keywords.json`, the language's single source — the prose
is hand-written. `rune check` is the gate; an editor's diagnostics (the LSP, the
Claude Code plugin) are exactly its findings; `rune fmt` owns the layout. Every
finding names a rule from the catalogue in `constraints.md`, and
`rune check --explain <id>` prints it.

## Lines

Every line declares its kind by its first token:

- `[TAG] …` — a declaration or a flow tag (the table below)
- `noun.verb(args): Type` / `Noun::verb(args): Type` — a step
- `service:noun.verb(args): Type` — a boundary step
- `! name name` — the faults of the step above
- `@docs <url>` — a service's documentation link
- anything else, indented under a declaration — its description
- `// …` — a comment, anywhere

Indentation is presentation: `rune fmt` writes the canonical columns (the
indent table below), and nesting is relative — a body line (an `[ENT]`'s
`[REQ]`, a socket's topics, a `[PLY]`'s cases) sits deeper than its opener.

<!-- rune:gen tags -->
| Tag | Indent | Syntax | Meaning |
| --- | --- | --- | --- |
| `[REQ]` | 0 | `[REQ] noun.verb(InputDto): OutputDto` | A requirement — one feature entry point, the happy-path end-to-end. Input is a DTO (or inline {}), output is a DTO; the last step (or a [RET]) yields the output; faults live on its steps, not here; scope resets at each [REQ]. `[REQ:open]` is the openness marker — the endpoint is reachable without a credential (the only modifier [REQ] takes). |
| `[MOD]` | 0 | `[MOD] name` | Names the module this file describes; fills the <module>/ path slot. The first non-comment line; kebab-case on disk. Optional (defaults to the filename). `[MOD] name: prose` plus indented continuation lines is the module's front-door description. |
| `[ENT]` | 0 | `[ENT] surface.action(InputDto): OutputDto     [REQ] noun.verb(InputDto): OutputDto` | An inbound entrypoint (HTTP route) — the inverse of a boundary. Its body is ONE indented `[REQ] noun.verb(In): Out` line naming the coordinator it dispatches to (required — there is no signature matching). An optional `@ METHOD /template` clause between the name and the parens sets the verb and the route; `{field}` segments (and one trailing `{field*}` catch-all) bind URL parts to same-named input fields. `[ENT:ws] <surface> @ /path` declares a WebSocket socket whose indented `verb(In): Out` topics each carry their own indented `[REQ]` body line. |
| `[PLY]` | 4 | `[PLY] noun.verb(args): type` | Opens a polymorphic block where the noun names an interface. Each [CSE] is a concrete implementation; they all share the interface's return type, and each case's last step yields it. The block ends at the first line indented no deeper than the [PLY] (the one place relative indentation carries meaning). |
| `[CSE]` | 8 | `[CSE] caseName` | A concrete case inside a [PLY] block (camelCase name), with its own sub-steps and faults, indented deeper than the [PLY]. |
| `[NEW]` | 4 | `[NEW] noun` | Constructor shorthand — instantiates a declared [NON] and adds it to scope under its own name. No parentheses, no return type; construction details are an implementation concern. |
| `[RET]` | 4 | `[RET] value` | Returns a value already in scope — by its name (`[RET] loaded`) or, for an unnamed value, by its type (`[RET] TaskDto`). Use it when the last step is a side effect. Redundant right after a step that already returns the output. |
| `[TYP]` | 0 | `[TYP:mod,mod] name: primitive` | A named semantic type built on a primitive (string, number, boolean, void, Uint8Array). Gives meaning to a raw primitive — `id` vs `string`. Generics (Array<url>), tuples ([x, y]) and string enums ("a" \| "b" — generated as a quoted union validated with @IsIn) are allowed. A [TYP] never resolves to a DTO; a noun is a [NON], never `[TYP] x: Class`. The bracket slot is a comma-separated modifier list: [TYP:ext,uuid], [TYP:min=0,max=100]. |
| `[DTO]` | 0 | `[DTO] NameDto: prop1, prop2` | A reusable data contract; the name must end in Dto. Properties reference types or other DTOs by name; `url(s)` is `urls: Array<url>`, `tag(s?)` an array whose elements are not validated (dirty inbound data), `name?` an optional property. A description is required on the next line. `[DTO:core]` routes it to src/core; `[DTO:open]` is an opaque inbound payload — declared fields are validated, undeclared fields ride through. Every DTO must be used. |
| `[NON]` | 0 | `[NON] noun` | Declares a noun (a subject / class) with a prose description on the following lines. [NEW] instantiates it; instance steps `noun.verb()` need it in scope; static steps `Noun::verb()` do not. Every [NON] must be used. |
| `[SRV]` | 0 | `[SRV] (TRANSPORT)<name>: <ENV, ENV2>     <description>     @docs <url>` | Declares a backing service — transport (one of the registry's transports, in parens), a name referenced by `service:` boundary prefixes, its env vars, a one-line prose description and a required `@docs <url>` line. Declared once, in src/core/core.rune; boundary calls reference it as service:noun.verb(...). |
<!-- /rune:gen -->

<!-- rune:gen indent -->
The columns `rune fmt` writes. Indentation is presentation: a line's kind is its first token, and only nesting is relative — a body line ([ENT] body [REQ], [ENT:ws] topics, [PLY] cases) is indented deeper than its opener.

| Line | Column |
| --- | --- |
| `[REQ]` `[ENT]` `[DTO]` `[TYP]` `[NON]` `[SRV]` `[MOD]` | 0 |
| steps, `[NEW]`, `[RET]`, `[PLY]` | 4 |
| faults (`!` lines) | 6 |
| `[CSE]` and the steps inside a case | 8 |
| faults inside a case | 10 |
| descriptions, `@docs` | 4 |
| an `[ENT]` body `[REQ]`, `[ENT:ws]` topics | 4 |

Lines are at most 80 characters.
<!-- /rune:gen -->

## Requirement

- Format: `[REQ] noun.verb(InputDto): OutputDto`
- Input **must** be a DTO (ends in `Dto`) or inline `{field, field}`
- Output **must** be a DTO (ends in `Dto`)
- The requirement ends by yielding its output: its last step returns it, or a
  `[RET]` names it (rule `last-step-returns-output`)
- Represents the happy-path outcome (e2e test); faults live under steps
- One requirement per externally-triggerable feature; `noun.verb` is unique
  (`duplicate-req-signature`), and the verb is never a JavaScript reserved
  word (`reserved-verb`) — it becomes the generated function's name
- A `[REQ]` has **no HTTP surface of its own** — it is exposed only through an
  `[ENT]` that names it (see Entrypoint). A `[REQ]`-only module is a pure
  library module.
- `[REQ:open]` is the **openness marker** — the one modifier `[REQ]` takes. It
  declares that the endpoint is reachable **without a credential**. Unmarked
  means authenticated (the backend slot's default).

```
[REQ] recording.set(GetRecordingDto): RecordingSetResponseDto
[REQ] recording.get(GetRecordingDto): RecordingDto
[REQ:open] health.check({}): HealthDto
```

### Openness — where a route's policy comes from

`[REQ:open]` → `access: "open"` on the generated `@Endpoint` →
`x-bedrock-auth: { access: "open" }` on the operation's OpenAPI → a row in the
policy table the backend hands the composition root. An unmarked `[REQ]` emits
no extension, which the root reads as the slot default. Mark an endpoint open
when a caller with no credential must reach it: a health check, a public read,
the sign-in POST.

## Step

- Format: `noun.verb(args): Type` — the value it yields is named by its type
- `noun.verb(args): Type as name` names the value instead (see Scope)
- Use `.` for an instance method (the noun must be a value in scope) and `::`
  for a static one (no instance needed)
- Every step declares what it yields; a side effect yields `void`
  (`missing-return-type`)
- Args are values in scope (see Scope); the same `noun.verb` has one signature
  throughout the document (`signature-consistency`)

```
    provider::pick(providerName): provider        // static: no instance
    provider.getRecording(externalId): data       // instance: provider in scope
    db:task.load(id): TaskDto as stored           // a named value
```

### Scope — the value model

A `[REQ]` starts with its input in scope: the input DTO under its type name and
the input's fields under their names (recursively through nested DTOs). Every
step adds the value it yields, named by its `as` name or, unnamed, by its type;
a DTO value also exposes its fields by name. `[NEW] noun` adds the noun under
its own name. A step's arguments and an instance step's noun must be in scope
(`param-scope`, `noun-in-scope`).

**One live value per name.** A value's default name is its type, so a second
value of the same type must be named with `as` (`value-duplicate`):

```
[REQ] task.copy(TaskRefDto): TaskDto
    db:task.load(id): TaskDto as stored
      ! not-found
    task::fromDto(stored): task
    task.toDto(): TaskDto
    db:task.save(TaskDto): void
      ! timeout
    [RET] TaskDto
```

A fluent step on a value (`task.fill(title): task`) yields the same value, not
a second one. Inside a `[PLY]` case the steps see the scope at the `[PLY]`, and
the case's last step yields the `[PLY]`'s value.

### Constructor shorthand

`[NEW] noun` instantiates a declared `[NON]` and adds it to scope. No
parentheses, no return type — construction details are an implementation
concern.

### Returning a value in scope

`[RET] value` ends a requirement with a value already in scope, by name
(`[RET] stored`) or, for an unnamed value, by type (`[RET] TaskDto`). Use it when
the last step is a side effect:

```
    id.toDto(): IdDto
    db:metadata.set(IdDto, MetadataDto): void
      ! timeout network-error
    [RET] IdDto
```

A `[RET]` right after a step that already returns the output is redundant
(`ret-redundant`).

### Boundary steps

A boundary step crosses a system boundary into a **backing service**:
`service:noun.verb(args): Type` — a single-colon service prefix, distinct from
`Noun::verb()` (static). The service **must** be declared once, in the
project's `src/core/core.rune`, by a matching `[SRV]` (`service-undeclared`).
There are no built-in boundary kinds: `db:`, `fs:`, `ex:` are plain service
names. Parameters and return types are DTOs or primitives (`boundary-types`).

### Faults

A fault line is `! ` followed by space-separated fault names, directly under
the step that raises it; a step with no faults cannot fail. A well-known name
carries its HTTP status from the registry; any other name declares its own:
`! card-expired=402` (`fault-status`). Codegen emits one typed class per fault
(`src/<module>/dto/faults.ts`, `NotFoundFault`, `CardExpiredFault`, …) and the
runtime answers a thrown fault with its status. Each fault implies a test case.

<!-- rune:gen faults -->
Fault lines are written `! name name=STATUS`: A fault line is `! ` followed by space-separated fault names, directly under the step that raises it. A well-known name carries its HTTP status from this table; any other name must carry its own (`! card-expired=402`). Codegen emits one typed fault class per name; the runtime maps a thrown fault to its status. Each fault implies a test case; a step with no faults cannot fail.

| Well-known fault | HTTP status | Meaning |
| --- | --- | --- |
| `not-found` | 404 | the subject does not exist |
| `conflict` | 409 | the write collides with current state |
| `timeout` | 504 | the service did not answer in time |
| `unavailable` | 503 | the service is down |
| `declined` | 402 | a payment was refused |
| `unauthorized` | 401 | no valid credential |
| `forbidden` | 403 | the caller may not do this |
| `network-error` | 502 | the service could not be reached |
| `invalid-*` | 422 | any `invalid-<what>` (and `invalid` itself): the input is unprocessable |
<!-- /rune:gen -->

### `[SRV]` — backing services (shared, in `src/core/core.rune`)

Every service a `service:` prefix names is declared exactly once, in
`src/core/core.rune` (`[MOD] core`); a `[SRV]` anywhere else is an error
(`srv-outside-core`). Each `[SRV]` generates a shared client at
`src/core/data/<service>/mod.ts`.

```
[SRV] (SIDECAR)db: DB_URL
    the project's primary datastore
    @docs https://docs.example.com/db
```

- Format: `[SRV] (TRANSPORT)<service>: <ENV_VAR, ENV_VAR2>` — the env list is
  optional for `NATIVE`
- A one-line prose description is required on the next line, and an
  `@docs <url>` line is required (`srv-docs-required`)

<!-- rune:gen transports -->
| Transport | Meaning |
| --- | --- |
| `SDK` | a vendor SDK / client library |
| `HTTP` | an HTTP API |
| `WEBSOCKET` | a WebSocket peer |
| `SIDECAR` | a co-located process (datastore, queue, object store) |
| `NATIVE` | an in-process runtime/std-lib boundary (filesystem, subprocess, crypto, clock) — neither a network surface nor a co-located process; its faults are synchronous throws and its env-var list is optional |
<!-- /rune:gen -->

### Polymorphic steps

When a step's noun names an interface rather than a concrete class, mark it
`[PLY]` and give each concrete case a `[CSE]`. Cases sit deeper than the
`[PLY]`; the block ends at the first line indented no deeper than the `[PLY]`.
One level of polymorphism per step (`ply-nested`); a `[PLY]` needs at least one
case (`ply-cases`).

```
    [PLY] provider.getRecording(externalId): data
        [CSE] genie
        ex:provider.search(externalId): SearchDto
          ! not-found timeout invalid-id
        ex:provider.download(urls): data
          ! not-found timeout
        [CSE] fiveNine
        ex:provider.search(externalId): SearchDto
          ! not-found timeout invalid-id
        ex:provider.download(urls): data
          ! not-found timeout
    [NEW] metadata
```

### Inline DTO

A requirement's input may be an inline shape: `{query, page}` — each field is
a `[TYP]` of the same name (or `{name:type}` to name the type).

## Type Definition

```
[TYP] id: string
[TYP] metadata: Record<string, Primitive>
[TYP] providerName: "genie" | "fiveNine"
```

- Format: `[TYP] name: primitive`
- Built-in primitives: `string`, `number`, `boolean`, `void`, `Uint8Array`;
  `Primitive` is the alias `string | number | boolean`
- Generics (`Array<url>`, `Record<string, Primitive>`), tuples (`[id, name]`)
  and **string enums** (`"a" | "b"`, quoted — generated as the quoted union and
  validated with `@IsIn`) are allowed
- A `[TYP]` never aliases a DTO (`type-not-dto`); a noun is a `[NON]`, never
  `[TYP] x: Class` (`class-retired`)
- Every `[TYP]` is used (`typ-unused`) and unique (`typ-unique`)
- A description may follow, indented, over several lines; it appears in editor
  hover and on the generated field

### Type modifiers

The bracket slot takes a comma-separated modifier list:
`[TYP:ext,uuid] memberId: string`, `[TYP:min=0,max=100] qty: number`. Routing
and source modifiers (`core`, `ext`) compose with constraints; a constraint
requires its base primitive. Constraint modifiers become class-validator
decorators on every generated DTO field of the type (`(s)` arrays use the
each-form).

<!-- rune:gen modifiers -->
| Modifier | Applies to | Kind | Requires | Decorator (scalar) | Decorator (array) | Meaning |
| --- | --- | --- | --- | --- | --- | --- |
| `[DTO:core] / [TYP:core]` | `[DTO]`, `[TYP]` | routing | — | — | — | Routes an element to the shared kernel (src/core/…) instead of the current module. Core elements are importable from any module; module elements are not. Allowed on [DTO] and [TYP]; not on [REQ]. |
| `[REQ:open]` | `[REQ]` | routing | — | — | — | The OPENNESS MARKER: this endpoint is reachable WITHOUT a credential. Codegen emits it as `access: "open"` on the generated @Endpoint, which surfaces as `x-bedrock-auth` on the operation's OpenAPI — where the backend's policy table comes from. An unmarked [REQ] is authenticated (the backend slot's default). The only modifier [REQ] takes. |
| `[TYP:ext]` | `[TYP]` | source | — | — | — | Marks a type whose value is produced OUTSIDE this module (another module's endpoint, a human). Entrypoint codegen turns unproduced input fields of this type into $name external-input binds (ghost stubs mint them in dev). Composes with constraint modifiers: [TYP:ext,uuid]. |
| `[TYP:uuid]` | `[TYP]` | constraint | `string` | `@IsUUID()` | `@IsUUID(undefined, { each: true })` | Constrains a string [TYP] to UUID format (class-validator @IsUUID). |
| `[TYP:email]` | `[TYP]` | constraint | `string` | `@IsEmail()` | `@IsEmail(undefined, { each: true })` | Constrains a string [TYP] to email format (class-validator @IsEmail). |
| `[TYP:url]` | `[TYP]` | constraint | `string` | `@IsUrl()` | `@IsUrl(undefined, { each: true })` | Constrains a string [TYP] to URL format (class-validator @IsUrl). |
| `[TYP:nonempty]` | `[TYP]` | constraint | `string` | `@IsNotEmpty()` | `@IsNotEmpty({ each: true })` | Constrains a string [TYP] to be non-empty (class-validator @IsNotEmpty). |
| `[TYP:json]` | `[TYP]` | constraint | `string` | `@IsJSON()` | `@IsJSON({ each: true })` | Marks a string [TYP] that carries a JSON-encoded object/array over the wire (no typed [DTO]); validates it PARSES at the boundary (class-validator @IsJSON) so invalid JSON 422s at the seam instead of degrading silently downstream. |
| `[TYP:int]` | `[TYP]` | constraint | `number` | `@IsInt()` | `@IsInt({ each: true })` | Constrains a number [TYP] to integers (class-validator @IsInt, replacing @IsNumber). |
| `[TYP:min=0]` | `[TYP]` | constraint | `number` | `@Min(N)` | `@Min(N, { each: true })` | Constrains a number [TYP] to a minimum value (class-validator @Min(N)). |
| `[TYP:max=100]` | `[TYP]` | constraint | `number` | `@Max(N)` | `@Max(N, { each: true })` | Constrains a number [TYP] to a maximum value (class-validator @Max(N)). |
| `[TYP:positive]` | `[TYP]` | constraint | `number` | `@IsPositive()` | `@IsPositive({ each: true })` | Constrains a number [TYP] to be positive (class-validator @IsPositive). |
| `[TYP:example=orders]` | `[TYP]` | doc | — | — | — | A real sample value for the field, emitted as @ApiProperty({ example }) — keep's runner and cake fill required, unbound input fields from it so headless walks don't 422. The value runs to the next comma/], so it cannot contain a comma. Composes: [TYP:ext,example=orders]. |
| `[TYP:from=query]` | `[TYP]` | binding | — | — | — | Field-source binding (OpenAPI's parameter model): where this field is populated from at the HTTP boundary — query \| header. Body is the default, so a field with no from= routes exactly as before. Path segments are bound by the [ENT]'s `@ METHOD /path/{field}` route template, never by a modifier. Composes: [TYP:from=query,example=widgets]. |
<!-- /rune:gen -->

## DTO Definition

```
[DTO] GetRecordingDto: providerName, externalId
    input for retrieving a recording by provider and external ID

[DTO] SearchDto: url(s)
    a list of URLs returned by provider search
```

- Format: `[DTO] NameDto: prop1, prop2, …` — the name ends in `Dto`
  (`dto-suffix`); a description is required on the next line (`dto-described`)
- A property names a `[TYP]`, a nested `[DTO]` (`PaymentDto`, or `payment` by
  the `<Name>Dto` convention); an unknown name is `dto-prop-undefined`
- `url(s)` is an array: property `urls`, type `Array<url>`
- `tag(s?)` is a lenient array: the elements are not validated (dirty inbound
  data rides through)
- `name?` is an optional property
- `[DTO:core]` routes the contract to `src/core/dto` (importable from any
  module); `[DTO:open]` is an opaque inbound payload — declared fields are
  validated, undeclared fields pass through
- Every `[DTO]` is used (`dto-unused`) and unique (`dto-unique`)

## Noun declaration

`[NON] noun` declares a subject (a class) with a prose description. `[NEW]`
instantiates it; instance steps need it in scope; static steps do not. Every
`[NON]` is used (`non-unused`).

## Module Directive

`[MOD] name` names the module (kebab-case on disk, `src/<name>/`); optional
prose after a colon and on indented lines is the module's front-door
description. Optional — defaults to the spec's filename.

## Core Modifier

`[DTO:core]` / `[TYP:core]` route an element to the shared kernel
(`src/core/…`), importable from any module. Not allowed on `[REQ]`
(`req-core`).

## Entrypoint

`[ENT]` declares an inbound entrypoint — an HTTP route. Its body is **one
indented `[REQ]` line naming the coordinator it dispatches to**; it is required
(`ent-delegate-required`) and there is no matching by signature.

```
[ENT] http.postRecording(GetRecordingDto): IdDto
    [REQ] recording.set(GetRecordingDto): IdDto
```

- Format: `[ENT] surface.action(InputDto): OutputDto`; the surface (`http`,
  `cli`, …) becomes the entrypoint folder
- **`[ENT]` is the ONLY source of an HTTP surface.** A module with `[REQ]`s but
  no `[ENT]` generates no controller, no route, no OpenAPI doc and no rows in
  the cake walk.
- A required input field nothing earlier in the process produces needs an
  `example=` on its `[TYP]`, or the cake's headless walk 422s on it
  (`unbound-input-needs-example`)

### HTTP verb & route (`@ METHOD /template`)

Without a clause an `[ENT]` is a `POST` at `/<surface>/<action>`. An optional
`@ METHOD [/template]` clause between the name and the parens overrides the verb
and, with a slash-led template, the route; `{field}` segments (and one trailing
`{field*}` catch-all) bind URL parts to same-named input-DTO fields. Query and
header fields are declared on the `[TYP]` with `from=query` / `from=header`;
path segments are bound only by the template.

```
[ENT] http.getTask    @ GET /tasks/{id}(TaskRefDto): TaskDto
    [REQ] task.get(TaskRefDto): TaskDto
[ENT] http.listTasks  @ GET(ListTasksDto): TasksDto
    [REQ] task.list(ListTasksDto): TasksDto
```

**The verb is part of the contract**: reads are `GET` queries returning
current-state DTOs, writes are `POST` command verbs. `PUT`/`PATCH` model an
upstream contract you don't control, never an edit-this-record endpoint
(`edit-record-endpoint`).

### Process flows (branches)

A bracket modifier names the flow an endpoint belongs to: `[ENT:card]`,
`[ENT:cash]` — the endpoint exists only in that branch; untagged endpoints are in
every flow. `[ENT:optional]` is attempted but never required. Outputs declare
what an endpoint **mints**, not what it echoes, and process direction follows
declaration order — declare `[ENT]`s in the order the process runs.

### WebSocket entrypoints (`[ENT:ws]`)

`[ENT:ws] <surface> @ /path` declares a socket; the indented `verb(In): Out`
lines are its topics, each with its own indented `[REQ]` body line:

```
[ENT:ws] chat @ /rooms/{room}
    join(JoinDto): JoinedDto
        [REQ] room.join(JoinDto): JoinedDto
    send(ChatDto): EchoDto
        [REQ] room.send(ChatDto): EchoDto
```

Handshake bindings (`{room}`, `from=query` fields) are read once at connect. A
surface is either HTTP or WS, never both (`surface-mixed`).

### External inputs and ghost stubs

`[TYP:ext]` marks a value produced outside this module. An input field of that
type which no endpoint in the module produces becomes a `$name` external-input
bind; until a producer exists, `rune sync` generates `bootstrap/stubs.ts`, a
ghost module minting placeholders (excluded when `DENO_DEPLOY=true`), and
removes it once every input has a real producer.

## Comments

`// …` starts a comment at the start of a line or after whitespace; `://` in a
URL is never a comment.

## File Conventions

- File extension: `.rune`
- Maximum 80 characters per line (`line-length`)
- Declarations after the requirements; a blank line ends a description block

## `rune dev` (the live loop)

`rune dev [path]` runs the spec→cake loop unattended: a saved spec is checked;
errors go to the status file keep's `/docs/_dev` serves (the last good server
keeps serving); a clean check runs `rune sync` and restarts the app. Cake
session state lives in `localStorage` and survives every restart.

## Traced Example

See `./example.rune` — part of the valid corpus, so it always checks clean.
