# Rune — the language card

GENERATED from lang/keywords.json and fixtures/corpus by scripts/gen-lang-docs.ts — do not edit by hand.

A `.rune` file is one module: requirements ([REQ]) made of steps, the entrypoints ([ENT]) that dispatch to them, and the data they name ([DTO], [TYP], [NON]). Shared services ([SRV]) live once in `src/core/core.rune`. Every line's kind is its first token; indentation is what `rune fmt` writes. `rune check` is the gate and the editor's diagnostics are its findings, each with a rule id from the catalogue below; `rune check --explain <id>` prints a rule.

## Grammar by example

Every spec below checks clean.

### all-tags.rune

```rune
[REQ] order.place(PlaceOrderDto): ReceiptDto
    [NEW] cart
    cart.total(items): PriceDto
      ! empty-cart=422
    db:order.save(PlaceOrderDto): IdDto
      ! timeout network-error
    receipt::build(IdDto, PriceDto): ReceiptDto
    db:receipt.log(ReceiptDto): void
    [RET] ReceiptDto

[NON] cart
    a shopping cart holding line items before checkout
[NON] receipt
    the receipt handed to the customer

[TYP] price: number
    a positive monetary amount

[DTO] PlaceOrderDto: items
    the order the customer wants to place

[DTO] PriceDto: price
    a computed price

[DTO] IdDto: id
    a persisted order identifier

[DTO] ReceiptDto: id, price
    the receipt returned to the customer

[TYP] items: string
    the items
[TYP] id: string
    the id

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db
```

### boundaries.rune

```rune
[REQ] sync.run(SyncDto): ResultDto
    db:store.read(id): RecordDto as stored
      ! not-found
    fs:disk.load(id): RecordDto as cached
      ! not-found
    mq:queue.publish(stored): void
      ! timeout
    ex:api.fetch(id): RecordDto as remote
      ! timeout not-found
    os:blob.put(cached): void
      ! timeout
    lg:audit.write(remote): void
    result::of(id): ResultDto

[DTO] SyncDto: id
    what to sync

[DTO] RecordDto: id, payload
    a stored record

[DTO] ResultDto: id
    the sync result

[TYP] id: string
    an identifier
[TYP] payload: string
    the payload

[NON] result
    the outcome of a sync

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db

[SRV] (SIDECAR)fs: FS_ROOT
    file storage
    @docs https://docs.example.com/fs

[SRV] (SIDECAR)mq: MQ_URL
    message queue
    @docs https://docs.example.com/mq

[SRV] (HTTP)ex: EX_URL
    external http service
    @docs https://docs.example.com/ex

[SRV] (SIDECAR)os: OS_ENDPOINT
    object storage
    @docs https://docs.example.com/os

[SRV] (SIDECAR)lg: LOG_URL
    log sink
    @docs https://docs.example.com/lg
```

### core-modifiers.rune

```rune
[REQ] audit.record(LocalDto): AuditDto
    clock::now(): timestamp
    audit::build(id, timestamp): AuditDto

[TYP:core] id: string
    a globally shared identifier type

[TYP:core] timestamp: number
    an epoch-millis timestamp shared across modules

[DTO:core] AuditDto: id, timestamp
    a shared audit record usable from any module

[DTO] LocalDto: id
    a module-local contract that references a core type

[NON] clock
    the wall clock
[NON] audit
    an audit record in the making
```

### ent-dispatch-and-prose-periods.rune

```rune
[MOD] sample

[REQ] fragment.ingest(FragmentDto): AckDto
    db:fragment.save(FragmentDto): AckDto
      ! write-failed=503

[ENT] http.ingest(FragmentDto): AckDto
    [REQ] fragment.ingest(FragmentDto): AckDto

[DTO] FragmentDto: service
    one tier's fragment, posted to the collector (e.g. web, backend)
[DTO] AckDto: ok
    acknowledgement that the fragment was stored

[TYP:example=backend] service: string
    the tier that produced the span (e.g. web, backend)
[TYP] ok: boolean
    whether the ingest was accepted

[NON] fragment
    a profiler trace fragment from one tier (e.g. web)

[SRV] (SIDECAR)db: DB_URL
    the datastore, e.g. a local sqlite file
    @docs https://docs.example.com/db
```

### ent-route-template.rune

```rune
[MOD] gateway

[ENT] http.proxy @ POST /proxy/{target}/{path*}(ProxyReqDto): ProxyResDto
    [REQ] proxy.run(ProxyReqDto): ProxyResDto

[REQ] proxy.run(ProxyReqDto): ProxyResDto
    upstream::call(ProxyReqDto): ProxyResDto
      ! unavailable

[DTO] ProxyReqDto: target, path, q, payload
    a request proxied to an upstream service
[DTO] ProxyResDto: status
    the upstream response

[TYP:example=api] target: string
    the upstream host segment, named in the route template
[TYP:example=v1/users] path: string
    the remaining upstream path (the {path*} catch-all)
[TYP:from=query,example=widgets] q: string
    a forwarded query parameter
[TYP:example=hello] payload: string
    the forwarded request body
[TYP] status: number
    the upstream status code

[NON] upstream
    the service being proxied to
```

### entrypoint.rune

```rune
[MOD] checkout

[ENT] http.createOrder(NewOrderDto): OrderDto
    [REQ] order.create(NewOrderDto): OrderDto
[ENT] http.payOrder(PayDto): ReceiptDto
    [REQ] payment.pay(PayDto): ReceiptDto

[REQ] order.create(NewOrderDto): OrderDto
    [NEW] order
    order.open(item): OrderDto
    db:order.save(OrderDto): void
      ! timeout
    [RET] OrderDto

[REQ] payment.pay(PayDto): ReceiptDto
    db:payment.charge(id): ReceiptDto
      ! timeout

[DTO] NewOrderDto: item
    a new order to create
[DTO] OrderDto: id, item
    a created order
[DTO] PayDto: id
    a payment for an order
[DTO] ReceiptDto: receipt
    a receipt for a payment

[TYP:example=lamp] item: string
    the item to order
[TYP] id: string
    the order id
[TYP] receipt: string
    the receipt code

[NON] order
    a customer order

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db
```

### example-e2e.rune

```rune
[REQ] registerRecording(GetRecordingDto): IdDto
    id::create(providerName, externalId): id
    provider::pick(providerName): provider
      ! not-found
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
    metadata.toDto(): MetadataDto
    id.toDto(): IdDto
    db:metadata.set(IdDto, MetadataDto): void
      ! timeout network-error
    [NEW] storage
    os:storage.save(IdDto, data): void
      ! timeout network-error
    [RET] IdDto


[REQ] getRecording(GetRecordingDto): RecordingDto
    id::create(providerName, externalId): id
      ! invalid
    id.toDto(): IdDto
    [NEW] storage
    os:storage.load(IdDto): DataDto
      ! not-found timeout network-error
    [NEW] metadata
    db:metadata.get(IdDto): MetadataDto
      ! not-found timeout network-error
    recording::create(DataDto, MetadataDto): recording
      ! invalid-data invalid-metadata
    recording.toDto(): RecordingDto


[REQ] setRecordingMetadata(SetMetadataDto): MetadataDto
    id::create(providerName, externalId): id
      ! invalid
    id.toDto(): IdDto
    db:metadata.get(IdDto): MetadataDto as stored
      ! not-found timeout network-error
    db:metadata.set(IdDto, MetadataDto): void
      ! timeout network-error
    [RET] MetadataDto


[NON] storage
    a class representing the storage system used to save
    and retrieve recording data
[NON] metadata
    a key-value pair object containing metadata about the
    recording
[NON] recording
    a class representing a recording, which includes both
    the binary data and associated metadata
[NON] id
    a unique identifier for the recording generated by
    the system
[NON] provider
    an instance of the provider class

[TYP] url: string
    a URL string
[TYP] providerName: "genie" | "fiveNine"
    the name of the provider from which the recording is
    sourced
[TYP] externalId: string
    the identifier used by the provider to reference the
    recording
[TYP] data: Uint8Array
    the binary data of the recording


[DTO] SearchDto: url(s)
    a list of URLs returned by provider search
[DTO] GetRecordingDto: providerName, externalId
    input for retrieving a recording by provider and external ID
[DTO] SetMetadataDto: GetRecordingDto, MetadataDto?
    input for setting metadata on a recording
[DTO] DataDto: data
    wrapper for binary recording data
[DTO] MetadataDto: metadata?
    wrapper for recording metadata
[DTO] RecordingDto: data, metadata?
    complete recording with data and metadata
[DTO] IdDto: providerName, externalId
    unique identifier combining provider and external ID

[SRV] (HTTP)ex: EX_URL
    external http service
    @docs https://docs.example.com/ex

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db

[SRV] (SIDECAR)os: OS_ENDPOINT
    object storage
    @docs https://docs.example.com/os
```

### faults-0-1-many.rune

```rune
[REQ] payment.charge(ChargeDto): ChargeResultDto
    card::validate(ChargeDto): ChargeDto as validated
    ex:gateway.authorize(validated): AuthDto
      ! declined
    db:ledger.record(AuthDto): ChargeResultDto
      ! timeout network-error conflict

[NON] card
    a payment card presented by the customer

[DTO] ChargeDto: amount
    a request to charge a card

[DTO] AuthDto: token
    an authorization from the gateway

[DTO] ChargeResultDto: token, amount
    the settled charge

[TYP] amount: number
    the amount
[TYP] token: string
    the token

[SRV] (HTTP)ex: EX_URL
    external http service
    @docs https://docs.example.com/ex

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db
```

### from-sources.rune

```rune
[MOD] gateway

[ENT] http.search @ GET(SearchReqDto): SearchResDto
    [REQ] search.run(SearchReqDto): SearchResDto

[REQ] search.run(SearchReqDto): SearchResDto
    index::query(q, limit, tenant): SearchResDto

[DTO] SearchReqDto: q, limit, tenant
    a search, its fields read from the query string and a header
[DTO] SearchResDto: hits
    the search result

[TYP:from=query,example=widgets] q: string
    a forwarded query parameter
[TYP:from=query,int,example=10] limit: number
    the page size, from the query string
[TYP:from=header,example=acme] tenant: string
    the tenant, from a request header
[TYP] hits: number
    how many documents matched

[NON] index
    the search index
```

### inline-dto.rune

```rune
[REQ] search.run({query, page}): ResultsDto
    db:index.query(query, page): ResultsDto
      ! timeout

[DTO] ResultsDto: items
    the matched results

[TYP] query: string
    the query
[TYP] page: number
    the page
[TYP] items: string
    the items

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db
```

### laststep-nonoutput.rune

```rune
[MOD] search

[REQ] search.run(QueryDto): ResultsDto
    db:index.query(QueryDto): ResultsDto
      ! timeout
    db:audit.record(ResultsDto): AuditDto
    [RET] ResultsDto

[DTO] QueryDto: query
    a search query

[DTO] ResultsDto: items
    the matched results

[DTO] AuditDto: items
    an audit record of the search

[TYP] query: string
    the raw query text

[TYP] items: string
    a serialized result item

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db
```

### module-billing.rune

```rune
[MOD] billing

[REQ] invoice.issue(IssueDto): InvoiceDto
    db:invoice.save(IssueDto): InvoiceDto
      ! timeout

[DTO] IssueDto: customerId, amount
    a request to issue an invoice

[DTO] InvoiceDto: id, amount
    an issued invoice

[TYP] customerId: string
    the customerId
[TYP] amount: number
    the amount
[TYP] id: string
    the id

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db
```

### module-catalog.rune

```rune
[MOD] catalog

[REQ] product.list(ListDto): ProductsDto
    db:product.query(ListDto): ProductsDto
      ! timeout

[DTO] ListDto: page
    a paged product listing request

[DTO] ProductsDto: items
    a page of products

[TYP] page: number
    the page
[TYP] items: string
    the items

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db
```

### poly-many-cases.rune

```rune
[REQ] notify.send(NotifyDto): ReceiptDto
    [NEW] channel
    [PLY] channel.deliver(NotifyDto): ReceiptDto
        [CSE] email
        ex:smtp.send(NotifyDto): ReceiptDto
          ! timeout invalid-address
        [CSE] sms
        ex:carrier.send(NotifyDto): ReceiptDto
          ! timeout invalid-number
        [CSE] push
        ex:push.send(NotifyDto): ReceiptDto
          ! timeout unregistered=410

[NON] channel
    a delivery channel for notifications

[DTO] NotifyDto: message
    a message to deliver

[DTO] ReceiptDto: id
    a delivery receipt

[TYP] message: number
    the message
[TYP] id: string
    the id

[SRV] (HTTP)ex: EX_URL
    external http service
    @docs https://docs.example.com/ex
```

### poly-single-case.rune

```rune
[REQ] notify.send(NotifyDto): ReceiptDto
    [NEW] channel
    [PLY] channel.deliver(NotifyDto): ReceiptDto
        [CSE] email
        ex:smtp.send(NotifyDto): ReceiptDto
          ! timeout

[NON] channel
    a delivery channel for notifications

[DTO] NotifyDto: message
    a message to deliver

[DTO] ReceiptDto: id
    a delivery receipt

[TYP] message: number
    the message
[TYP] id: string
    the id

[SRV] (HTTP)ex: EX_URL
    external http service
    @docs https://docs.example.com/ex
```

### scope-static-instance.rune

```rune
[REQ] account.open(OpenDto): AccountDto
    id::create(OpenDto): IdDto
    [NEW] account
    account.activate(IdDto): AccountDto
      ! already-active=409

[NON] account
    a customer account
[NON] id
    an identity minted for a new account

[DTO] OpenDto: name
    a request to open an account

[DTO] IdDto: id
    a generated identifier

[DTO] AccountDto: id, name
    an opened account

[TYP] name: string
    the name
[TYP] id: string
    the id
```

### typ-alias.rune

```rune
[MOD] catalog

[REQ] item.add(AddItemDto): ItemDto
    db:item.save(AddItemDto): ItemDto
      ! conflict

[TYP] name: string
    a human-readable item name

[TYP] label: name
    an alias that references another [TYP]

[DTO] AddItemDto: name
    a request to add an item to the catalog

[DTO] ItemDto: name, label
    a stored catalog item

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db
```

### typ-constraints.rune

```rune
[MOD] inventory

[REQ] item.add(AddItemDto): ItemDto
    db:item.save(AddItemDto): ItemDto
      ! conflict

[TYP:ext,uuid] externalId: string
    an external identifier supplied by the source system

[TYP:uuid] id: string
    a generated unique identifier for the item

[TYP:nonempty] name: string
    a non-empty human-readable item name

[TYP:nonempty] tag: string
    a non-empty label applied to an item

[TYP:min=0,max=100] quantity: number
    a stock count bounded between zero and one hundred

[TYP:uuid] aisle: string
    the warehouse aisle identifier

[DTO] LocationDto: aisle
    where an item is physically stored

[DTO] AddItemDto: externalId, name, quantity, tag(s)
    a request to add an item to the inventory

[DTO] ItemDto: id, name, quantity, tag(s), location
    a stored inventory item with its location and tags

[SRV] (SIDECAR)db: DB_URL
    the primary datastore
    @docs https://docs.example.com/db
```

### ws-chat.rune

```rune
[MOD] chat

[ENT:ws] chat @ /rooms/{room}
    join(JoinDto): JoinedDto
        [REQ] room.join(JoinDto): JoinedDto
    send(ChatDto): EchoDto
        [REQ] room.send(ChatDto): EchoDto
    leave(LeaveDto): LeftDto
        [REQ] room.leave(LeaveDto): LeftDto

[REQ] room.join(JoinDto): JoinedDto
    lobby::admit(room): JoinedDto
[REQ] room.send(ChatDto): EchoDto
    lobby::echo(text): EchoDto
[REQ] room.leave(LeaveDto): LeftDto
    lobby::release(room): LeftDto

[DTO] JoinDto: room
    a request to join a room
[DTO] JoinedDto: room, members
    the join acknowledgement
[DTO] ChatDto: text
    a chat line typed by a member
[DTO] EchoDto: text, at
    the line echoed back with a server timestamp
[DTO] LeaveDto: room
    a request to leave a room
[DTO] LeftDto: room
    the leave acknowledgement

[TYP] room: string
    a room id, bound once from the handshake path
[TYP] members: number
    the current member count
[TYP] text: string
    the message text
[TYP] at: number
    a server timestamp

[NON] lobby
    the set of rooms and who is in them
```

## Tags

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

## Modifiers

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

## Transports

| Transport | Meaning |
| --- | --- |
| `SDK` | a vendor SDK / client library |
| `HTTP` | an HTTP API |
| `WEBSOCKET` | a WebSocket peer |
| `SIDECAR` | a co-located process (datastore, queue, object store) |
| `NATIVE` | an in-process runtime/std-lib boundary (filesystem, subprocess, crypto, clock) — neither a network surface nor a co-located process; its faults are synchronous throws and its env-var list is optional |

## Faults

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

## Indentation

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

## Rules

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

## Errors and their fixes

Each spec below is wrong in one way; under it, what `rune check` says.

### boundary-types

```rune
[REQ] task.create(InDto): TaskDto
    [NEW] task
    db:task.save(task): TaskDto

[NON] task
    a task
[DTO] InDto: a
    in
[DTO] TaskDto: a
    a task
[TYP] a: string
    a
```

- boundary-types.rune:3: db: boundary params/return must be DTO or primitive — got task [boundary-types]

### class-retired

```rune
[REQ] task.create(InDto): TaskDto
    [NEW] task
    task.toDto(): TaskDto

[TYP] task: Class
    a noun is a [NON], never a Class
[TYP] a: string
    a
[DTO] InDto: a
    in
[DTO] TaskDto: a
    a task
```

- class-retired.rune:2: "task" is not a defined [TYP], [DTO], [NON], or primitive [undefined-ref]
- class-retired.rune:5: [TYP] task: Class is retired — a noun is a [NON] [class-retired] — fix: replace it with `[NON] task` and a description

### cse-outside-ply

```rune
[REQ] order.place(InDto): OutDto
    [CSE] stray
    db:order.save(InDto): OutDto
      ! timeout
    [RET] OutDto

[DTO] InDto: a
    in

[DTO] OutDto: b
    out
```

- cse-outside-ply.rune:2: [CSE] outside [PLY] block [cse-outside-ply]
- cse-outside-ply.rune:2: [CSE] should be indented 8 spaces (found 4) [tag-indent] — fix: run `rune fmt`
- cse-outside-ply.rune:5: [RET] OutDto is redundant — the step above already returns it [ret-redundant] — fix: delete the [RET] line
- cse-outside-ply.rune:7: [DTO] InDto: property "a" has no [TYP] or [DTO] [dto-prop-undefined] — fix: declare `[TYP] a: <type>`
- cse-outside-ply.rune:10: [DTO] OutDto: property "b" has no [TYP] or [DTO] [dto-prop-undefined] — fix: declare `[TYP] b: <type>`

### ctr-retired

```rune
[REQ] order.place(InDto): OutDto
    [CTR] order
    db:order.save(InDto): OutDto
      ! timeout

[DTO] InDto: a
    in
[DTO] OutDto: b
    out
[TYP] a: string
    a
[TYP] b: string
    b
[NON] order
    an order
```

- ctr-retired.rune:2: [CTR] is retired — write `[NEW] order` [ctr-retired] — fix: run `rune fmt` (it rewrites [CTR] to [NEW])

### dto-described

```rune
[REQ] task.create(InDto): TaskDto
    db:task.save(InDto): TaskDto

[DTO] InDto: a
[DTO] TaskDto: a
    a task
[TYP] a: string
    a
```

- dto-described.rune:4: [DTO] InDto needs a description on the next line [dto-described]

### dto-missing-props

```rune
[DTO] FooDto
    a DTO declaration with no properties
```

- dto-missing-props.rune:1: [DTO] missing properties — [DTO] NameDto: prop1, prop2 [dto-props]

### dto-suffix

```rune
[REQ] task.create(In): Task
    db:task.save(In): Task

[DTO] In: a
    in
[DTO] Task: a
    a task
[TYP] a: string
    a
```

- dto-suffix.rune:1: requirement input "In" must be a DTO or inline {} [req-input-dto]
- dto-suffix.rune:1: requirement output "Task" must be a DTO [req-output-dto]
- dto-suffix.rune:2: db: boundary params/return must be DTO or primitive — got In, Task [boundary-types]
- dto-suffix.rune:4: DTO name "In" must end in Dto [dto-suffix]
- dto-suffix.rune:6: DTO name "Task" must end in Dto [dto-suffix]

### duplicate-req-signature

```rune
[REQ] task.create(InDto): TaskDto
    db:task.save(InDto): TaskDto
[REQ] task.create(InDto): TaskDto
    db:task.save(InDto): TaskDto

[DTO] InDto: a
    in
[DTO] TaskDto: a
    a task
[TYP] a: string
    a
```

- duplicate-req-signature.rune:3: [REQ] task.create is declared twice [duplicate-req-signature]

### edit-record-endpoint

```rune
[MOD] tasks
[ENT] http.editTask @ PATCH /tasks/{id}(TaskDto): TaskDto
    [REQ] task.edit(TaskDto): TaskDto

[REQ] task.edit(TaskDto): TaskDto
    db:task.save(TaskDto): TaskDto as saved
      ! not-found

[DTO] TaskDto: id, title
    a task
[TYP:example=t1] id: string
    the id
[TYP:example=buy-milk] title: string
    the title
```

- edit-record-endpoint.rune:2: [ENT] http.editTask is a PATCH — model a command verb instead of editing a record [edit-record-endpoint]

### ent-body-undefined

```rune
[MOD] shop
[ENT] http.placeOrder(InDto): OutDto
    [REQ] order.submit(InDto): OutDto

[REQ] order.place(InDto): OutDto
    db:order.save(InDto): OutDto
      ! timeout

[DTO] InDto: a
    in
[DTO] OutDto: b
    out
[TYP:example=x] a: string
    a
[TYP] b: string
    b
```

- ent-body-undefined.rune:2: [ENT] http.placeOrder delegates to [REQ] order.submit, which is not defined [ent-delegate-undefined]

### ent-no-body

```rune
[MOD] shop
[ENT] http.placeOrder(InDto): OutDto

[REQ] order.place(InDto): OutDto
    db:order.save(InDto): OutDto
      ! timeout

[DTO] InDto: a
    in
[DTO] OutDto: b
    out
[TYP:example=x] a: string
    a
[TYP] b: string
    b
```

- ent-no-body.rune:2: [ENT] http.placeOrder names no [REQ] — add an indented `[REQ] noun.verb(InDto): OutDto` line under it — by signature: order.place [ent-delegate-required] — fix: add `    [REQ] order.place(InDto): OutDto` under the [ENT]

### fault-bare

```rune
[REQ] order.place(InDto): OutDto
    db:order.save(InDto): OutDto
      timeout network-error

[DTO] InDto: a
    in
[DTO] OutDto: b
    out
[TYP] a: string
    a
[TYP] b: string
    b
```

- fault-bare.rune:3: bare fault line — faults are written `! timeout network-error` [fault-marker] — fix: prefix the line with `! ` (`rune fmt` does this)

### fault-custom-no-status

```rune
[REQ] order.place(InDto): OutDto
    db:order.save(InDto): OutDto
      ! card-expired timeout

[DTO] InDto: a
    in
[DTO] OutDto: b
    out
[TYP] a: string
    a
[TYP] b: string
    b
```

- fault-custom-no-status.rune:3: fault "card-expired" is not well-known and carries no status [fault-status] — fix: write `! card-expired=<HTTP status>` or use a well-known fault (not-found, conflict, timeout, unavailable, declined, unauthorized, forbidden, network-error, invalid-*)

### from-path-retired

```rune
[MOD] gateway
[ENT] http.proxy(ProxyReqDto): ProxyResDto
    [REQ] proxy.run(ProxyReqDto): ProxyResDto

[REQ] proxy.run(ProxyReqDto): ProxyResDto
    upstream::call(ProxyReqDto): ProxyResDto

[DTO] ProxyReqDto: target
    a request
[DTO] ProxyResDto: status
    the response

[TYP:from=path,example=api] target: string
    the upstream host segment
[TYP] status: number
    the status
[NON] upstream
    the upstream
```

- from-path-retired.rune:13: [TYP:from=path] is retired — path segments are bound by the [ENT]'s route template [from-path-retired] — fix: write the route as `[ENT] surface.action @ METHOD /…/{{target}}(In): Out` (`{{target*}}` for a catch-all) and drop from=path

### last-step-not-output

```rune
[REQ] search.run(QueryDto): ResultsDto
    db:index.query(QueryDto): ResultsDto
      ! timeout
    db:audit.record(ResultsDto): AuditDto

[DTO] QueryDto: query
    a query
[DTO] ResultsDto: items
    results
[DTO] AuditDto: items
    an audit record
[TYP] query: string
    the query
[TYP] items: string
    an item
```

- last-step-not-output.rune:4: last step must return ResultsDto (the REQ output), got AuditDto [last-step-returns-output] — fix: add `[RET] ResultsDto` after the side effect

### line-length

```rune
[REQ] task.create(InDto): TaskDto
    db:task.save(InDto): TaskDto

[DTO] InDto: a
    a description that runs on and on past the eightieth column of the line, sadly
[DTO] TaskDto: a
    a task
[TYP] a: string
    a
```

- line-length.rune:5: line exceeds 80 characters (82) [line-length] — fix: wrap the line; a fault line may continue on the next `! ` line, prose on the next indented line

### missing-return-type

```rune
[REQ] task.create(InDto): TaskDto
    db:task.save(InDto)
    task::toDto(InDto): TaskDto

[NON] task
    a task
[DTO] InDto: a
    in
[DTO] TaskDto: a
    a task
[TYP] a: string
    a
```

- missing-return-type.rune:2: step "task.save" is missing a return type [missing-return-type] — fix: write `: void` for a side effect

### new-missing-name

```rune
[REQ] order.place(InDto): OutDto
    [NEW]
    db:order.save(InDto): OutDto
      ! timeout

[DTO] InDto: a
    in

[DTO] OutDto: b
    out

[TYP] a: string
    a
[TYP] b: string
    b
```

- new-missing-name.rune:2: [NEW] missing noun — [NEW] noun [new-name]

### non-missing-name

```rune
[NON]
    a noun declaration that forgot to name its subject
```

- non-missing-name.rune:1: [NON] missing name — [NON] noun [non-name]

### poly-nested

```rune
[REQ] notify.send(NotifyDto): ReceiptDto
    [NEW] channel
    [PLY] channel.deliver(NotifyDto): ReceiptDto
        [CSE] email
        [PLY] transport.open(NotifyDto): ReceiptDto
            [CSE] tls
            ex:smtp.send(NotifyDto): ReceiptDto
              ! timeout

[NON] channel
    a delivery channel for notifications

[DTO] NotifyDto: message
    a message to deliver

[DTO] ReceiptDto: id
    a delivery receipt

[TYP] message: number
    the message
[TYP] id: string
    the id
```

- poly-nested.rune:5: nested [PLY] inside [CSE] not supported [ply-nested]

### req-core

```rune
[REQ:core] order.place(InDto): OutDto
    db:order.save(InDto): OutDto
      ! timeout
    [RET] OutDto

[DTO] InDto: a
    in

[DTO] OutDto: b
    out
```

- req-core.rune:1: [REQ:core] is invalid — coordinators are module-level [req-core]
- req-core.rune:4: [RET] OutDto is redundant — the step above already returns it [ret-redundant] — fix: delete the [RET] line
- req-core.rune:6: [DTO] InDto: property "a" has no [TYP] or [DTO] [dto-prop-undefined] — fix: declare `[TYP] a: <type>`
- req-core.rune:9: [DTO] OutDto: property "b" has no [TYP] or [DTO] [dto-prop-undefined] — fix: declare `[TYP] b: <type>`

### req-missing-signature

```rune
[REQ] this is not a valid signature

[DTO] FooDto: a
    a contract
```

- req-missing-signature.rune:1: [REQ] missing or malformed signature — [REQ] noun.verb(InputDto): OutputDto [req-signature]
- req-missing-signature.rune:3: [DTO] FooDto: property "a" has no [TYP] or [DTO] [dto-prop-undefined] — fix: declare `[TYP] a: <type>`
- req-missing-signature.rune:3: [DTO] FooDto is never used [dto-unused]

### req-not-dto

```rune
[REQ] task.create(a): b
    db:task.save(a): b

[TYP] a: string
    a
[TYP] b: string
    b
```

- req-not-dto.rune:1: requirement input "a" must be a DTO or inline {} [req-input-dto]
- req-not-dto.rune:1: requirement output "b" must be a DTO [req-output-dto]

### reserved-verb

```rune
[REQ] task.delete(RefDto): TaskDto
    db:task.load(id): TaskDto
      ! not-found

[DTO] RefDto: id
    a reference
[DTO] TaskDto: id
    a task
[TYP] id: string
    the id
```

- reserved-verb.rune:1: verb "delete" is a JavaScript reserved word and cannot name a generated function [reserved-verb] — fix: rename the verb (e.g. remove)

### ret-missing-value

```rune
[REQ] order.place(InDto): OutDto
    db:order.save(InDto): OutDto
      ! timeout
    [RET]

[DTO] InDto: a
    in

[DTO] OutDto: b
    out
```

- ret-missing-value.rune:4: [RET] missing value — [RET] value [ret-value]
- ret-missing-value.rune:6: [DTO] InDto: property "a" has no [TYP] or [DTO] [dto-prop-undefined] — fix: declare `[TYP] a: <type>`
- ret-missing-value.rune:9: [DTO] OutDto: property "b" has no [TYP] or [DTO] [dto-prop-undefined] — fix: declare `[TYP] b: <type>`

### ret-redundant

```rune
[REQ] invoice.issue(IssueDto): InvoiceDto
    db:invoice.save(IssueDto): InvoiceDto
      ! timeout
    [RET] InvoiceDto

[DTO] IssueDto: amount
    a request
[DTO] InvoiceDto: amount
    an invoice
[TYP] amount: number
    the amount
```

- ret-redundant.rune:4: [RET] InvoiceDto is redundant — the step above already returns it [ret-redundant] — fix: delete the [RET] line

### scope

```rune
[REQ] task.create(CreateTaskDto): TaskDto
    task.fill(title): task
    id::mint(nonce): id
    task.toDto(): WidgetDto

[NON] task
    a todo item
[DTO] CreateTaskDto: title
    input
[DTO] TaskDto: id, title
    a task
[TYP] title: string
    the title
[TYP] id: string
    the id
```

- scope.rune:2: instance noun "task" isn't in scope (use :: for static, or [NEW] it, or return it from an earlier step) [noun-in-scope]
- scope.rune:3: parameter "nonce" isn't in scope (return it from a prior step or take it from the input DTO) [param-scope]
- scope.rune:4: last step must return TaskDto (the REQ output), got WidgetDto [last-step-returns-output] — fix: add `[RET] TaskDto` after the side effect
- scope.rune:4: "WidgetDto" is not a defined [TYP], [DTO], [NON], or primitive [undefined-ref]

### signature-consistency

```rune
[REQ] card.open(OpenDto): CardDto
    card::toDto(pan): CardDto
[REQ] card.charge(ChargeDto): CardDto
    card::toDto(pan, cvv): CardDto

[NON] card
    a card
[DTO] OpenDto: pan
    open
[DTO] ChargeDto: pan, cvv
    charge
[DTO] CardDto: pan
    a card
[TYP] pan: string
    the pan
[TYP] cvv: string
    the cvv
```

- signature-consistency.rune:4: card::toDto has an inconsistent signature ((pan, cvv): CardDto vs (pan): CardDto) [signature-consistency]

### srv-bad-transport

```rune
[MOD] core
[SRV] (CARRIER_PIGEON)db: DB_URL
    the datastore
    @docs https://docs.example.com/db
```

- srv-bad-transport.rune:2: [SRV] unknown transport "CARRIER_PIGEON" — expected SDK/HTTP/WEBSOCKET/SIDECAR/NATIVE [srv-transport]

### srv-no-docs

```rune
[MOD] core
[SRV] (SIDECAR)db: DB_URL
    the datastore, without its documentation link
```

- srv-no-docs.rune:2: [SRV] db requires an @docs <url> line [srv-docs-required] — fix: add `    @docs <url>` under the description

### step-outside-req

```rune
[RET] FooDto

[DTO] FooDto: a
    a value returned from nowhere — [RET] is only valid inside a [REQ]
```

- step-outside-req.rune:1: step outside [REQ]: ret [step-outside-req]
- step-outside-req.rune:1: [RET] should be indented 4 spaces (found 0) [tag-indent] — fix: run `rune fmt`
- step-outside-req.rune:3: [DTO] FooDto: property "a" has no [TYP] or [DTO] [dto-prop-undefined] — fix: declare `[TYP] a: <type>`
- step-outside-req.rune:3: [DTO] FooDto is never used [dto-unused]

### tag-indent

```rune
  [REQ] task.create(InDto): TaskDto
  db:task.save(InDto): TaskDto

[DTO] InDto: a
    in
[DTO] TaskDto: a
    a task
[TYP] a: string
    a
```

- tag-indent.rune:1: [REQ] should be indented 0 spaces (found 2) [tag-indent] — fix: run `rune fmt`

### typ-alias-dto

```rune
[REQ] item.add(AddItemDto): ItemDto
    db:item.save(AddItemDto): ItemDto

[TYP] name: string
    a name
[TYP] itemRef: ItemDto
    a [TYP] may not alias a [DTO]

[DTO] AddItemDto: name
    a request
[DTO] ItemDto: name, itemRef
    an item
```

- typ-alias-dto.rune:6: [TYP] itemRef must be a primitive — it can't reference DTO ItemDto [type-not-dto]

### typ-missing-type

```rune
[TYP] price
    a type declaration with no underlying primitive
```

- typ-missing-type.rune:1: [TYP] missing type — [TYP:mod,mod] name: primitive [typ-type]

### typ-modifier-bad-value

```rune
[TYP:min] quantity: number
    a numeric type whose min modifier is missing its value
```

- typ-modifier-bad-value.rune:1: [TYP] modifier "min" requires a numeric value (e.g. min=0) [typ-modifier-value]
- typ-modifier-bad-value.rune:1: [TYP] quantity is never used [typ-unused]

### typ-modifier-wrong-base

```rune
[TYP:uuid] count: number
    a numeric type wrongly marked as a uuid string
```

- typ-modifier-wrong-base.rune:1: [TYP] modifier "uuid" requires a string type, but "count" is number [typ-modifier-base]
- typ-modifier-wrong-base.rune:1: [TYP] count is never used [typ-unused]

### typ-unknown-modifier

```rune
[TYP:bogus] id: string
    a type using a modifier that does not exist
```

- typ-unknown-modifier.rune:1: [TYP] unknown modifier "bogus" (allowed: core, ext, uuid, email, url, nonempty, json, int, min=<n>, max=<n>, positive, example=<value>, from=<query|header>) [typ-modifier-unknown]
- typ-unknown-modifier.rune:1: [TYP] id is never used [typ-unused]

### unbound-input-needs-example

```rune
[MOD] shop
[ENT] http.placeOrder(InDto): OutDto
    [REQ] order.place(InDto): OutDto

[REQ] order.place(InDto): OutDto
    db:order.save(InDto): OutDto
      ! timeout

[DTO] InDto: sku
    in
[DTO] OutDto: id
    out
[TYP] sku: string
    the sku nothing produces and no example seeds
[TYP] id: string
    the id
```

- unbound-input-needs-example.rune:2: input field "sku" of http.placeOrder has no producer and no example [unbound-input-needs-example] — fix: add `example=<value>` to `[TYP] sku`

### unique-and-unused

```rune
[REQ] task.create(InDto): TaskDto
    db:task.save(InDto): TaskDto

[DTO] InDto: a
    in
[DTO] InDto: a
    in again
[DTO] TaskDto: a
    a task
[DTO] SpareDto: a
    never referenced
[TYP] a: string
    a
[TYP] a: string
    a again
[TYP] b: string
    never referenced
[NON] widget
    never referenced
```

- unique-and-unused.rune:6: [DTO] InDto is defined more than once [dto-unique]
- unique-and-unused.rune:10: [DTO] SpareDto is never used [dto-unused]
- unique-and-unused.rune:14: [TYP] a is defined more than once [typ-unique]
- unique-and-unused.rune:16: [TYP] b is never used [typ-unused]
- unique-and-unused.rune:18: [NON] widget is never used [non-unused]

### value-duplicate

```rune
[REQ] task.copy(RefDto): TaskDto
    db:task.load(id): TaskDto
      ! not-found
    db:task.load(id): TaskDto

[DTO] RefDto: id
    a reference
[DTO] TaskDto: id, title
    a task
[TYP] id: string
    the id
[TYP] title: string
    the title
```

- value-duplicate.rune:4: a value named "TaskDto" is already in scope (from step task.load) [value-duplicate] — fix: name this one: `… : TaskDto as <name>`

### ws-bad-topic

```rune
[MOD] chat

[ENT:ws] chat @ /rooms/{room}
    notavalidtopic
```

- ws-bad-topic.rune:3: [ENT:ws] chat has no topics — add at least one "<verb>(InputDto): OutputDto" [ws-no-topics]
- ws-bad-topic.rune:4: [ENT:ws] chat: malformed topic — expected "<verb>(InputDto): OutputDto" [ws-topic-shape]

### ws-header-signature

```rune
[MOD] chat

[ENT:ws] chat.send(ChatDto): EchoDto

[DTO] ChatDto: text
    a chat line typed by a member
[DTO] EchoDto: text
    the echoed line

[TYP] text: string
    the message text
```

- ws-header-signature.rune:3: [ENT:ws] malformed — expected "[ENT:ws] <surface> @ /path" [ws-header-signature]
- ws-header-signature.rune:5: [DTO] ChatDto is never used [dto-unused]
- ws-header-signature.rune:7: [DTO] EchoDto is never used [dto-unused]
