# Rune Cookbook — modeling patterns

Patterns that aren't obvious from the syntax but make a module's process model
work the way the cake (emulator) and headless runner expect. The rules below are
about *how you shape DTOs and steps*, not the checker's rules (the language card
carries every rule with its message and fix).

## Outputs mint, they don't echo

The single most load-bearing rule. An endpoint's **output DTO declares what it
*mints*** — values that didn't exist before this call. A field that's in both the
input and the output is an *echo*, not a product.

```
# WRONG — `tableName` is echoed, so the deriver thinks `enable` PRODUCES it
[ENT] http.enable(EnableDto): EnableDto
[DTO] EnableDto: tableName, enabled

# RIGHT — outputs are only the freshly-minted fields
[ENT] http.enable(EnableDto): EnabledDto
[DTO] EnableDto: tableName
[DTO] EnabledDto: enabled
```

Echo-fields poison producer derivation: a downstream consumer of `tableName` will
pick `enable` as its producer, and if `enable` also consumes a field that consumer
mints, you get a cycle. Rune now drops cycle-closing edges and falls back to a
`$input` bind, but the model is only honest if outputs are mints.

## Page DTOs need a sample-id so per-record steps can chain

A query/list endpoint returns a page. If a downstream step operates on *one*
record (get / update / delete), it needs an id to bind from — but a page is a
list. Put a **sample id** field on the page DTO (e.g. the first row's id) so the
next step has something to chain off:

```
[ENT] http.list(QueryDto): PageDto
[ENT] http.get(RefDto): RecordDto

[DTO] PageDto: rows(s), sampleId   # sampleId = rows[0].id, minted for chaining
[DTO] RefDto: sampleId             # get binds sampleId ← list.sampleId
```

Without the sample id, `get` has no produced field to bind and becomes a manual
`$input` — the cake can't walk list → get automatically.

## `$input` vs capture-bind: who produces the value?

- **Capture-bind** (`field ← producer.field`) — the value is *minted by another
  endpoint in this composed app*. Derived automatically when an output field name
  matches an input field name. This is the default; prefer it.
- **`$input`** (`[TYP:ext]`) — the value comes from *outside the app*: a human, a
  tenant key, another service. It surfaces in the cake's **Module inputs** card
  and is supplied by seeds / the headless runner's `overrides.seeds`.

Rule of thumb: if some endpoint *in the module set* mints the field, let it
derive a capture-bind. Only mark `[TYP:ext]` when nothing produces it.

## `dependsOn` is data sequencing; preconditions are coordinator faults

`dependsOn`/`bind` express **data flow** — "this step needs that step's output."
They are not the place for business preconditions ("the account must be active",
"the table must be enabled"). Those belong in the coordinator as **faults** on the
relevant boundary step, so a violated precondition surfaces as a typed fault (and
a 4xx), not as a step that silently can't run.

```
# sequencing — payCard needs the ticket from start (data)
[ENT] http.payCard(PayDto): PaymentDto   # binds ticketId ← start.ticketId

# precondition — "ticket not already paid" is a fault on the write, not a dep
[REQ] checkout.payCard(PayDto): PaymentDto
    db:payments.charge(ChargeDto): ReceiptDto   // boundary: service:noun.verb
      ! already-paid=409                        // a fault, with its status

[SRV] (SIDECAR)db: DB_URL                             // declares service "db" (sidecar)
    the project's primary datastore
    @docs https://docs.example.com/db           // REQUIRED documentation link
```

`db:payments.charge` is a boundary call (single-colon `service:noun.verb`) to the
service named `db`, declared by the `[SRV]` block above; `SIDECAR` is the sidecar
transport, `DB_URL` its env var. The `@docs` line is required — a `[SRV]` without
it is a parse error.

## Teardown flows for destructive endpoints

A destructive endpoint (delete / disable / revoke) shouldn't gate the happy path,
and the cake's run-all shouldn't fire it mid-chain. Put it on its own **flow** so
it's walked deliberately, and order it last:

```
[ENT] http.create(NewDto): ThingDto
[ENT] http.use(RefDto): ResultDto
[ENT:teardown] http.delete(RefDto): VoidDto   # only walked in the `teardown` flow
```

The cake's flow selector lets you exercise `create → use` green, then switch to
`teardown` to clean up — without `delete` ever blocking or auto-running in the
main walk.

## GET queries need the explicit verb clause

Every `[ENT]` defaults to `POST`. A read endpoint modeled without a verb clause is a
POST-shaped query — wrong for caching, for the OpenAPI doc, and for the waist rule
(reads are queries). Ask for the verb with `@ METHOD [/template]` between the name and
the parens:

```
# WRONG — a read that generates POST /http/get-task with the id in the JSON body
[ENT] http.getTask(TaskRefDto): TaskDto

# RIGHT — a GET at an explicit route; {id} binds the same-named input field
[ENT] http.getTask @ GET /tasks/{id}(TaskRefDto): TaskDto

# Verb-only override — route stays auto-derived
[ENT] http.listTasks @ GET(ListTasksDto): TasksDto
```

Verbs: `GET | POST | PUT | PATCH | DELETE`. On a `GET`, route every input field —
template `{field}` / trailing `{field*}` catch-all, `[TYP:from=query]`, or
`[TYP:from=header]` — since a GET carries no JSON body. Commands stay `POST` intent
verbs; don't reach for `PUT`/`PATCH` to model an "edit-this-record" endpoint (the
waist rule).

## A WebSocket socket is a surface of topics

When the surface is a live socket rather than request/response, use `[ENT:ws]`. The
header declares the handshake path once; each indented verb is a message **topic**.
Model one verb per inbound message type — the topic *is* the discriminant, so you
don't need a union DTO:

```
[ENT:ws] chat @ /rooms/{room}
    join(JoinDto): JoinedDto      # client sends {topic:"join", data:{…}}; reply → sender
        [REQ] room.join(JoinDto): JoinedDto
    send(ChatDto): EchoDto
        [REQ] room.send(ChatDto): EchoDto
    leave(LeaveDto): void         # void ⇒ no reply
        [REQ] room.leave(LeaveDto): LeftDto
```

Each topic names the `[REQ]` it dispatches to on an indented body line, just like
an HTTP `[ENT]`, and a non-`void` return is sent back **to the sender**. Two things to remember: the
handshake bindings (`{room}`, and a `[TYP:from=query]` auth token — a WS handshake
can't set an `Authorization` header) are read once at connect, not per message; and a
handler can only reply to its own sender — fan-out/broadcast to other clients isn't
modeled (keep a connection registry yourself if you need it).
