#!/usr/bin/env sh
# Build the Rust binaries (rune-lsp, rune-syntax) — `deno task build:rust`.
#
# cargo may be installed but not on PATH (a rustup profile the task's shell
# never sourced), and in a sandbox box the mounted ~/.cargo/registry is
# read-only, so a crate not already cached cannot be downloaded there. Prefer
# the user's cargo home; when its registry is not writable, use a scratch one
# (the box has network, so the crates download there).
set -eu
cd "$(dirname "$0")/../lang"
PATH="$HOME/.cargo/bin:$PATH"
export PATH
# The mount reports the registry dirs writable (`-w` says yes) and then refuses
# the write, so the only honest probe is a write: one file in every per-index
# cache dir, removed at once.
registry_writable() {
  [ -e "$HOME/.cargo/registry" ] || return 0
  for d in "$HOME/.cargo/registry/cache"/* "$HOME/.cargo/registry/index"/*; do
    [ -d "$d" ] || continue
    probe="$d/.rune-write-probe.$$"
    if ! touch "$probe" 2>/dev/null; then
      return 1
    fi
    rm -f "$probe"
  done
  return 0
}
if [ -z "${CARGO_HOME:-}" ]; then
  if registry_writable; then
    CARGO_HOME="$HOME/.cargo"
  else
    CARGO_HOME="${TMPDIR:-/tmp}/rune-cargo-home"
  fi
  export CARGO_HOME
fi
exec cargo build --release "$@"
