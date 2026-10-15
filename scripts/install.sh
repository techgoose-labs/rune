#!/usr/bin/env sh
# Install the rune CLI (rune + rune-lsp + rune-syntax) from GitHub Releases,
# plus the rune Claude Code skills (rune:scope, rune:spec, rune:data, rune:build,
# rune:cake, rune:framework, rune:docs, rune:diamond) into user scope
# (~/.claude/skills/) and any bundled agents into ~/.claude/agents/. Both ship from
# the repo's claude/ dir (claude/skills/ + claude/agents/). Between them the skills
# cover the whole arc — product scoping, spec authoring, data design, the generated
# runtime, and the whole-flow conductor (rune:diamond).
#
# Installs CLEANLY: it first UNINSTALLS any existing rune (every known location),
# then installs one fresh copy — so you never accumulate stale/duplicate binaries.
#
#   curl -fsSL https://github.com/mrg-keystone/rune/releases/download/latest/install.sh | sh
#
# Local dev build (compile from THIS checkout, skip the GitHub release):
#   deno task install        (= sh scripts/install.sh --dev)
#
# Options (env vars):
#   RUNE_INSTALL        install dir (default: ~/.deno/bin)
#   RUNE_VERSION        tag to install (default: latest release; e.g. develop, v0.1.0)
#   RUNE_REF            fallback ref for uninstall.sh + the skill, used only for
#                       releases that predate those assets (default: main)
#   CLAUDE_SKILLS_DIR   Claude Code skills dir (default: ~/.claude/skills)
#   CLAUDE_AGENTS_DIR   Claude Code agents dir (default: ~/.claude/agents)
#   CLAUDE_PLUGINS_DIR  Claude Code plugin marketplace dir (default: ~/.claude/rune-plugins)
#
# Prerequisite: `deno` on your PATH — the linter's type-aware rules spawn
# `deno lsp`. Set SHAPE_NO_LSP=1 to skip them.
set -eu

REPO="mrg-keystone/rune"
BINDIR="${RUNE_INSTALL:-$HOME/.deno/bin}"
RUNE_REF="${RUNE_REF:-main}"
# The binaries this installer manages. Add a fourth here and every loop below
# (purge / chmod / xattr / codesign) picks it up — no other edit needed.
BINS="rune rune-lsp rune-syntax"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
AGENTS_DIR="${CLAUDE_AGENTS_DIR:-$HOME/.claude/agents}"
PLUGINS_DIR="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/rune-plugins}"

# The release tag to install. The rolling release is ALWAYS tagged `latest`;
# pinned snapshots use their v* tag. Resolve directly — never via the GitHub
# "latest release" API, which is unreliable mid-deploy (it briefly returns an
# older pinned tag while `latest` is rebuilding). Resolved up front because the
# release is the source of truth for every asset below (binaries, uninstall.sh,
# the skill), so each fetch is version-matched to the tag being installed.
tag="${RUNE_VERSION:-latest}"

# install_unit <src entry> <dest dir> — install/UPDATE one unit (a skill folder,
# or an agent file/folder) into a Claude Code dir by BASE-LEVEL REPLACE: the unit
# is the base "key", so its destination is removed and re-copied whole. This is
# the spread merge   destDir = { ...destDir, ...toInstall }   applied one key at a
# time — the named unit is replaced outright; every sibling already in the dest is
# left untouched. A symlinked dest (the old README setup) is unlinked first so we
# never write through the link into a checkout.
install_unit() {
  name="$(basename "$1")"
  dst="$2/$name"
  [ -L "$dst" ] && rm -f "$dst"
  rm -rf "$dst"
  cp -R "$1" "$dst"
  echo "Installed $name -> $dst"
}

# install_skills <dir of skill folders> — install/update EVERY skill under a
# skills/ dir (the `toInstall` operand) into $SKILLS_DIR, each via base-level
# replace. A skill is a FOLDER containing SKILL.md; an entry without one is
# skipped. Skipped wholesale when ~/.claude is absent (no Claude Code here).
install_skills() {
  [ -d "$1" ] || return 0
  if [ ! -d "$HOME/.claude" ]; then
    echo "rune: ~/.claude not found — skipping the Claude Code skills."
    return 0
  fi
  mkdir -p "$SKILLS_DIR"
  # Cutover: the monolith `rune` skill was split into the namespaced rune:* skills.
  # Remove a stale colon-less `rune` so it can't linger as an extra skill whose
  # triggers collide with them (harmless if it was never there).
  [ -d "$SKILLS_DIR/rune" ] && rm -rf "$SKILLS_DIR/rune"
  for d in "$1"/*/; do
    [ -d "$d" ] || continue
    src="${d%/}"
    [ -e "$src/SKILL.md" ] || { echo "rune: '$src' has no SKILL.md — skipping." >&2; continue; }
    install_unit "$src" "$SKILLS_DIR"
  done
}

# install_agents <dir of agent files/folders> — install/update EVERY agent under
# an agents/ dir into $AGENTS_DIR, each via the SAME base-level replace as skills
# (   agentsDir = { ...agentsDir, ...toInstall }   ). An agent is ONE top-level
# entry: a `<name>.md` file (the usual case) or a folder bundling resources. A
# dotfile that only holds the dir in git (.gitkeep) is skipped by the glob, so an
# empty agents/ installs nothing. Skipped wholesale when ~/.claude is absent.
install_agents() {
  [ -d "$1" ] || return 0
  if [ ! -d "$HOME/.claude" ]; then
    echo "rune: ~/.claude not found — skipping the Claude Code agents."
    return 0
  fi
  mkdir -p "$AGENTS_DIR"
  for e in "$1"/*; do
    [ -e "$e" ] || continue   # empty dir → glob stays literal; nothing to install
    install_unit "$e" "$AGENTS_DIR"
  done
}

# install_plugins <dir> — install/update the Claude Code plugin marketplace that
# ships in claude/plugin/ (REQ-015): the dir is copied whole to $PLUGINS_DIR
# (default ~/.claude/rune-plugins), a LOCAL marketplace named "rune" that Claude
# Code reads in place — so a re-install refreshes every plugin in it. When the
# `claude` CLI is on the PATH the marketplace is registered and each plugin
# installed; otherwise the two commands are printed for the user. Skipped
# wholesale when ~/.claude is absent.
install_plugins() {
  [ -d "$1" ] || return 0
  if [ ! -d "$HOME/.claude" ]; then
    echo "rune: ~/.claude not found — skipping the Claude Code plugins."
    return 0
  fi
  rm -rf "$PLUGINS_DIR"
  mkdir -p "$(dirname "$PLUGINS_DIR")"
  cp -R "$1" "$PLUGINS_DIR"
  if command -v claude >/dev/null 2>&1; then
    claude plugin marketplace add "$PLUGINS_DIR" >/dev/null 2>&1 || true
    for p in "$PLUGINS_DIR"/*/; do
      [ -f "$p/.claude-plugin/plugin.json" ] || continue
      claude plugin install "$(basename "$p")@rune" >/dev/null 2>&1 || true
    done
    echo "rune: Claude Code plugins installed from $PLUGINS_DIR (marketplace 'rune')."
  else
    echo "rune: Claude Code plugins staged at $PLUGINS_DIR — to load them, run:"
    echo "  claude plugin marketplace add $PLUGINS_DIR && claude plugin install rune-lsp@rune"
  fi
}

# --dev: build + install from this local checkout instead of a GitHub release.
DEV=0
for a in "$@"; do [ "$a" = "--dev" ] && DEV=1; done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- 1. Uninstall any prior copy first (install = uninstall + fresh install) ---
# uninstall.sh comes from the release being installed; the repo at $RUNE_REF is
# only a fallback for releases that predate the standalone asset.
echo "Removing any existing rune install…"
if curl -fsSL "https://github.com/$REPO/releases/download/$tag/uninstall.sh" \
     -o "$tmp/uninstall.sh" 2>/dev/null ||
   curl -fsSL "https://raw.githubusercontent.com/$REPO/$RUNE_REF/scripts/uninstall.sh" \
     -o "$tmp/uninstall.sh" 2>/dev/null; then
  RUNE_INSTALL="$BINDIR" sh "$tmp/uninstall.sh" || true
else
  # Fallback (offline, or uninstall.sh not yet published): purge known locations.
  for d in "$BINDIR" "$HOME/.deno/bin" "$HOME/.cargo/bin" "$HOME/.local/bin" \
           /usr/local/bin /opt/homebrew/bin; do
    for b in $BINS; do rm -f "$d/$b" 2>/dev/null || true; done
  done
fi

# --- 1b. --dev: compile + install from the local checkout (no release needed) ---
if [ "$DEV" = "1" ]; then
  # The script lives in <repo>/scripts/, so the checkout root is one level up.
  repo="$(cd "$(dirname "$0")/.." && pwd)"
  [ -f "$repo/src/bootstrap/mod.ts" ] || {
    echo "rune: --dev must be run as \`deno task install\` (or" >&2
    echo "      \`sh scripts/install.sh --dev\`) from a rune checkout" >&2
    echo "      (no src/bootstrap/mod.ts found at $repo)." >&2
    exit 1
  }
  command -v deno >/dev/null 2>&1 || { echo "rune: --dev needs deno on PATH." >&2; exit 1; }
  command -v cargo >/dev/null 2>&1 || { echo "rune: --dev needs cargo (rust) on PATH." >&2; exit 1; }
  mkdir -p "$BINDIR"

  echo "Compiling rune from source…"
  # Stamp the build identity (version + commit) so the compiled binary's `rune -v`
  # reports this checkout — matches what `deno task compile` does via `setup`, and
  # is required because `deno compile` below statically imports the generated file.
  ( cd "$repo" && deno run --allow-read --allow-run --allow-write --allow-env \
    scripts/gen-version.ts )
  deno compile --allow-read --allow-write --allow-net --allow-env --allow-run \
    --config "$repo/deno.json" -o "$BINDIR/rune" "$repo/src/bootstrap/mod.ts"

  # Rust helpers only change with the Rust sources — reuse an existing build.
  if [ ! -x "$repo/lang/target/release/rune-lsp" ] ||
     [ ! -x "$repo/lang/target/release/rune-syntax" ]; then
    echo "Building rust helpers (rune-lsp, rune-syntax)…"
    ( cd "$repo/lang" && cargo build --release )
  fi
  cp "$repo/lang/target/release/rune-lsp" \
     "$repo/lang/target/release/rune-syntax" "$BINDIR/"

  if [ "$(uname -s)" = "Darwin" ]; then
    for b in $BINS; do codesign -f -s - "$BINDIR/$b" 2>/dev/null || true; done
  fi
  install_skills "$repo/claude/skills"
  install_agents "$repo/claude/agents"
  install_plugins "$repo/claude/plugin"
  echo "Installed rune (dev build from $repo) -> $BINDIR"
  command -v deno >/dev/null 2>&1 && echo "Run: rune --help"
  exit 0
fi

# --- 2. Pick the prebuilt for this platform ---
os="$(uname -s)"
arch="$(uname -m)"
case "$os-$arch" in
  Darwin-arm64) target="aarch64-apple-darwin" ;;
  Darwin-x86_64) target="x86_64-apple-darwin" ;;
  Linux-x86_64 | Linux-amd64) target="x86_64-unknown-linux-gnu" ;;
  *)
    echo "rune: no prebuilt binary for $os-$arch." >&2
    echo "Build from source: git clone https://github.com/$REPO && cd rune && deno task install" >&2
    exit 1
    ;;
esac

# --- 3. Download + install (the tag was resolved up top) ---
url="https://github.com/$REPO/releases/download/$tag/rune-$target.tar.gz"
echo "Downloading rune $tag ($target)…"
curl -fSL "$url" -o "$tmp/rune.tar.gz"

# Unpack to a staging dir (the tarball also carries the skill/ + agent/ dirs,
# which must not land in BINDIR), then move the binaries into place.
mkdir -p "$tmp/pkg" "$BINDIR"
tar -C "$tmp/pkg" -xzf "$tmp/rune.tar.gz"
for b in $BINS; do
  mv -f "$tmp/pkg/$b" "$BINDIR/$b"
  chmod +x "$BINDIR/$b"
done

# Let Gatekeeper run the freshly downloaded macOS binaries.
if [ "$os" = "Darwin" ]; then
  for b in $BINS; do xattr -d com.apple.quarantine "$BINDIR/$b" 2>/dev/null || true; done
fi

# The skills ship as a skill/ dir inside the release tarball, version-matched to
# the binaries — that dir CONTAINS every rune:* skill folder (rune:scope, rune:spec,
# rune:data, rune:build, rune:cake, rune:framework, rune:docs, rune:diamond), so
# install_skills replaces each in turn.
# Fallback for releases that predate the dir: fetch claude/skills/MANIFEST.txt from
# the repo at $RUNE_REF and curl each listed repo-relative path into a staging tree
# mirroring claude/skills/, then install every folder under it.
if [ -d "$tmp/pkg/skill" ]; then
  install_skills "$tmp/pkg/skill"
elif curl -fsSL "https://raw.githubusercontent.com/$REPO/$RUNE_REF/claude/skills/MANIFEST.txt" \
       -o "$tmp/MANIFEST.txt" 2>/dev/null; then
  # Each line is a repo-relative path like claude/skills/rune:spec/SKILL.md. Mirror
  # the layout under $tmp/skill so install_skills sees one folder per skill.
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    case "$path" in claude/skills/*) rel="${path#claude/skills/}" ;; *) continue ;; esac
    dst="$tmp/skill/$rel"
    mkdir -p "$(dirname "$dst")"
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$RUNE_REF/$path" \
      -o "$dst" 2>/dev/null || true
  done < "$tmp/MANIFEST.txt"
  install_skills "$tmp/skill"
else
  # No manifest either — fetch just rune:spec/SKILL.md so something installs.
  mkdir -p "$tmp/skill/rune:spec"
  if curl -fsSL "https://raw.githubusercontent.com/$REPO/$RUNE_REF/claude/skills/rune:spec/SKILL.md" \
       -o "$tmp/skill/rune:spec/SKILL.md" 2>/dev/null; then
    install_skills "$tmp/skill"
    echo "rune: skills manifest unavailable — installed rune:spec only." >&2
  else
    echo "rune: could not fetch the rune skills — binaries installed, skills left as-is." >&2
  fi
fi

# Agents ship the SAME way — an agent/ dir inside the release tarball holding every
# Claude Code agent (one top-level entry each), installed by base-level replace.
# A new surface, so there is no pre-tarball MANIFEST fallback: a release without an
# agent/ dir simply has no agents to install.
[ -d "$tmp/pkg/agent" ] && install_agents "$tmp/pkg/agent"

# The Claude Code plugin marketplace (claude/plugin/ — rune-lsp and any later
# plugin) ships the same way, as a plugin/ dir inside the tarball.
[ -d "$tmp/pkg/plugin" ] && install_plugins "$tmp/pkg/plugin"

echo "Installed rune $tag -> $BINDIR"
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "NOTE: add $BINDIR to your PATH (e.g. export PATH=\"$BINDIR:\$PATH\")." ;;
esac
if command -v deno >/dev/null 2>&1; then
  echo "Run: rune --help"
else
  echo "NOTE: install Deno (https://deno.com) so rune's type-aware lint rules work."
fi
