#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-contract-scope.sh — Parser/validator for the `### Out of Scope` section of a
#                            FORGE:CONTRACT comment. One grammar shared by work-on:build
#                            (validate before posting) and review-pr (list, to demote findings
#                            that match a contract-declared item).
#
# Usage:
#   check-contract-scope.sh validate [<file>]   # exit 0 valid, 1 invalid (one line per bad item on stderr)
#   check-contract-scope.sh list     [<file>]   # TSV: disposition<TAB>path<TAB>issue, one row per path
#   Input is the contract comment body, from <file> or stdin.
#
# Grammar. The section is either the single line `None.` or a list of bullets, each naming at
# least one backticked path or symbol followed by exactly one disposition:
#   - `path` — deferred → #N: <why>        (a follow-up issue exists; `->` is accepted for `→`)
#   - `path` — not-affected: <evidence>
#   - `path` — accepted-risk: <reason>
# `deferred` without an issue number, an item without a backticked path, an item with no
# disposition, and a missing or empty section are all invalid.
#
# `list` prints disposition as one of: deferred, not-affected, accepted-risk. The issue column is
# the number for deferred rows and empty otherwise. A trailing `/` is stripped from paths. `*`
# is not a glob: consumers match literally (equal, or under the path as a directory prefix).
# `list` on an invalid section prints nothing and exits 1 (fail toward filing in review).
#
# Exit: 0 ok; 1 invalid section; 2 usage error. Portable: bash 3.2, no network.

set -u

usage() { echo "ERROR: Usage: check-contract-scope.sh validate|list [<file>]" >&2; exit 2; }

MODE="${1:-}"
case "$MODE" in validate|list) ;; *) usage ;; esac
[ "$#" -le 2 ] || usage
if [ "$#" -eq 2 ]; then
  [ -r "$2" ] || { echo "ERROR: not readable: $2" >&2; exit 2; }
  BODY=$(cat "$2")
else
  BODY=$(cat)
fi

SECTION=$(printf '%s\n' "$BODY" | tr -d '\r' | awk '
  /^### Out of Scope[[:space:]]*$/ { p = 1; found = 1; next }
  p && /^### / { p = 0 }
  p && /^> Pipeline powered by/ { p = 0 }
  p && /^<!--/ { p = 0 }
  p { print }
  END { if (!found) exit 3 }
')
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "invalid: no '### Out of Scope' section" >&2
  exit 1
fi

ROWS=""
ERRS=""
COUNT=0
NONE=0
ITEM=""

flush_item() {
  [ -n "$ITEM" ] || return 0
  COUNT=$((COUNT + 1))
  _text=$(printf '%s' "$ITEM" | sed -E 's/deferred[[:space:]]*(→|->)[[:space:]]*/deferred → /g')
  # Earliest disposition keyword wins; the prefix before it holds the paths.
  _pre_n="${_text%%not-affected:*}"
  _pre_a="${_text%%accepted-risk:*}"
  _pre_d="${_text%%deferred → *}"
  _disp=""; _pre="$_text"
  if [ "$_pre_n" != "$_text" ]; then _disp="not-affected"; _pre="$_pre_n"; fi
  if [ "$_pre_a" != "$_text" ] && { [ -z "$_disp" ] || [ "${#_pre_a}" -lt "${#_pre}" ]; }; then _disp="accepted-risk"; _pre="$_pre_a"; fi
  if [ "$_pre_d" != "$_text" ] && { [ -z "$_disp" ] || [ "${#_pre_d}" -lt "${#_pre}" ]; }; then _disp="deferred"; _pre="$_pre_d"; fi
  _issue=""
  if [ -z "$_disp" ]; then
    ERRS="${ERRS}untyped item (needs deferred → #N, not-affected:, or accepted-risk:): ${ITEM}
"
    ITEM=""; return 0
  fi
  if [ "$_disp" = "deferred" ]; then
    _rest="${_text#*deferred → }"
    if [[ "$_rest" =~ ^#([0-9]+) ]]; then
      _issue="${BASH_REMATCH[1]}"
    else
      ERRS="${ERRS}deferred item has no issue number (needs deferred → #N): ${ITEM}
"
      ITEM=""; return 0
    fi
  fi
  _paths=$(printf '%s' "$_pre" | grep -o '`[^`][^`]*`' | tr -d '`')
  if [ -z "$_paths" ]; then
    ERRS="${ERRS}item names no backticked path or symbol: ${ITEM}
"
    ITEM=""; return 0
  fi
  while IFS= read -r _p; do
    [ -n "$_p" ] || continue
    _p="${_p%/}"
    ROWS="${ROWS}${_disp}	${_p}	${_issue}
"
  done <<EOP
$_paths
EOP
  ITEM=""
}

while IFS= read -r line; do
  trimmed=$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  [ -n "$trimmed" ] || continue
  case "$trimmed" in
    "None."|"- None."|"* None.") NONE=1; continue ;;
    "- "*|"* "*)
      flush_item
      ITEM=$(printf '%s' "$trimmed" | sed -E 's/^[-*][[:space:]]+//') ;;
    *)
      if [ -n "$ITEM" ]; then ITEM="${ITEM} ${trimmed}"
      else ERRS="${ERRS}unexpected text outside a bullet: ${trimmed}
"; fi ;;
  esac
done <<EOS
$SECTION
EOS
flush_item

if [ "$COUNT" -eq 0 ] && [ "$NONE" -eq 0 ] && [ -z "$ERRS" ]; then
  ERRS="empty '### Out of Scope' section (write None. or typed items)
"
fi

if [ -n "$ERRS" ]; then
  printf 'invalid: %s' "$ERRS" >&2
  exit 1
fi
[ "$MODE" = "list" ] && printf '%s' "$ROWS"
exit 0
