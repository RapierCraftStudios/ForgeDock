#!/usr/bin/env bash
# forge-resolve.sh — sourced helper: locate ForgeDock's OWN install root and resolve its scripts.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Source it, never exec it:   . "$_r/scripts/lib/forge-resolve.sh"
#   forge_root            prints the first trusted install root that carries scripts/lib/forge-resolve.sh
#   forge_resolve <name>  prints the absolute path of scripts/<name> from the first trusted root that has it,
#                         or prints nothing (status 1). Callers fail closed on empty output.
#
# Trust boundary: roots come only from the engine (FORGEDOCK_HOME), the plugin runtime
# (CLAUDE_PLUGIN_ROOT), the directory this file was sourced from, the legacy FORGE_ROOT/FORGE_HOME
# variables, the install.sh symlink, the marketplace checkout, and the newest pinned plugin cache under
# CLAUDE_CONFIG_DIR then ~/.claude. The consumer's working directory and the repo under review are
# author-controlled and are never consulted, and every root must be an absolute path.

# Root this file was sourced from (scripts/lib/.. /..), captured now because the cwd changes later.
_FORGE_SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd -P)"

# One absolute candidate root per line, highest priority first.
_forge_candidates() {
  local _l _cfg
  printf '%s\n' "${FORGEDOCK_HOME:-}" "${CLAUDE_PLUGIN_ROOT:-}" "$_FORGE_SELF_ROOT" "${FORGE_ROOT:-}" "${FORGE_HOME:-}"
  for _cfg in "${CLAUDE_CONFIG_DIR:-}" "$HOME/.claude"; do
    [ -n "$_cfg" ] || continue
    _l="$(readlink -f "$_cfg/commands/work-on.md" 2>/dev/null || true)"
    [ -n "$_l" ] && printf '%s\n' "${_l%/commands/work-on.md}"
    printf '%s\n' "$_cfg/plugins/marketplaces/forgedock"
    find -L "$_cfg/plugins/cache/forgedock/forgedock" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
      | awk -F/ '$NF ~ /^[0-9]+\.[0-9]+\.[0-9]+$/{split($NF,a,".");printf "%d %d %d %s\n",a[1],a[2],a[3],$(0)}' \
      | sort -k1,1nr -k2,2nr -k3,3nr | cut -d' ' -f4- || true
  done
}

# forge_resolve <path under scripts/>: print the first match, print nothing when unresolved.
forge_resolve() {
  local _n="${1:-}" _c _all
  case "$_n" in ''|/*|*..*) return 1 ;; esac
  # Materialize the list first: returning early from a `< <(...)` loop would close the pipe under the generator (EPIPE noise).
  _all="$(_forge_candidates)"
  while IFS= read -r _c; do
    case "$_c" in /*) [ -f "$_c/scripts/$_n" ] && { printf '%s\n' "$_c/scripts/$_n"; return 0; } ;; esac
  done <<< "$_all"
  return 1
}

# forge_root: print the first trusted install root (the one that carries this helper).
forge_root() {
  local _f
  _f="$(forge_resolve lib/forge-resolve.sh)" || return 1
  printf '%s\n' "${_f%/scripts/lib/forge-resolve.sh}"
}
