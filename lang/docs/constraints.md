# Rune Constraints

What `rune check` enforces — every rule, with the exact message, the fix hint
and the reason — rendered from `lang/keywords.json`, the one place a rule is
declared. An editor's diagnostics (the LSP, the Claude Code plugin) are these
findings verbatim, and `rune check --explain <id>` prints a rule's entry. The
spec's shape and the scope model are described in `spec.md`; this file is the
catalogue.

A finding is `path:line: message [id]`, optionally followed by `fix: …`.
`error`s fail the check (`rune check` exits 2); `warning`s are reported and
never fail it. The registry's `enabled` / `severity` are the policy: a project
overlay may tune a rule that is not locked.

## Spec rules

<!-- rune:gen rules -->
| Rule | Severity | Message | Fix | Why |
| --- | --- | --- | --- | --- |
| `line-length` | error | `line exceeds {max} characters ({found})` | `wrap the line; a fault line may continue on the next `! ` line, prose on the next indented line` | Every line is at most the registry's column limit so a spec reads in any editor and diffs line by line. |
| `tag-indent` | warning | `{tag} should be indented {expected} spaces (found {found})` | `run `rune fmt`` | Indentation is presentation, owned by `rune fmt`: the registry's indent table says where each tag sits. The checker warns; it never changes meaning. |
| `mod-name` | error | `[MOD] needs a name — {syntax}` | — | The module directive names the module; an empty name cannot fill the src/<module>/ slot. |
| `mod-name-shape` | error | `[MOD] invalid name "{name}" — must start with a letter or "_" and use only letters, digits, "-", "_"` | — | A [MOD] name becomes a directory AND a JS identifier alias in the generated bootstrap registry, so it must be an identifier shape. |
| `mod-duplicate` | error | `duplicate [MOD]: already set to "{module}"` | `remove the second [MOD]` | A .rune file describes exactly one module. |
| `mod-underivable` | error | `no [MOD] directive and could not derive module name` | `add `[MOD] <name>` as the first line` | Without a [MOD] the module name comes from the spec's filename; a path the engine cannot map to a module needs the directive. |
| `req-signature` | error | `[REQ] missing or malformed signature — {syntax}` | — | A requirement is noun.verb(InputDto): OutputDto. |
| `req-modifier` | error | `[REQ] unknown modifier "{modifier}" — the only one is :open` | — | [REQ] takes exactly one modifier, the openness marker. |
| `req-core` | error | `[REQ:core] is invalid — coordinators are module-level` | — | core/ has no coordinators/ slot; a requirement always belongs to its module. |
| `ent-signature` | error | `[ENT] missing or malformed signature — {syntax}` | — | An entrypoint is surface.action(InputDto): OutputDto, optionally with `@ METHOD /template` between the name and the parens. |
| `ent-method` | error | `[ENT] HTTP method must be one of GET, POST, PUT, PATCH, DELETE (got "{method}")` | — | The route clause's verb is an HTTP method. |
| `ent-body-signature` | error | `[ENT] body [REQ] has a malformed signature` | — | The body line names the coordinator with its full signature. |
| `ent-body-modifier` | error | `[ENT] body [REQ] does not take a modifier` | — | Openness is declared on the top-level [REQ], not repeated in the body reference. |
| `ent-delegate-required` | error | `[ENT] {surface}.{action} names no [REQ] — add an indented `[REQ] noun.verb({input}): {output}` line under it{candidates}` | `{fix}` | An entrypoint dispatches to exactly the [REQ] its body names. There is no matching by signature: two [REQ]s with the same (input, output) would make the pick silent and wrong. |
| `ent-delegate-undefined` | error | `[ENT] {surface}.{action} delegates to [REQ] {noun}.{verb}, which is not defined` | — | The body [REQ] must exist in the same spec. |
| `surface-mixed` | error | `surface "{surface}" is declared as both an HTTP [ENT] and a WebSocket [ENT:ws]` | `give them distinct surfaces` | A surface is one controller: either HTTP routes or one WebSocket socket. |
| `ws-topic-shape` | error | `[ENT:ws] {surface}: malformed topic — expected "<verb>(InputDto): OutputDto"` | — | Each indented line under a socket header is one message topic. |
| `ws-header-signature` | error | `[ENT:ws] malformed — expected "[ENT:ws] <surface> @ /path"` | — | A socket header names the surface and the handshake path; topics are declared on the lines below, never on the header. |
| `ws-no-topics` | error | `[ENT:ws] {surface} has no topics — add at least one "<verb>(InputDto): OutputDto"` | — | A socket with no topics handles no message. |
| `srv-shape` | error | `[SRV] malformed — expected [SRV] (TRANSPORT)<name>: <ENV,…>` | — | A service declaration is a parenthesized transport, a name, and its env vars. |
| `srv-transport` | error | `[SRV] unknown transport "{transport}" — expected {transports}` | — | Transports are the registry's closed set. |
| `srv-docs-url` | error | `[SRV] {service}: @docs needs a URL` | — | The documentation link is the one piece of provenance a dev needs to wire the service. |
| `srv-docs-duplicate` | error | `[SRV] {service}: duplicate @docs link` | — | One documentation link per service. |
| `srv-docs-required` | error | `[SRV] {service} requires an @docs <url> line` | `add `    @docs <url>` under the description` | Every service declares where its documentation lives. |
| `srv-outside-core` | error | `[SRV] ({transport}){service} declared in a module spec — shared services must be declared once in {core}` | `move the [SRV] to {core} and delete it here` | Services are shared infrastructure, declared exactly once in src/core/core.rune and resolved from there by every module. |
| `core-spec-missing` | error | `no core.rune found under the resolved project root "{root}" — shared services live in its src/core/core.rune and none was found there, so the boundary service{plural} {services} cannot be resolved. Pass `--root <project-dir>` or move the spec into that project.` | — | Boundary services resolve against the project's core spec; a root with no core.rune is almost always a mis-resolved root. |
| `service-undeclared` | error | `undeclared service "{service}"` | `declare it as `[SRV] (TRANSPORT){service}: <ENV,…>` in src/core/core.rune` | A boundary prefix names a declared service; there are no built-in boundary kinds. |
| `dto-props` | error | `[DTO] missing properties — {syntax}` | — | A DTO lists its properties after the colon. |
| `dto-modifier` | error | `[DTO] unknown modifier "{modifier}" — expected :core or :open` | — | A typo here would silently degrade to a strict DTO that strips an inbound payload's fields at runtime. |
| `dto-prop-undefined` | error | `[DTO] {dto}: property "{prop}" has no [TYP] or [DTO]` | `declare `[TYP] {base}: <type>`` | Every property resolves to a declared type — a [TYP], a nested [DTO] (named directly or via the <Name>Dto convention) — so no generated field is `unknown`. |
| `typ-type` | error | `[TYP] missing type — {syntax}` | — | A type declaration names its primitive after the colon. |
| `typ-modifier-unknown` | error | `[TYP] unknown modifier "{modifier}" (allowed: {allowed})` | — | The bracket slot takes only the registry's modifiers. |
| `typ-modifier-base` | error | `[TYP] modifier "{modifier}" requires a {base} type, but "{name}" is {type}` | — | A constraint fits only its base primitive: string constraints on string types, number constraints on number types. |
| `typ-modifier-value` | error | `[TYP] modifier "{modifier}" requires a {kind} value (e.g. {example})` | — | min/max take a numeric value; example/from take text. |
| `typ-modifier-no-value` | error | `[TYP] modifier "{modifier}" does not take a value` | — | Only valued modifiers are written with `=`. |
| `typ-modifier-choice` | error | `[TYP] modifier "{modifier}" must be one of {values} (got "{value}")` | — | A closed-set modifier rejects anything outside its set. |
| `from-path-retired` | error | `[TYP:from={value}] is retired — path segments are bound by the [ENT]'s route template` | `write the route as `[ENT] surface.action @ METHOD /…/{{{name}}}(In): Out` (`{{{name}*}}` for a catch-all) and drop from={value}` | One form per concept: the route template on the [ENT] is the only path binding. |
| `class-retired` | error | `[TYP] {name}: Class is retired — a noun is a [NON]` | `replace it with `[NON] {name}` and a description` | [NON] declares a noun; [TYP] declares a primitive-backed type. Class was the second spelling of the first. |
| `non-name` | error | `[NON] missing name — {syntax}` | — | A noun declaration names its subject. |
| `ply-signature` | error | `[PLY] missing or malformed signature — {syntax}` | — | A polymorphic step has the shape of a step. |
| `ply-outside-req` | error | `[PLY] outside [REQ]` | — | Steps, including polymorphic ones, live under a requirement. |
| `ply-nested` | error | `nested [PLY] inside [CSE] not supported` | — | One level of polymorphism per step. |
| `ply-cases` | error | `[PLY] {noun}.{verb} requires at least one [CSE] (a polymorphic step needs ≥1 variant case)` | — | A [PLY] with no case generates a barrel pointing at nothing. |
| `cse-name` | error | `[CSE] missing case name — {syntax}` | — | A case names its variant. |
| `cse-outside-ply` | error | `[CSE] outside [PLY] block` | — | A case belongs to the polymorphic block above it. |
| `new-name` | error | `[NEW] missing noun — {syntax}` | — | [NEW] names the [NON] it instantiates. |
| `ctr-retired` | error | `[CTR] is retired — write `[NEW] {noun}`` | `run `rune fmt` (it rewrites [CTR] to [NEW])` | One spelling per concept. |
| `ret-value` | error | `[RET] missing value — {syntax}` | — | [RET] names the value it returns. |
| `boundary-signature` | error | `{service}: malformed signature — service:noun.verb(args): type` | — | A boundary step is the service prefix followed by a step signature. |
| `step-outside-req` | error | `step outside [REQ]: {kind}` | — | Every step belongs to the [REQ] above it. |
| `fault-outside-step` | error | `! fault line must follow a step` | — | A fault belongs to the step that raises it. |
| `fault-shape` | error | `fault name "{name}" must be lowercase, hyphen-separated (optionally =STATUS)` | — | Fault names are slugs: they become test names and class names. |
| `fault-marker` | error | `bare fault line — faults are written `! {names}`` | `prefix the line with `! ` (`rune fmt` does this)` | The `!` marker declares the line's kind, so indentation never has to. |
| `fault-status` | error | `fault "{name}" is not well-known and carries no status` | `write `! {name}=<HTTP status>` or use a well-known fault ({wellKnown})` | The runtime maps every fault to an HTTP status: well-known names from the registry, custom names from their declared status. |
| `unrecognized-line` | error | `unrecognized line: "{text}"` | — | Every line is a tag, a step, a fault, a service doc link, or prose under a declaration. |
| `dto-suffix` | error | `DTO name "{name}" must end in {suffix}` | — | The suffix marks a validated contract everywhere it is referenced. |
| `dto-described` | error | `[DTO] {name} needs a description on the next line` | — | The description is the contract's meaning; codegen puts it on the class. |
| `req-input-dto` | error | `requirement input "{input}" must be a DTO or inline {}` | — | Inputs are validated at the seam; only a DTO carries a contract. |
| `req-output-dto` | error | `requirement output "{output}" must be a DTO` | — | Outputs are validated at the seam; only a DTO carries a contract. |
| `boundary-types` | error | `{service}: boundary params/return must be DTO or primitive — got {bad}` | — | Only DTOs and primitives cross a system boundary. |
| `signature-consistency` | error | `{key} has an inconsistent signature ({got} vs {first})` | — | The same noun.verb has one signature throughout the document; the first occurrence defines it. |
| `duplicate-req-signature` | error | `[REQ] {key} is declared twice` | — | One requirement per noun.verb — a second declaration would overwrite the first coordinator. |
| `typ-unique` | error | `[TYP] {name} is defined more than once` | — | Names are unique per kind. |
| `dto-unique` | error | `[DTO] {name} is defined more than once` | — | Names are unique per kind. |
| `non-unique` | error | `[NON] {name} is defined more than once` | — | Names are unique per kind. |
| `typ-unused` | warning | `[TYP] {name} is never used` | — | A declared type no DTO or step references is dead vocabulary. |
| `dto-unused` | warning | `[DTO] {name} is never used` | — | A declared contract nothing references is dead vocabulary. |
| `non-unused` | warning | `[NON] {name} is never used` | — | A declared noun no step instantiates or calls is dead vocabulary. |
| `missing-return-type` | error | `step "{step}" is missing a return type` | `write `: void` for a side effect` | Every step declares what it yields; a side effect yields void. |
| `last-step-returns-output` | error | `last step must return {output} (the REQ output), got {got}` | `add `[RET] {output}` after the side effect` | A requirement ends by yielding its output: its last step returns it, or a [RET] names it. |
| `type-not-dto` | error | `[TYP] {name} must be a primitive — it can't reference DTO {ref}` | — | A [TYP] aliases a primitive; a DTO is referenced by name. |
| `noun-in-scope` | warning | `instance noun "{noun}" isn't in scope (use :: for static, or [NEW] it, or return it from an earlier step)` | — | An instance step operates on a value; the noun must be live in the requirement's scope. |
| `param-scope` | warning | `parameter "{param}" isn't in scope (return it from a prior step or take it from the input DTO)` | — | A step consumes only values in scope: the input DTO, its fields, and earlier results. |
| `undefined-ref` | warning | `"{ref}" is not a defined [TYP], [DTO], [NON], or primitive` | — | Every type a step or DTO names is declared. |
| `value-duplicate` | error | `a value named "{name}" is already in scope (from {from})` | `name this one: `… : {type} as <name>`` | One live value per name; a value's default name is its type, so a second value of the same type must be named with `as`. |
| `ret-redundant` | warning | `[RET] {value} is redundant — the step above already returns it` | `delete the [RET] line` | A [RET] exists for a flow whose last step is a side effect. |
| `unbound-input-needs-example` | warning | `input field "{field}" of {ent} has no producer and no example` | `add `example=<value>` to `[TYP] {field}`` | A required input field nothing produces is a guaranteed 422 in the cake/headless walk unless its [TYP] carries an example. |
| `edit-record-endpoint` | warning | `[ENT] {surface}.{action} is a {method} — model a command verb instead of editing a record` | — | The waist rule: reads are GET queries returning current-state DTOs; writes are POST command verbs. PUT/PATCH exist only for an upstream contract you don't control. |
| `reserved-verb` | error | `verb "{verb}" is a JavaScript reserved word and cannot name a generated function` | `rename the verb (e.g. {suggestion})` | Verbs become exported function and method names in the generated code. |
<!-- /rune:gen -->

## Generated-code rules (`rune lint`)

The architecture rules over the generated project — layers, module isolation,
validated seams, fault coverage, orphans:

<!-- rune:gen generated-rules -->
| Rule | Severity | Message | Fix | Why |
| --- | --- | --- | --- | --- |
| `dto-validation` | error | `generated DTO is missing runtime validation (class-validator / zod)` | — | generated DTO is missing runtime validation (class-validator / zod) |
| `fault-coverage` | error | `fault "{fault}" from {req} has no Deno.test in the generated tests` | — | fault "{fault}" from {req} has no Deno.test in the generated tests |
| `import-aliases` | warning | `generated file uses a "../" relative import — use an @ alias` | — | generated file uses a "../" relative import — use an @ alias |
| `external-imports` | warning | `generated file imports npm:/jsr: directly — use a # alias` | — | generated file imports npm:/jsr: directly — use a # alias |
| `signature-parity` | error | `integration file doesn't reference its DTO {dto}` | — | integration file doesn't reference its DTO {dto} |
| `layer-restrictions` | error | `{from} layer may not import {to} layer ({spec})` | — | {from} layer may not import {to} layer ({spec}) |
| `barrel-discipline` | warning | `re-exports are only allowed in mod-root / poly-mod / bootstrap files` | — | re-exports are only allowed in mod-root / poly-mod / bootstrap files |
| `poly-isolation` | error | `import into a poly structure must go through poly-mod ({spec})` | — | import into a poly structure must go through poly-mod ({spec}) |
| `module-isolation` | error | `module {from} may not import module {to}'s internals ({spec}) — use core/ or its mod-root` | — | module {from} may not import module {to}'s internals ({spec}) — use core/ or its mod-root |
| `data-class-returns` | error | `data-layer method returns a raw object — return a validated instance (assert/plainToInstance)` | — | data-layer method returns a raw object — return a validated instance (assert/plainToInstance) |
| `no-dto-cast` | error | `coordinator casts to "{dto}" — validate the seam with assert({dto}, ...) instead of a blind cast` | — | coordinator casts to "{dto}" — validate the seam with assert({dto}, ...) instead of a blind cast |
| `poly-detection` | warning | `{count} sibling features export {name} with compatible signatures — extract a poly structure` | — | {count} sibling features export {name} with compatible signatures — extract a poly structure |
| `poly-stray` | warning | `feature extends poly base {base} — it likely belongs inside that poly structure` | — | feature extends poly base {base} — it likely belongs inside that poly structure |
| `forbidden-dirs` | error | `directory "{name}" is not allowed — name folders by role, not as generic buckets` | — | directory "{name}" is not allowed — name folders by role, not as generic buckets |
| `loose-files` | warning | `loose grab-bag file "{name}" — put code in a named feature/role folder` | — | loose grab-bag file "{name}" — put code in a named feature/role folder |
| `module-fragmentation` | warning | `module {module} has only {count} source files (< {min}) — consider consolidating` | — | module {module} has only {count} source files (< {min}) — consider consolidating |
| `orphan-files` | error | `file sits in a rune-managed slot but no rune element declares it (orphan)` | — | file sits in a rune-managed slot but no rune element declares it (orphan) |
| `heal-todo` | warning | `heal-rules entry still carries todo: true — enrich it (strict-gated: errors under rune lint --strict)` | — | heal-rules entry still carries todo: true — enrich it (strict-gated: errors under rune lint --strict) |
<!-- /rune:gen -->

## Indentation

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

## Generated code: validated seams

Generated coordinators validate every seam at runtime via
`import { assert } from "#assert"` — keep's assert runtime; `rune sync` maps
the `#assert` alias in the project's `deno.json`. Context labels use the
REQ's `noun.verb` for input/result and the boundary step's `noun.verb` for
reads/writes:

- the request **input**: `assert(InputDto, input, "task.create input")`,
  first statement of the shell
- every data-adapter **read**: `assert(TDto, await ..., "task.load")`;
  reads whose type resolves to a primitive use
  `assert.string` / `assert.number` / `assert.boolean` / `assert.uint8Array`
- every DTO **write** argument before it leaves:
  `assert(WDto, out.field, "task.save input")`
- the **result**:
  `return assert(OutputDto, out.result, "task.create output")`

A failed contract throws `RuneAssertError`; keep maps it to HTTP 422 with
`{ target, context, failures }` and dotted failure paths (`lines.1.qty`).
Named types with no runtime contract keep an `as` cast plus a trailing
`// unvalidated: <type> has no runtime contract` comment. `RUNE_ASSERT=off`
turns every assert into a passthrough (trusted prod mode). Entrypoint
controllers stay validation-free — validation lives in the coordinator.

## Generated code: faults

Every fault a module declares is a class in `src/<module>/dto/faults.ts`
extending keep's `RuneFault` with the fault's name and HTTP status
(`! not-found` → `NotFoundFault`, 404; `! card-expired=402` →
`CardExpiredFault`, 402). A coordinator throws one; keep's bootstrap answers
with that status and `{ name: "RuneFault", fault, status, message }`.
