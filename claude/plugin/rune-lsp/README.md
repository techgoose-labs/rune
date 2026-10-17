# rune-lsp — the Claude Code code-intelligence plugin for `.rune`

Registers `rune-lsp` as the language server for `.rune` files, so Claude Code
reports diagnostics after every edit of a spec, the way an editor does. The
diagnostics are `rune check --json` over the buffer (REQ-015): the same
findings, the same rule ids, as the CLI and the merge gate.

## Install

The binaries come from the rune installer (`rune update`, or the one-line
install in the root README): `rune` and `rune-lsp` land side by side in
`~/.deno/bin`, and the LSP finds `rune` beside itself. The same installer
copies `claude/plugin/` to `~/.claude/rune-plugins/` — a local plugin
marketplace named `rune` — and, when `claude` is on the PATH, registers it and
installs this plugin:

```sh
claude plugin marketplace add ~/.claude/rune-plugins
claude plugin install rune-lsp@rune
```

Run those two by hand if the installer printed them instead. A local-path
marketplace is read in place, so `rune update` refreshes the plugin too.
From a checkout, `claude --plugin-dir claude/plugin/rune-lsp` loads it for one
session.

- `RUNE_BIN=/path/to/rune` overrides the checker the LSP runs.
- Plugin language servers do not start in cloud sessions; in a sandbox box both
  binaries must be on the box's `PATH`.
- Confirm it works: ask Claude to add a second `[MOD]` line to a spec; the
  conversation shows `Found 1 new diagnostic issues` and the diagnostic carries
  `mod-duplicate`.
