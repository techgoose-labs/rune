# Rune

rune builds a backend by *shaping* it instead of writing it. You describe a module
as a tiny `.rune` spec — its endpoints, data contracts, and seams — and rune
generates a typed, validated, lint-clean TypeScript tree from it. That generated
code runs on **rune's runtime** (`@techgoose-labs/rune` on JSR): a Deno backend that
turns your modules into a routed, documented, self-verifying app. **The spec is how
you shape the thing; the runtime is the thing your shape runs on.** You regenerate
from the spec — you don't hand-edit the structure — and the same spec carries you
from "write it" to "watch it run green."

## The two layers

- **The shaping layer** — the `.rune` spec language and the `rune` CLI (`sync`,
  `manifest`, `check`, `lint`, `dev`, `validate`, self-update), plus the architecture
  linter and the Rust `rune-lsp` / `rune-syntax` helpers. It lives in `src/` (the
  engine, shipped as prebuilt binaries via the rolling `latest` GitHub release),
  `lang/` (the grammar and `lang/keywords.json`, the language's single source of
  truth), and **Rune Studio** (`rune-studio/`, the visual editor for it).
- **The runtime layer** — *rune's runtime*, published to JSR as
  [`@techgoose-labs/rune`](https://jsr.io/@techgoose-labs/rune): the Deno backend the
  generated code targets — DI bootstrap, auto Swagger, the interactive **cake**, the
  live system map, deny-by-default auth, a headless runner; built on `@danet/core`.
  It lives in `keep/`, which holds **only** the publishable package (`src/`, manifest,
  README, assets) — see [`keep/README.md`](keep/README.md). The package name
  `@techgoose-labs/rune` is a stable identifier, not a separate product.

Everything else is shared across both layers and lives in exactly one place:
`claude/` (Claude Code assets — the eight rune skills under `claude/skills/` — `rune:scope`/`spec`/`data`/`build`/`cake`/`framework`/`docs`/`diamond` — plus `claude/agents/`), `examples/` (spec→code
demos and runnable backends), `e2e/` (the spec→runtime acceptance suite), `docs/`,
`todos/`.

The repo is a Deno workspace: the root `deno.json` is rune's config. Its members are
the self-contained sub-projects — `keep` (the runtime library), the two integration
acceptances (`e2e/cake`, `e2e/checkout`), and the `examples/in-process-client` demo
— so they resolve the runtime from the **in-tree source** (`keep/`) and you can test
rune against an unreleased runtime. Generated *user* projects still pin
`jsr:@techgoose-labs/rune@^3` (they live outside this repo) — that is intentional and
unchanged. (`rune-studio/` is a standalone Vite app with its own lockfile, run via
its own `deno task dev`.)

## Install

```sh
curl -fsSL https://github.com/mrg-keystone/rune/releases/download/latest/install.sh | sh
rune --help
```

The installer is **idempotent**: it first removes any existing `rune` (from every
known location — `~/.deno/bin`, `~/.cargo/bin`, `~/.local/bin`, …) and then drops
in one fresh copy, so you never end up with stale or duplicate binaries on your
`PATH`. Pulls the latest prebuilt release (`rune` + the `rune-lsp` / `rune-syntax`
helpers) into `~/.deno/bin` — no Deno or Rust toolchain required. It also installs
the **rune Claude Code skills** into `~/.claude/skills/rune:*/` (plus any bundled
agents into `~/.claude/agents/`; skipped when `~/.claude` doesn't exist), so Claude
always matches the installed toolchain.

Already installed? `rune update` (alias: `rune upgrade`) re-runs this installer —
binaries, skills *and* agents. Options:

- `RUNE_INSTALL=/usr/local/bin` — install somewhere else (must be on your `PATH`).
- `RUNE_VERSION=v0.1.0` — pin a specific snapshot instead of the rolling latest.
- `RUNE_VERSION=develop` — install the rolling **develop** build (latest
  integration work, ahead of stable):

  ```sh
  curl -fsSL https://github.com/mrg-keystone/rune/releases/download/develop/install.sh | RUNE_VERSION=develop sh
  ```

Supported targets: Apple-silicon macOS, Intel macOS, Linux x86-64. On macOS the
script de-quarantines the binaries so Gatekeeper doesn't block them.

### Uninstall

```sh
curl -fsSL https://github.com/mrg-keystone/rune/releases/download/latest/uninstall.sh | sh
# or, from a checkout: deno task uninstall
```

Removes `rune` + `rune-lsp` + `rune-syntax` from every known install location,
plus the managed skills (`~/.claude/skills/rune:*/`, and any legacy
`~/.claude/skills/rune/` or `~/.claude/skills/keep/` now folded into them) — anything else you keep
in that folder (evals, notes) is left alone.

### Claude Code skills + agents

Installed for you: the skills (and any agents) ship inside every release tarball,
and every install path (`scripts/install.sh`, `deno task install`, `rune update`)
drops them into `~/.claude/skills/rune:*/` and `~/.claude/agents/` so Claude knows
the syntax, lifecycle, and pitfalls of the version you actually have — a pinned
`RUNE_VERSION` install gets the skills matching those binaries. Source lives in the
repo's `claude/` dir (`claude/skills/`, `claude/agents/`). Working on them?
`deno task install` copies them straight from your checkout.

## Build from source (contributors)

```sh
deno task build          # compiles dist/rune (+ rune-lsp, rune-syntax helpers)
./dist/rune --help       # see all commands
deno task install        # or: build from this checkout straight into ~/.deno/bin
```

Or run from source without compiling: `deno run -A src/bootstrap/mod.ts <args>`.

### The loop

```sh
# 1. write a spec (one per module) at src/<module>/<module>.rune
#    (copy examples/todos/src/tasks/tasks.rune as a starting point)

# 2. generate the module from it (also writes the project's deno.json import map)
rune sync src/<module>/<module>.rune --artifact lang/keywords.json

# 3. fill in the bodies (the dev-owned mod.ts files); the sig.ts contracts are
#    generated for you. then verify, from the project dir:
deno check src/**/*.ts

# 4. lint the result against the architecture
rune .                   # "All clear — no violations found." = exit 0
```

Edit the spec and re-run `rune sync` anytime — `deno check` shows you exactly what
to reconcile (a new abstract method to implement, or a stray one to delete).
`rune sync --force` prunes files a spec no longer declares.

## First-class validation

- **Constraints in the spec**: `[TYP:uuid] id: string`,
  `[TYP:min=0,max=100] qty: number` — comma-separated `[TYP]` modifiers
  (`uuid`, `email`, `url`, `nonempty`, `json`, `int`, `min=N`, `max=N`,
  `positive`; they compose with `ext`/`core`) become class-validator decorators
  on the generated DTO fields. `json` marks a string that carries a JSON blob and
  checks it parses (`@IsJSON()`) so invalid JSON 422s at the seam, not downstream.
- **Asserts at every seam**: generated coordinators validate input, adapter
  reads/writes, and the result via `assert` from `#assert` (rune's runtime).
  A failed contract throws `RuneAssertError`, which the runtime maps to HTTP 422
  with `{ target, context, failures }` and dotted paths (`lines.1.qty`).
- `RUNE_ASSERT=off` turns every assert into a passthrough (trusted prod);
  the `no-dto-cast` lint keeps hand-written coordinator code from bypassing
  the seams with blind `as XxxDto` casts.

## Language

The language itself — tags, codegen templates, lint rules, folder layout — lives in
**`lang/keywords.json`** (the single source of truth), edited visually in **Rune Studio**:

```sh
deno task studio
```

- Syntax reference: `lang/docs/spec.md`
- Enforced rules: `lang/docs/constraints.md`
- Worked examples: `examples/todos/`

## Commands

| Command | Does |
|---|---|
| `rune init <project-name>` | scaffold a fresh **composed monorepo** — a Deno-workspace git root (`deno.json` with `workspace: ["./ui","./server"]`, a generated `serve.ts`) composing a `ui/` package (sprig UI) and a `server/` package (`server/deno.json`, `server/bootstrap/`, shared `spec/runes/core.rune` at the git root) — author specs in `spec/runes/`, `rune sync spec/runes/<m>.rune` generates into `server/src/<m>/` |
| `rune [dir]` | lint a project against the architecture |
| `rune sync <file.rune>` | generate/update a module from its spec (+ runtime bootstrap in `server/bootstrap/`) |
| `rune manifest <file.rune>` | one-shot generate (no prune) |
| `rune validate <keywords.json>` | validate the artifact |
| `rune lsp` / `rune fmt <file>` | language server / format (Rust helpers) |
| `rune update [tag]` | self-update binaries + Claude skill (alias: `upgrade`) |

## The runtime your generated code runs on

*rune's runtime* (`@techgoose-labs/rune` on JSR) is the Deno backend rune-generated
projects target — DI bootstrap, token/Firebase auth, auto Swagger docs, in-process
API client, Fresh embedding; built on `@danet/core`. It lives in [`keep/`](keep/),
which holds only the publishable package; the package name is its stable id, not a
separate product. Its assert runtime is what rune's generated seams import via
`#assert` (resolved in-tree to `keep/src/assert/mod.ts` here, and to
`jsr:@techgoose-labs/rune@^3/assert` in generated user projects). The lockstep guard
(`deno task check:lockstep`) machine-checks that the class-validator /
class-transformer / reflect-metadata ranges rune emits match the ranges the runtime
declares in `keep/deno.json` — a single decorator stack across both.

```sh
deno task test:keep       # the runtime's test suite
deno task check:keep-jsr  # the runtime's JSR publish preflight (dry-run)
```

## Tests & verify

```sh
deno task verify                  # lockstep guard + the full L0–L7 verify ladder
deno test -A src/                 # the engine
deno task test:keep               # the runtime's unit suite
deno task test:e2e                # the spec→runtime integration acceptance (e2e/)
(cd rune-studio && deno test -A tests/)
(cd lang && cargo test --workspace)   # parser + LSP
```

## Releases

CI is path-filtered by layer:

- `release-rune` rebuilds rune's rolling `latest` release — the three binaries
  plus the Claude Code assets (`claude/skills/rune:*` + `claude/agents/`, bundled as
  `skill/` and `agent/` dirs inside each tarball) — on any push **except** ones
  touching only runtime-owned or non-binary facets (`keep/`, `e2e/`, `examples/`,
  `docs/`, `todos/`).
- `publish-keep` publishes the runtime, `@techgoose-labs/rune`, to JSR on pushes to
  `keep/**`. The skill now ships once (with rune), so this is a pure JSR publish.
