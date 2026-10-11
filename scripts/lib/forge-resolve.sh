#!/usr/bin/env bash
# forge-resolve.sh — sourced helper: locate ForgeDock's OWN install root and resolve its scripts.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Source it, never exec it:   . "$_r/scripts/lib/forge-resolve.sh"
#   forge_root            prints the first trusted install root that carries scripts/lib/forge-resolve.sh
#   forge_resolve <name>  prints the absolute path of scripts/<name> from the first trusted root that has it,
#                         or prints nothing (status 0). Callers fail closed on empty output.
#
# Trust boundary: roots come only from the engine (FORGEDOCK_HOME, authoritative when set), the plugin runtime
# (CLAUDE_PLUGIN_ROOT), the legacy FORGE_ROOT/FORGE_HOME variables, the install.sh symlink, the Codex
# $CODEX_HOME/forge-home file, the newest pinned plugin cache and the marketplace checkout under CLAUDE_CONFIG_DIR
# then ~/.claude, and last the directory this file was sourced from. The consumer's working directory and the repo
# under review are author-controlled and are never consulted, and every root must be an absolute path.
#
# Order (matches docs/CONFIG.md "Install root resolution"): FORGEDOCK_HOME (when set, nothing else is consulted) >
# CLAUDE_PLUGIN_ROOT > FORGE_ROOT > FORGE_HOME > install symlink > Codex forge-home > newest cache > marketplace > self.
# The self root is last on purpose: the stub locator that sourced this file picks a cache directory by glob order
# (lexical), so the helper re-resolves by the numeric-newest tier instead of trusting the copy that happened to load.

# Root this file was sourced from (scripts/lib/.. /..), captured now because the cwd changes later. Under zsh
# BASH_SOURCE is empty: a dirname of "" would be "." (a cwd-derived root), so there is no self root in that case.
_FORGE_SELF_ROOT=""
[ -n "${BASH_SOURCE[0]:-}" ] && _FORGE_SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd -P)"

# Windows drive-letter path (C:/x or C:\x) -> /c/x (cygpath when present); anything else is printed unchanged.
_forge_posix() {
  local _w="${1:-}" _u
  case "$_w" in
    [A-Za-z]:[/\\]*)
      _u="$(cygpath -u "$_w" 2>/dev/null || true)"
      [ -n "$_u" ] || _u="/$(printf %s "$_w" | cut -c1 | tr 'A-Z' 'a-z')$(printf %s "${_w#??}" | tr '\\' '/')"
      printf '%s\n' "$_u" ;;
    *) printf '%s\n' "$_w" ;;
  esac
}

# One absolute candidate root per line, highest priority first.
_forge_candidates() {
  local _l _cfg _mk _x _cx
  if [ -n "${FORGEDOCK_HOME:-}" ]; then _forge_posix "$FORGEDOCK_HOME"; return 0; fi
  _mk="${FORGEDOCK_MARKETPLACE:-forgedock}"; case "$_mk" in ""|.|..|*[!A-Za-z0-9._-]*) _mk="forgedock" ;; esac
  printf '%s\n' "${CLAUDE_PLUGIN_ROOT:-}" "${FORGE_ROOT:-}" "${FORGE_HOME:-}"
  for _cfg in "${CLAUDE_CONFIG_DIR:-}" "$HOME/.claude"; do
    [ -n "$_cfg" ] || continue
    _l="$(readlink -f "$_cfg/commands/work-on.md" 2>/dev/null || true)"
    [ -n "$_l" ] && printf '%s\n' "${_l%/commands/work-on.md}"
  done
  # Codex: install-codex.sh records the clone path in $CODEX_HOME/forge-home (one absolute path).
  _cx="${CODEX_HOME:-$HOME/.codex}"; case "$_cx" in /*) head -n 1 "$_cx/forge-home" 2>/dev/null || true; echo ;; esac
  for _cfg in "${CLAUDE_CONFIG_DIR:-}" "$HOME/.claude"; do
    [ -n "$_cfg" ] || continue
    find -L "$_cfg/plugins/cache/$_mk/forgedock" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
      | awk -F/ '$NF ~ /^[0-9]+\.[0-9]+\.[0-9]+$/{split($NF,a,".");printf "%d %d %d %s\n",a[1],a[2],a[3],$(0)}' \
      | sort -k1,1nr -k2,2nr -k3,3nr | cut -d' ' -f4- || true
  done
  for _cfg in "${CLAUDE_CONFIG_DIR:-}" "$HOME/.claude"; do
    [ -n "$_cfg" ] && printf '%s\n' "$_cfg/plugins/marketplaces/$_mk"
  done
  printf '%s\n' "$_FORGE_SELF_ROOT"
}

# forge_resolve <path under scripts/>: print the first match; print nothing when unresolved. Always returns 0, so a
# command substitution survives `set -e` and the caller's own empty-output check is the fail-closed branch.
forge_resolve() {
  local _n="${1:-}" _c _all
  case "$_n" in ''|/*|*..*) return 0 ;; esac
  # Materialize the list first: returning early from a `< <(...)` loop would close the pipe under the generator (EPIPE noise).
  _all="$(_forge_candidates)"
  while IFS= read -r _c; do
    case "$_c" in /*) [ -f "$_c/scripts/$_n" ] && { printf '%s\n' "$_c/scripts/$_n"; return 0; } ;; esac
  done <<< "$_all"
  return 0
}

# forge_root: print the first trusted install root (the one that carries this helper); prints nothing when unresolved.
forge_root() {
  local _f
  _f="$(forge_resolve lib/forge-resolve.sh)"
  [ -n "$_f" ] && printf '%s\n' "${_f%/scripts/lib/forge-resolve.sh}"
  return 0
}
