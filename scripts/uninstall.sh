#!/usr/bin/env sh
# Uninstall rune — remove rune + rune-lsp + rune-syntax from EVERY location an
# install (current or legacy) may have placed them, so no stale/duplicate copies
# linger on your PATH.
#
#   curl -fsSL https://github.com/mrg-keystone/rune/releases/download/latest/uninstall.sh | sh
#
# RUNE_INSTALL — also clean this dir (the install target; default ~/.deno/bin).
set -u

bins="rune
rune-lsp
rune-syntax"
# The current install target plus every dir a past install / cargo `bind` /
# editor-integration step is known to have used.
dirs="${RUNE_INSTALL:-$HOME/.deno/bin}
$HOME/.deno/bin
$HOME/.cargo/bin
$HOME/.local/bin
/usr/local/bin
/opt/homebrew/bin"

# Split both lists on NEWLINES only, so an install dir containing spaces (e.g. a
# RUNE_INSTALL under "Application Support") survives word-splitting intact.
IFS='
'
seen=" "
removed=0
for d in $dirs; do
  case "$seen" in *" $d "*) continue ;; esac   # de-dupe repeated dirs
  seen="$seen$d "
  for b in $bins; do
    if [ -e "$d/$b" ] || [ -L "$d/$b" ]; then
      if rm -f "$d/$b" 2>/dev/null; then
        echo "removed $d/$b"
        removed=$((removed + 1))
      else
        echo "could not remove $d/$b (try: sudo rm -f $d/$b)" >&2
      fi
    fi
  done
done

# The rune Claude Code skill (user scope). The managed set is SKILL.md +
# references/ — anything else in the folder (evals/, notes) is the user's. A
# symlinked skill dir (the old README setup) is unlinked, never followed into a
# checkout.
skilldir="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/rune"
if [ -L "$skilldir" ]; then
  rm -f "$skilldir" && echo "removed $skilldir (symlink)" && removed=$((removed + 1))
elif [ -e "$skilldir/SKILL.md" ]; then
  if rm -f "$skilldir/SKILL.md" 2>/dev/null; then
    echo "removed $skilldir/SKILL.md"
    removed=$((removed + 1))
    [ -d "$skilldir/references" ] && rm -rf "$skilldir/references" && echo "removed $skilldir/references"
    rmdir "$skilldir" 2>/dev/null || true
  fi
fi

# Clean up the legacy standalone keep skill — it folded into the rune skill, so
# remove any copy a previous install left behind.
keepskill="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/keep"
if [ -d "$keepskill" ] && [ ! -L "$keepskill" ]; then
  rm -rf "$keepskill" && echo "removed $keepskill (folded into the rune skill)" && removed=$((removed + 1))
fi

# The Claude Code plugin marketplace the installer staged (claude/plugin/ →
# ~/.claude/rune-plugins, marketplace "rune"): unregister it when the claude CLI
# is here (that also uninstalls its plugins), then remove the directory.
pluginsdir="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/rune-plugins}"
if [ -d "$pluginsdir" ]; then
  command -v claude >/dev/null 2>&1 && claude plugin marketplace remove rune >/dev/null 2>&1 || true
  rm -rf "$pluginsdir" && echo "removed $pluginsdir (Claude Code plugin marketplace 'rune')" && removed=$((removed + 1))
fi

if [ "$removed" -eq 0 ]; then
  echo "rune: nothing to uninstall."
else
  echo "rune: removed $removed file(s)."
fi
