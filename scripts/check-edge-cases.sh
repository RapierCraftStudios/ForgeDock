#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-edge-cases.sh — Enforce that every FORGE:ARCHITECT edge case maps to a test in the diff or an untestable reason.
#
# Usage: check-edge-cases.sh --architect <file> --builder <file> --base <ref> [--repo <path>]
#
# <architect> is a FORGE:ARCHITECT comment body (or the extracted block); only the text between
# <!-- FORGE:EDGE_CASES:BEGIN --> and <!-- FORGE:EDGE_CASES:END --> is parsed. One record per line:
#   EDGE: id=e1 kind=error|edge|concurrency description=<free text>
# Only id= and kind= are parsed; the description is free text and is never interpreted. ids match ^e[0-9]+$.
# <builder> is a FORGE:BUILDER comment body (may be empty or absent content). Lines parsed:
#   EDGE_TEST: id=e1 test=<path>::<name>
#   EDGE_TEST: id=e1 untestable=<non-empty reason, spaces allowed>
#
# An id is covered when it has a non-empty untestable= reason, or a test=<path>::<name> where <name> (fixed-string)
# appears in a line ADDED to <path> by the change (merge-base(base,HEAD) to the working tree, plus untracked files).
# Pre-existing tests never satisfy a new edge case.
#
# Exit codes:
#   0  covered, or no edge-case block / empty block (prints "SKIP: ..."); on success prints "MAPPED_TESTS: <n>"
#   1  UNMAPPED: <id> | TEST_NOT_IN_DIFF: <id> <path>::<name> | EMPTY_REASON: <id> | DUPLICATE_ID: <id>
#   2  malformed block or EDGE_TEST line, bad arguments, unreadable input, unresolvable base, git failure —
#      NEVER a pass; callers report DEGRADED
#
# Offline, values are data (never eval'd). Portable to bash 3.2: no mapfile, no associative arrays.

set -uo pipefail

ARCH=""; BUILDER=""; BASE=""; REPO="."
USAGE="usage: check-edge-cases.sh --architect <file> --builder <file> --base <ref> [--repo <path>]"
die2() { echo "check-edge-cases: $*" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --architect) [ "$#" -ge 2 ] || die2 "--architect needs a value"; ARCH="$2"; shift 2 ;;
    --builder)   [ "$#" -ge 2 ] || die2 "--builder needs a value"; BUILDER="$2"; shift 2 ;;
    --base)      [ "$#" -ge 2 ] || die2 "--base needs a value"; BASE="$2"; shift 2 ;;
    --repo)      [ "$#" -ge 2 ] || die2 "--repo needs a value"; REPO="$2"; shift 2 ;;
    *) die2 "$USAGE" ;;
  esac
done
[ -n "$ARCH" ] && [ -n "$BUILDER" ] && [ -n "$BASE" ] || die2 "$USAGE"
[ -f "$ARCH" ] || die2 "architect file not found: $ARCH"
[ -f "$BUILDER" ] || die2 "builder file not found: $BUILDER"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/check-edge-cases.XXXXXX") || die2 "mktemp failed"
trap 'rm -rf "$TMP"' EXIT

# ---- extract BEGIN..END regions of the architect body --------------------------------------------------
awk -v out="$TMP/region" '
  index($0, "<!-- FORGE:EDGE_CASES:BEGIN -->") { if (inb) { bad = 1 } inb = 1; seen = 1; next }
  index($0, "<!-- FORGE:EDGE_CASES:END -->")   { if (!inb) { bad = 1 } inb = 0; next }
  inb { print > out }
  END { if (inb || bad) exit 3; if (!seen) exit 4 }
' "$ARCH"
case $? in
  0) ;;
  4) echo "SKIP: no edge-case block"; exit 0 ;;
  *) die2 "unbalanced FORGE:EDGE_CASES:BEGIN/END markers" ;;
esac

# ---- parse EDGE records ---------------------------------------------------------------------------------
: > "$TMP/ids"; : > "$TMP/dups"
EDGE_RE='^EDGE: id=(e[0-9]+) kind=(error|edge|concurrency)([[:space:]]|$)'
LN=0
if [ -f "$TMP/region" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    LN=$((LN+1)); line="${line%$'\r'}"
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in ""|'```'*) continue ;; esac
    [[ "$trimmed" =~ $EDGE_RE ]] || die2 "line $LN: malformed EDGE record: $trimmed"
    id="${BASH_REMATCH[1]}"
    if grep -Fxq -- "$id" "$TMP/ids"; then echo "$id" >> "$TMP/dups"; else echo "$id" >> "$TMP/ids"; fi
  done < "$TMP/region"
fi
if [ ! -s "$TMP/ids" ]; then echo "SKIP: empty edge-case block"; exit 0; fi

# ---- parse EDGE_TEST lines of the builder body ----------------------------------------------------------
: > "$TMP/maps"   # id<TAB>test|untestable<TAB>value
: > "$TMP/mapdups"
PRE='^(-[[:space:]]+)?EDGE_TEST:[[:space:]]+id=(e[0-9]+)[[:space:]]+(test|untestable)=(.*)$'
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  trimmed="${line#"${line%%[![:space:]]*}"}"
  case "$trimmed" in *EDGE_TEST:*) ;; *) continue ;; esac
  case "$trimmed" in EDGE_TEST:*|"- EDGE_TEST:"*) ;; *) continue ;; esac   # only line-leading records, not prose mentions
  [[ "$trimmed" =~ $PRE ]] || die2 "malformed EDGE_TEST line: $trimmed"
  mid="${BASH_REMATCH[2]}"; mkind="${BASH_REMATCH[3]}"; mval="${BASH_REMATCH[4]}"
  mval="${mval#"${mval%%[![:space:]]*}"}"; mval="${mval%"${mval##*[![:space:]]}"}"
  if awk -F'\t' -v s="$mid" '$1==s {ok=1} END{exit ok?0:1}' "$TMP/maps"; then echo "$mid" >> "$TMP/mapdups"; continue; fi
  printf '%s\t%s\t%s\n' "$mid" "$mkind" "$mval" >> "$TMP/maps"
done < "$BUILDER"

# ---- repo, base, merge-base -----------------------------------------------------------------------------
case "$BASE" in ""|-*) die2 "invalid --base: '$BASE'" ;; esac
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die2 "not a git work tree: $REPO"
git -C "$REPO" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1 || die2 "cannot resolve base ref '$BASE'"
MB=$(git -C "$REPO" merge-base "$BASE" HEAD 2>/dev/null) || die2 "no merge base between '$BASE' and HEAD"

# added_has <path> <name>: 0 when <name> (fixed string) occurs in a line added to <path>
added_has() {
  local p="$1" n="$2" rc
  if git -C "$REPO" ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    git -C "$REPO" diff -U0 --no-color "$MB" -- "$p" > "$TMP/d" 2>/dev/null || die2 "git diff failed for $p"
    awk -v n="$n" '/^\+\+\+/ {next} /^\+/ { if (index($0, n) > 0) ok=1 } END{exit ok?0:1}' "$TMP/d"; return $?
  fi
  # untracked (new, not yet staged) file: every line is added
  git -C "$REPO" ls-files --others --exclude-standard -- "$p" > "$TMP/u" 2>/dev/null || die2 "git ls-files failed"
  [ -s "$TMP/u" ] || return 1
  [ -f "$REPO/$p" ] || return 1
  awk -v n="$n" 'index($0, n) > 0 {ok=1} END{exit ok?0:1}' "$REPO/$p"; rc=$?
  return "$rc"
}

# ---- check ----------------------------------------------------------------------------------------------
RC=0; MAPPED=0
while IFS= read -r d; do [ -n "$d" ] && { echo "DUPLICATE_ID: $d"; RC=1; }; done < "$TMP/dups"
while IFS= read -r d; do [ -n "$d" ] && { echo "DUPLICATE_ID: $d (EDGE_TEST)"; RC=1; }; done < "$TMP/mapdups"
PATH_RE='^[A-Za-z0-9_./@+=:,-]+$'
NAME_RE='^[^[:space:]]{1,200}$'
while IFS= read -r id; do
  row=$(awk -F'\t' -v s="$id" '$1==s {print; exit}' "$TMP/maps")
  if [ -z "$row" ]; then echo "UNMAPPED: $id"; RC=1; continue; fi
  mkind=$(printf '%s' "$row" | cut -f2); mval=$(printf '%s' "$row" | cut -f3-)
  if [ "$mkind" = untestable ]; then
    [ -n "$mval" ] || { echo "EMPTY_REASON: $id"; RC=1; }
    continue
  fi
  case "$mval" in *::*) ;; *) die2 "$id: test= must be <path>::<name>: $mval" ;; esac
  tpath="${mval%%::*}"; tname="${mval##*::}"
  case "$tpath" in -*) die2 "$id: test path must not start with '-'" ;; esac
  [[ "$tpath" =~ $PATH_RE ]] || die2 "$id: invalid test path: $tpath"
  [[ "$tname" =~ $NAME_RE ]] || die2 "$id: invalid test name"
  if added_has "$tpath" "$tname"; then MAPPED=$((MAPPED+1)); else echo "TEST_NOT_IN_DIFF: $id $tpath::$tname"; RC=1; fi
done < "$TMP/ids"

if [ "$RC" -eq 0 ]; then
  echo "OK: edge cases covered ($(wc -l < "$TMP/ids" | tr -d ' ') id(s))"
  echo "MAPPED_TESTS: $MAPPED"
fi
exit "$RC"
