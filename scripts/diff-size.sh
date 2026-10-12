#!/usr/bin/env bash
# diff-size.sh — the ONE measurement of a build's diff size and scope (forge#3450, forge#3862).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: diff-size.sh --repo-path P --base B [--threshold N] [--exclude-glob G]...
#          [--test-weight PCT] [--module-depth N] [--plan-files FILE] [--estimate N] [--overrun-pct PCT]
#   The size is never a gate (forge#3862): review_weight scales review depth and the scope diff (--plan-files) flags
#   files outside the architect plan. --threshold/over/cohesive are DEPRECATED (kept one release for old callers).
#   Measures lines changed (added + deleted) by the index plus any earlier commits against the MERGE BASE of
#   HEAD and origin/B (git diff --cached --numstat --no-renames $(git merge-base HEAD origin/B)), so commits that
#   landed on the base after the branch point are never counted as this build's changes. Exit 2 when the merge
#   base cannot be computed. It must run AFTER implement staged its changes
#   and BEFORE validate commits. Unstaged or untracked files are not measured. Binary files count 0.
#   Files matching the built-in default globs or any --exclude-glob are excluded (additive).
#   Glob rules: a configured (--exclude-glob) glob ending in "/" matches that directory at any depth; any other
#   glob is a bash case pattern matched against the basename and the full path. The built-in directory defaults
#   build/ dist/ generated/ fixtures/ vendor/ are anchored to the repo root (so first-party dirs such as
#   commands/work-on/build/ are counted); __generated__/ and __snapshots__/ match at any depth.
#   Globs are data, never evaluated.
# Default globs (mirrored in docs/CONFIG.md under build.scope.exclude_globs, deprecated alias build.diff_size.exclude_globs):
#   lockfiles (package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock poetry.lock uv.lock go.sum Gemfile.lock
#   composer.lock), *.min.*, *.snap, root-anchored dist/ build/ generated/ fixtures/ vendor/, any-depth
#   __generated__/ __snapshots__/
# Output (stdout, key=value lines): diff_lines=N excluded_lines=M threshold=T over=true|false, then the cohesion
#   measure new_lines=N test_lines=N cohesive_lines=N cohesive=true|false, then up to 10
#   "top=<lines> <path>" lines, largest first. threshold 0 disables the gate (over=false always).
#   Cohesion (forge#3790) counts only non-excluded files. new_lines = lines in files ADDED by the diff;
#   test_lines = lines in test files (a test/ tests/ __tests__/ directory segment, *.test.* *.spec.* test_* *_test.*
#   by basename); cohesive_lines = the union (a new test file counts once). cohesive=true when diff_lines>0 and
#   cohesive_lines*100 >= 70*diff_lines and diff_lines <= threshold*3/2 (integer math; threshold 0 -> false).
#   Test lines are classified, never discounted from diff_lines.
#   review_weight (forge#3862): ws_lines = lines changed with whitespace ignored (git diff -w; a pure re-indent is 0)
#   over the counted (non-excluded) files; review_weight = ceil((ws_lines of non-test files + --test-weight percent
#   (default 50) of ws_lines of test files)); modules = distinct directories (first --module-depth path segments,
#   default 2) holding a file with at least one non-whitespace changed line. Keys ws_lines, review_weight, modules
#   follow cohesive= and precede top=.
#   Scope diff, emitted only with --plan-files and/or --estimate: --plan-files FILE lists the architect's planned files
#   (one per line; a leading "- " or "* ", backticks and "./" are stripped; an entry ending in "/" is a directory prefix;
#   blank and "#" lines are ignored). scope=no_baseline (no entries) | ok | out_of_plan; plan_files=N; out_of_plan_count=K;
#   up to 50 "out_of_plan=<path>" lines (counted files absent from the plan). --estimate N with --overrun-pct P
#   (default 200) sets overrun=true when ws_lines*100 > N*P (N=0 means no estimate: overrun=false). Unreadable
#   --plan-files is exit 2 (fail closed: an unreadable plan is never "in plan").
# Exit: 0 measured (even when over); 2 usage or git failure with EMPTY stdout (fail closed: unknown is not zero).

set -euo pipefail
# Telemetry (forge#3834): best-effort decision record; never changes stdout, stderr or the exit code.
_TEL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/telemetry.sh"; [ -f "$_TEL" ] && . "$_TEL" 2>/dev/null
type forge_emit >/dev/null 2>&1 || forge_emit() { :; }

REPO_PATH=""; BASE=""; THRESHOLD="1000"; EXTRA=(); TEST_WEIGHT="50"; MODULE_DEPTH="2"; PLAN_FILE=""; ESTIMATE=""; OVERRUN_PCT="200"
die() { echo "diff-size.sh: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path) [ $# -ge 2 ] || die "missing value for $1"; REPO_PATH="$2"; shift 2 ;;
    --base) [ $# -ge 2 ] || die "missing value for $1"; BASE="$2"; shift 2 ;;
    --threshold) [ $# -ge 2 ] || die "missing value for $1"; THRESHOLD="$2"; shift 2 ;;
    --exclude-glob) [ $# -ge 2 ] || die "missing value for $1"; [ -z "$2" ] || EXTRA+=("$2"); shift 2 ;;
    --test-weight) [ $# -ge 2 ] || die "missing value for $1"; TEST_WEIGHT="$2"; shift 2 ;;
    --module-depth) [ $# -ge 2 ] || die "missing value for $1"; MODULE_DEPTH="$2"; shift 2 ;;
    --plan-files) [ $# -ge 2 ] || die "missing value for $1"; PLAN_FILE="$2"; shift 2 ;;
    --estimate) [ $# -ge 2 ] || die "missing value for $1"; ESTIMATE="$2"; shift 2 ;;
    --overrun-pct) [ $# -ge 2 ] || die "missing value for $1"; OVERRUN_PCT="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$REPO_PATH" ] && [ -d "$REPO_PATH" ] || die "--repo-path must be an existing directory"
[ -n "$BASE" ] || die "--base is required"
case "$THRESHOLD" in ""|*[!0-9]*) die "--threshold must be a non-negative integer" ;; esac
case "$TEST_WEIGHT" in ""|*[!0-9]*) die "--test-weight must be a non-negative integer percent" ;; esac
case "$MODULE_DEPTH" in ""|0|*[!0-9]*) die "--module-depth must be a positive integer" ;; esac
case "$OVERRUN_PCT" in ""|*[!0-9]*) die "--overrun-pct must be a non-negative integer percent" ;; esac
case "$ESTIMATE" in ""|*[!0-9]*) [ -z "$ESTIMATE" ] || die "--estimate must be a non-negative integer" ;; esac
PLAN=(); PLAN_SET=0
if [ -n "$PLAN_FILE" ]; then
  [ -f "$PLAN_FILE" ] && [ -r "$PLAN_FILE" ] || die "--plan-files must be a readable file"
  PLAN_SET=1
  while IFS= read -r _l || [ -n "$_l" ]; do
    _l="${_l#"${_l%%[![:space:]]*}"}"; _l="${_l%"${_l##*[![:space:]]}"}"
    case "$_l" in ""|"#"*) continue ;; esac
    case "$_l" in "- "*|"* "*) _l="${_l#??}" ;; esac
    _l="${_l//\`/}"; _l="${_l#./}"
    [ -n "$_l" ] && PLAN+=("$_l")
  done < "$PLAN_FILE"
fi

DEFAULTS=(package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock poetry.lock uv.lock go.sum Gemfile.lock composer.lock
  '*.min.*' '*.snap' __generated__/ __snapshots__/)
ROOT_DIRS=(dist/ build/ generated/ fixtures/ vendor/)
GLOBS=("${DEFAULTS[@]}" ${EXTRA[@]+"${EXTRA[@]}"})

excluded() { # path -> 0 when excluded
  local p="$1" b="${1##*/}" g
  for g in "${ROOT_DIRS[@]}"; do case "$p" in "$g"*) return 0 ;; esac; done
  for g in "${GLOBS[@]}"; do
    case "$g" in
      */) case "/$p" in *"/$g"*) return 0 ;; esac ;;
      *) case "$b" in $g) return 0 ;; esac; case "$p" in $g) return 0 ;; esac ;;
    esac
  done
  return 1
}

MB="$(git -C "$REPO_PATH" merge-base HEAD "origin/$BASE" 2>/dev/null)" && [ -n "$MB" ] \
  || die "cannot compute merge base of HEAD and origin/$BASE"
RAW="$(git -C "$REPO_PATH" diff --cached --numstat --no-renames -z "$MB" -- | tr '\0' '\001')" \
  || die "git diff against merge base $MB failed"

ADDED="$(git -C "$REPO_PATH" diff --cached --diff-filter=A --no-renames --name-only -z "$MB" -- | tr '\0' '\001')" \
  || die "git diff --diff-filter=A against merge base $MB failed"
is_added() { # path -> 0 when the diff adds the file
  case "$ADDED_SET" in *$'\001'"$1"$'\001'*) return 0 ;; esac
  return 1
}
is_test() { # path -> 0 when it is a test file (directory segments exact, name patterns on the basename)
  local p="$1" b="${1##*/}"
  case "/$p" in */test/*|*/tests/*|*/__tests__/*) return 0 ;; esac
  case "$b" in *.test.*|*.spec.*|test_*|*_test.*) return 0 ;; esac
  return 1
}
ADDED_SET=$'\001'"$ADDED"

TOTAL=0; EXCL=0; LIST=""; NEWL=0; TESTL=0; COHL=0
# -z numstat records are "added<TAB>deleted<TAB>path" separated by NUL (translated to \001 above).
while IFS= read -r -d $'\001' rec; do
  [ -n "$rec" ] || continue
  a="${rec%%$'\t'*}"; rest="${rec#*$'\t'}"; d="${rest%%$'\t'*}"; path="${rest#*$'\t'}"
  case "$a" in ''|*[!0-9]*) a=0 ;; esac
  case "$d" in ''|*[!0-9]*) d=0 ;; esac
  n=$((a + d))
  if excluded "$path"; then EXCL=$((EXCL + n)); else
    TOTAL=$((TOTAL + n)); LIST="${LIST}${n} ${path}"$'\n'
    isn=0; ist=0
    if is_added "$path"; then isn=1; NEWL=$((NEWL + n)); fi
    if is_test "$path"; then ist=1; TESTL=$((TESTL + n)); fi
    if [ "$isn" = 1 ] || [ "$ist" = 1 ]; then COHL=$((COHL + n)); fi
  fi
done <<< "$RAW"

# Whitespace-insensitive pass (forge#3862): review_weight and module count come from `git diff -w`.
RAWW="$(git -C "$REPO_PATH" diff --cached -w --numstat --no-renames -z "$MB" -- | tr '\0' '\001')" \
  || die "git diff -w against merge base $MB failed"
WSL=0; WS_NT=0; WS_T=0; MODS=$'\001'; NMODS=0
while IFS= read -r -d $'\001' rec; do
  [ -n "$rec" ] || continue
  a="${rec%%$'\t'*}"; rest="${rec#*$'\t'}"; d="${rest%%$'\t'*}"; path="${rest#*$'\t'}"
  case "$a" in ''|*[!0-9]*) a=0 ;; esac
  case "$d" in ''|*[!0-9]*) d=0 ;; esac
  n=$((a + d))
  excluded "$path" && continue
  WSL=$((WSL + n))
  if is_test "$path"; then WS_T=$((WS_T + n)); else WS_NT=$((WS_NT + n)); fi
  if [ "$n" -gt 0 ]; then
    dir="${path%/*}"; [ "$dir" = "$path" ] && dir="."
    mod=""; _i=0; _rest="$dir"
    while [ "$_i" -lt "$MODULE_DEPTH" ] && [ -n "$_rest" ]; do
      _seg="${_rest%%/*}"; mod="${mod:+$mod/}$_seg"
      case "$_rest" in */*) _rest="${_rest#*/}" ;; *) _rest="" ;; esac
      _i=$((_i + 1))
    done
    case "$MODS" in *$'\001'"$mod"$'\001'*) ;; *) MODS="${MODS}${mod}"$'\001'; NMODS=$((NMODS + 1)) ;; esac
  fi
done <<< "$RAWW"
REVIEW_WEIGHT=$(( (WS_NT * 100 + WS_T * TEST_WEIGHT + 99) / 100 ))

OVER=false
if [ "$THRESHOLD" -gt 0 ] && [ "$TOTAL" -gt "$THRESHOLD" ]; then OVER=true; fi
echo "diff_lines=$TOTAL"
echo "excluded_lines=$EXCL"
echo "threshold=$THRESHOLD"
echo "over=$OVER"
COHESIVE=false
if [ "$THRESHOLD" -gt 0 ] && [ "$TOTAL" -gt 0 ] && [ $((COHL * 100)) -ge $((70 * TOTAL)) ] \
  && [ $((TOTAL * 2)) -le $((THRESHOLD * 3)) ]; then COHESIVE=true; fi
echo "new_lines=$NEWL"
echo "test_lines=$TESTL"
echo "cohesive_lines=$COHL"
echo "cohesive=$COHESIVE"
echo "ws_lines=$WSL"
echo "review_weight=$REVIEW_WEIGHT"
echo "modules=$NMODS"
OOP_LIST=""; OOP=0; SCOPE=ok
if [ "$PLAN_SET" = 1 ] || [ -n "$ESTIMATE" ]; then
  if [ "${#PLAN[@]}" -eq 0 ]; then SCOPE=no_baseline; else
    while IFS= read -r -d $'\001' rec; do
      [ -n "$rec" ] || continue
      path="${rec#*$'\t'}"; path="${path#*$'\t'}"
      excluded "$path" && continue
      inplan=0
      for _p in "${PLAN[@]}"; do
        case "$_p" in */) case "$path" in "$_p"*) inplan=1; break ;; esac ;; *) [ "$path" = "$_p" ] && { inplan=1; break; } ;; esac
      done
      if [ "$inplan" = 0 ]; then OOP=$((OOP + 1)); OOP_LIST="${OOP_LIST}${path}"$'\n'; fi
    done <<< "$RAW"
    [ "$OOP" -gt 0 ] && SCOPE=out_of_plan
  fi
  OVERRUN=false
  if [ -n "$ESTIMATE" ] && [ "$ESTIMATE" -gt 0 ] && [ $((WSL * 100)) -gt $((ESTIMATE * OVERRUN_PCT)) ]; then OVERRUN=true; fi
  echo "scope=$SCOPE"
  echo "plan_files=${#PLAN[@]}"
  echo "out_of_plan_count=$OOP"
  [ -n "$ESTIMATE" ] && { echo "estimate=$ESTIMATE"; echo "overrun=$OVERRUN"; }
fi
_res=OK; if [ "$COHESIVE" = true ]; then _res=COHESIVE; elif [ "$OVER" = true ]; then _res=OVER; fi
forge_emit diff_size lines="$TOTAL" excluded="$EXCL" threshold="$THRESHOLD" result="$_res" review_weight="$REVIEW_WEIGHT" modules="$NMODS" ws_lines="$WSL"
if [ -n "$LIST" ]; then
  printf '%s' "$LIST" | sort -t' ' -k1,1nr | head -n 10 | sed 's/^/top=/' || true
fi
if [ -n "$OOP_LIST" ]; then
  printf '%s' "$OOP_LIST" | head -n 50 | sed 's/^/out_of_plan=/' || true
fi
