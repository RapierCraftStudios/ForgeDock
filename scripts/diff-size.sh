#!/usr/bin/env bash
# diff-size.sh — the ONE measurement of a build's diff size for the build phase size gate (forge#3450).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: diff-size.sh --repo-path P --base B [--threshold N] [--exclude-glob G]...
#   Measures lines changed (added + deleted) by the index plus any earlier commits against origin/B
#   (git diff --cached --numstat --no-renames origin/B), so it must run AFTER implement staged its changes
#   and BEFORE validate commits. Unstaged or untracked files are not measured. Binary files count 0.
#   Files matching the built-in default globs or any --exclude-glob are excluded (additive).
#   Glob rules: a glob ending in "/" matches that directory at any depth; any other glob is a bash
#   case pattern matched against the basename and the full path. Globs are data, never evaluated.
# Default globs (mirrored in docs/CONFIG.md under build.diff_size.exclude_globs):
#   lockfiles (package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock poetry.lock uv.lock go.sum Gemfile.lock
#   composer.lock), *.min.*, *.snap, dist/ build/ generated/ __generated__/ fixtures/ __snapshots__/ vendor/
# Output (stdout, key=value lines): diff_lines=N excluded_lines=M threshold=T over=true|false, then up to 10
#   "top=<lines> <path>" lines, largest first. threshold 0 disables the gate (over=false always).
# Exit: 0 measured (even when over); 2 usage or git failure with EMPTY stdout (fail closed: unknown is not zero).

set -euo pipefail

REPO_PATH=""; BASE=""; THRESHOLD="1000"; EXTRA=()
die() { echo "diff-size.sh: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path) [ $# -ge 2 ] || die "missing value for $1"; REPO_PATH="$2"; shift 2 ;;
    --base) [ $# -ge 2 ] || die "missing value for $1"; BASE="$2"; shift 2 ;;
    --threshold) [ $# -ge 2 ] || die "missing value for $1"; THRESHOLD="$2"; shift 2 ;;
    --exclude-glob) [ $# -ge 2 ] || die "missing value for $1"; [ -z "$2" ] || EXTRA+=("$2"); shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$REPO_PATH" ] && [ -d "$REPO_PATH" ] || die "--repo-path must be an existing directory"
[ -n "$BASE" ] || die "--base is required"
case "$THRESHOLD" in ""|*[!0-9]*) die "--threshold must be a non-negative integer" ;; esac

DEFAULTS=(package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock poetry.lock uv.lock go.sum Gemfile.lock composer.lock
  '*.min.*' '*.snap' dist/ build/ generated/ __generated__/ fixtures/ __snapshots__/ vendor/)
GLOBS=("${DEFAULTS[@]}" ${EXTRA[@]+"${EXTRA[@]}"})

excluded() { # path -> 0 when excluded
  local p="$1" b="${1##*/}" g
  for g in "${GLOBS[@]}"; do
    case "$g" in
      */) case "/$p" in *"/$g"*) return 0 ;; esac ;;
      *) case "$b" in $g) return 0 ;; esac; case "$p" in $g) return 0 ;; esac ;;
    esac
  done
  return 1
}

RAW="$(git -C "$REPO_PATH" diff --cached --numstat --no-renames -z "origin/$BASE" -- | tr '\0' '\001')" \
  || die "git diff against origin/$BASE failed"

TOTAL=0; EXCL=0; LIST=""
# -z numstat records are "added<TAB>deleted<TAB>path" separated by NUL (translated to \001 above).
while IFS= read -r -d $'\001' rec; do
  [ -n "$rec" ] || continue
  a="${rec%%$'\t'*}"; rest="${rec#*$'\t'}"; d="${rest%%$'\t'*}"; path="${rest#*$'\t'}"
  case "$a" in ''|*[!0-9]*) a=0 ;; esac
  case "$d" in ''|*[!0-9]*) d=0 ;; esac
  n=$((a + d))
  if excluded "$path"; then EXCL=$((EXCL + n)); else TOTAL=$((TOTAL + n)); LIST="${LIST}${n} ${path}"$'\n'; fi
done <<< "$RAW"

OVER=false
if [ "$THRESHOLD" -gt 0 ] && [ "$TOTAL" -gt "$THRESHOLD" ]; then OVER=true; fi
echo "diff_lines=$TOTAL"
echo "excluded_lines=$EXCL"
echo "threshold=$THRESHOLD"
echo "over=$OVER"
if [ -n "$LIST" ]; then
  printf '%s' "$LIST" | sort -t' ' -k1,1nr | head -n 10 | sed 's/^/top=/' || true
fi
