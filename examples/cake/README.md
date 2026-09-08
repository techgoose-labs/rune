# cake — the cake, end to end

A six-step process (`drive → shop → checkout → mix → bake → cut`) that demonstrates the
rune loop end to end: write a spec, `rune sync` it into runtime endpoint controllers, fill the
coordinator bodies, serve, and walk the per-module **cake** at `/docs/cake`.

The DTO field names chain on purpose — each step's input field matches the prior step's output
field — so `rune sync` **auto-derives** the `order` / `dependsOn` / `bind` on each `@Endpoint`:

| # | endpoint | input ← from | output |
|---|---|---|---|
| 1 | `driveToStore` | `destination` (seed) | `storeId` |
| 2 | `groceryShop` | `storeId` ← 1 | `cartId` |
| 3 | `checkout` | `cartId` ← 2 | `ingredientsId` |
| 4 | `mixIngredients` | `ingredientsId` ← 3 | `batterId` |
| 5 | `bake` | `batterId` ← 4 | `cakeId` |
| 6 | `cut` | `cakeId` ← 5 | `sliceCount` |

## The flow

```sh
# 1. generate keep controllers + DTOs + coordinators from the spec
rune sync src/cake/cake.rune

# 2. fill the six coordinator bodies (the generated <verb>Core functions)

# 3. serve and verify — open /docs/cake, walk the cake (Emulate down the list,
#    or Run all). Each green checkmark = that endpoint's logic works; the next step
#    unlocks pre-filled from the captured output. Standard Swagger UI is at
#    /docs/cake/swagger, the raw spec at /docs/cake/json.

# 4. or verify headlessly:  exerciseEndpoints({ api })   (from @techgoose-labs/rune)
```

The generated controller is one `@EndpointController("http")` with a `@Endpoint`-decorated method
per `[ENT]`, each delegating to its `[REQ]` coordinator. `order`/`dependsOn`/`bind` come straight
from the spec's DTO graph — no hand-wiring.

> Resolving keep locally: a real project imports `@techgoose-labs/rune` from JSR (`rune sync` writes
> that mapping). To run this example against an unpublished local keep checkout, point
> `@techgoose-labs/rune` (and keep's own `#`/`@foundation` aliases) at the checkout, or use a Deno
> workspace whose root is **not** an ancestor of the rune repo.
