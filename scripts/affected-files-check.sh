#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# affected-files-check.sh — /issue Phase 3E rule 2: are the draft's Affected Files real? (forge#4172)
#
# Usage:
#   affected-files-check.sh <body-file> [--ref <git-ref>]... [--spike <spike-doc>]
#
#   <body-file>   issue body (markdown); paths are the backticked tokens containing '/' or '.'
#                 inside its `## Affected Files` section (up to the next `## ` heading).
#   --ref         git ref to check existence against (repeatable). Default: origin/staging then
#                 origin/main; refs that do not resolve are skipped. Run from the target repo.
#   --spike       greenfield mode: a path that exists at no ref still passes as PLANNED when it
#                 equals an entry of the spike doc's repo-layout section, or starts with an entry
#                 ending in '/'. The section is the first heading matching /repo layout/i; its
#                 entries are backticked paths plus the lines of fenced blocks (tree glyphs and
#                 `#` comments stripped). Entries are full repo-relative paths: indentation-based
#                 nesting is not reconstructed.
#
# Output: one `OK <path>` | `PLANNED <path>` | `MISSING <path>` line per path.
# Exit:   0 no MISSING | 1 any MISSING, or no paths found | 2 usage error (no body file,
#         --spike file absent, spike doc without a repo-layout section or entries).
# Deterministic, no LLM. bash 3.2 portable.

set -u
BODY_FILE=""
SPIKE=""
REFS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ -n "${2:-}" ] || { echo "affected-files-check: --ref requires a value" >&2; exit 2; }
           REFS="$REFS
$2"; shift 2 ;;
    --spike) [ -n "${2:-}" ] || { echo "affected-files-check: --spike requires a value" >&2; exit 2; }
             SPIKE="$2"; shift 2 ;;
    --*) echo "affected-files-check: unknown argument: $1" >&2; exit 2 ;;
    *) [ -z "$BODY_FILE" ] || { echo "affected-files-check: more than one body file" >&2; exit 2; }
       BODY_FILE="$1"; shift ;;
  esac
done
[ -n "$BODY_FILE" ] && [ -r "$BODY_FILE" ] || { echo "usage: affected-files-check.sh <body-file> [--ref <git-ref>]... [--spike <spike-doc>]" >&2; exit 2; }
[ -n "$REFS" ] || REFS="
origin/staging
origin/main"

# Backticked path-like tokens from the `## Affected Files` section.
PATHS=$(awk '/^## /{ins=($0 ~ /^## Affected Files[[:space:]]*$/); next} ins' "$BODY_FILE" \
  | grep -oE '`[^` ]+`' | tr -d '`' | grep -E '[/.]' | sed 's|^\./||; s|:[0-9][0-9,-]*$||' | awk '!seen[$0]++' || true)

LAYOUT=""
if [ -n "$SPIKE" ]; then
  [ -r "$SPIKE" ] || { echo "affected-files-check: spike doc not found: $SPIKE" >&2; exit 2; }
  grep -qiE '^#+[[:space:]].*repo layout' "$SPIKE" || { echo "affected-files-check: spike doc has no 'Repo layout' section: $SPIKE" >&2; exit 2; }
  LAYOUT=$(awk '
      /^[[:space:]]*```/ { fence=!fence; next }
      !fence && /^#+[[:space:]]/ { if (ins) exit; if (tolower($0) ~ /repo layout/) ins=1; next }
      !ins { next }
      fence { sub(/#.*/, ""); gsub(/├──|└──|│|─/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if ($0 != "") print; next }
      { while (match($0, /`[^` ]+`/)) { print substr($0, RSTART+1, RLENGTH-2); $0 = substr($0, RSTART+RLENGTH) } }
    ' "$SPIKE" | sed 's|^\./||' | grep -E '[/.]' | awk '!seen[$0]++' || true)
  [ -n "$LAYOUT" ] || { echo "affected-files-check: spike doc 'Repo layout' section declares no paths: $SPIKE" >&2; exit 2; }
fi

[ -n "$PATHS" ] || { echo "MISSING (no backticked paths in ## Affected Files)"; exit 1; }

exists_at_ref() { # path -> 0 when it exists at any resolvable ref
  printf '%s\n' "$REFS" | while IFS= read -r r; do
    [ -n "$r" ] || continue
    git cat-file -e "$r:$1" 2>/dev/null && { echo y; break; }
  done | grep -q y
}
in_layout() { # path -> 0 when it equals a declared entry or sits under a declared directory
  printf '%s\n' "$LAYOUT" | while IFS= read -r e; do
    [ -n "$e" ] || continue
    if [ "$1" = "$e" ]; then echo y; break; fi
    case "$e" in */) case "$1" in "$e"*) echo y; break ;; esac ;; esac
  done | grep -q y
}

FAIL=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if exists_at_ref "$p"; then echo "OK $p"
  elif [ -n "$LAYOUT" ] && in_layout "$p"; then echo "PLANNED $p"
  else echo "MISSING $p"; FAIL=1
  fi
done <<EOF
$PATHS
EOF
exit $FAIL
