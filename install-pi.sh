#!/usr/bin/env bash
# RapierCraft ForgeDock — Install Pi adapter
#
# Installs this repository as a Pi package so Pi discovers the ForgeDock
# extension commands (/forge, /forge-work-on, /forge-review-pr, ...).

set -euo pipefail

FORGE_HOME="$(cd "$(dirname "$0")" && pwd)"

# Encode the filesystem path before writing it as executable shell profile text.
# The resulting single-quoted literal is valid in both Bash and zsh.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
FORGE_HOME_SHELL_LITERAL=$(shell_quote "$FORGE_HOME")

if ! command -v pi >/dev/null 2>&1; then
  echo "error: pi is not on PATH. Install Pi first: npm install -g --ignore-scripts @earendil-works/pi-coding-agent" >&2
  exit 1
fi

echo "RapierCraft ForgeDock — Installing Pi adapter"
echo "  Source: $FORGE_HOME"
echo ""

pi install "$FORGE_HOME"

PROFILE_UPDATED=0
for profile in "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$profile" ] && ! grep -q "FORGE_HOME" "$profile" 2>/dev/null; then
    {
      echo ""
      echo "# RapierCraft ForgeDock — autonomous development pipeline"
      printf 'export FORGE_HOME=%s\n' "$FORGE_HOME_SHELL_LITERAL"
    } >> "$profile"
    echo "Added FORGE_HOME to $profile"
    PROFILE_UPDATED=$((PROFILE_UPDATED + 1))
  fi
done

echo ""
echo "Done. Restart Pi or run /reload in an existing Pi session."
echo "Commands: /forge, /forge-work-on, /forge-review-pr, /forge-orchestrate, ..."
echo "Reference: $FORGE_HOME/docs/PI.md"

if [ "$PROFILE_UPDATED" -gt 0 ]; then
  echo ""
  echo "Restart your shell or run:"
  printf '  export FORGE_HOME=%s\n' "$FORGE_HOME_SHELL_LITERAL"
fi
