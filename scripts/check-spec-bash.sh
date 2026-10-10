#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-spec-bash.sh — Syntax-check the ```bash fenced blocks inside Markdown spec files.
#
# ForgeDock's pipeline is bash embedded in Markdown, and the quality gate's executable
# checks skip .md files. Spec bash therefore merged without ever being parsed, and
# reviewers became the first thing to run it (2026-10-08 audit). This script runs
# `bash -n` on each fenced block after neutralising spec notation, and optionally
# `shellcheck -S error`.
#
# Usage:
#   check-spec-bash.sh [--base <git-ref>] [--shellcheck] <file.md>...
#   check-spec-bash.sh --positional [<file.md>...]
#   check-spec-bash.sh --fence-state <VAR>... -- <file.md>...
#   check-spec-bash.sh            (no args: same as --positional over all Skill-loaded commands/**/*.md,
#                                  excluding orchestrate/**, pipeline-health/**, review-pr-agents/**)
#
#   --positional  Different check, opt-in: fail on any `$0`..`$9` inside a fenced code block.
#                 Claude Code rewrites those tokens with the invocation's arguments whenever a
#                 spec is loaded via Skill/slash command WITH args (awk `{print $2}` silently
#                 becomes `{print --issue}`). Use `${1}` in shell and `$(1)` in awk instead;
#                 `${N}`, `$(N)`, `$NF`, `$@`, `$#` and `$10`+ are not substituted. Suppress a
#                 deliberate hit by putting `allowlist:positional-arg` on the same line.
#                 Scope the file list to Skill-loaded specs (Read-loaded orchestrate/**,
#                 pipeline-health/** and the review-pr-agents catalog are not substituted).
#                 Output: `FAIL <file>:<line> positional arg ...` then `SPEC-POSITIONAL: ...`.
#   --fence-state Different check, opt-in: every Bash tool call is a fresh shell, so a variable bound
#                 in one fence is empty in the next. Fail any ```bash/sh fence that reads `$VAR` or
#                 `${VAR...}` for a listed VAR without assigning it in the same fence (`VAR=`,
#                 `export VAR=`, `read VAR`, `for VAR in`) at or before its first read. Comment-only lines are ignored; `$REPO`
#                 does not match `$REPO_FLAG`. Suppress a deliberate read by putting
#                 `allowlist:fence-state` on the same line. Pseudo-tool-call fences are scanned too.
#                 Output: `FAIL <file>:<line> fence-state ...` then `SPEC-FENCE-STATE: ...`.
#   --base <ref>   Only check blocks that contain a line changed relative to <ref>
#                  (`git diff -U0 <ref> -- <file>`), so pre-existing blocks never fail
#                  a new change. Without --base every block is checked.
#   --shellcheck   Also run `shellcheck -S error -s bash` when installed. Advisory: its hits are
#                  reported as WARN and never fail the run (spec blocks are often fragments).
#
# Spec notation that is not bash is neutralised before parsing:
#   {PLACEHOLDER} / {FORGE_SKILL_PREFIX}x  → a plain word
#   blocks containing pseudo tool calls (Skill( / Agent( / Task( / Read( ) → SKIPPED
#   a block whose preceding non-blank line is exactly `<!-- allowlist:check-spec-bash -->` → SKIPPED
#   (for intentional fragments, e.g. an `if` opened in one block and closed in the next)
#
# Output: one line per checked block, `OK|FAIL|WARN|SKIP <file>:<start-line> <reason>`,
# then `SPEC-BASH: checked=N failed=F skipped=S shellcheck_warnings=W`. Only bash -n fails a run.
# Exit codes: 0 no failures, 1 at least one block failed, 2 usage error.
#
# Portable: bash 3.2, BSD/GNU awk and sed. Requires git only with --base.

set -u

BASE=""; SHELLCHECK=0; POSITIONAL=0; FILES=""; FENCESTATE=0; FSVARS=""
usage() { echo "ERROR: Usage: check-spec-bash.sh [--base <git-ref>] [--shellcheck] <file.md>... | --positional [<file.md>...] | --fence-state <VAR>... -- <file.md>..." >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) [ "$#" -ge 2 ] || usage; BASE="$2"; shift 2 ;;
    --shellcheck) SHELLCHECK=1; shift ;;
    --positional) POSITIONAL=1; shift ;;
    --fence-state)
      FENCESTATE=1; shift
      while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
        case "$1" in -*|*[!A-Za-z0-9_]*) usage ;; esac
        FSVARS="$FSVARS $1"; shift
      done
      [ "$#" -gt 0 ] && [ -n "$FSVARS" ] || usage
      shift ;;
    --*) usage ;;
    *) FILES="$FILES
$1"; shift ;;
  esac
done

# No file arguments: default to the --positional check over every Skill-loaded spec under commands/
# (orchestrate/**, pipeline-health/** and the review-pr-agents catalog are Read-loaded, not substituted).
# Resolved relative to this script, so it works from any cwd and from linked worktrees.
if [ -z "$FILES" ] && [ "$FENCESTATE" = 0 ] && { [ "$#" -eq 0 ] && [ "$POSITIONAL" = 0 ] && [ -z "$BASE" ] && [ "$SHELLCHECK" = 0 ] || [ "$POSITIONAL" = 1 ]; }; then
  POSITIONAL=1
  cd "$(dirname "$0")/.." || exit 2
  FILES=$(find commands -name '*.md' -not -path 'commands/orchestrate/*' \
    -not -path 'commands/pipeline-health/*' -not -path 'commands/review-pr-agents/*' | LC_ALL=C sort)
fi
[ -n "$FILES" ] || usage

if [ "$FENCESTATE" = 1 ]; then
  sfail=0; sfiles=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in *.md) ;; *) continue ;; esac
    [ -f "$f" ] || { echo "SKIP $f missing"; continue; }
    sfiles=$((sfiles + 1))
    hits=$(awk -v f="$f" -v vars="$FSVARS" '
      function flush(   i, v, ln) {
        for (i = 1; i <= nv; i++) {
          v = vn[i]
          if (first[v] != "" && !asg[v]) print "FAIL " f ":" first[v] " fence-state: $" v " read in a fence before it is assigned (fresh shell per Bash call): " firsttxt[v]
        }
      }
      function reset(   i) { for (i = 1; i <= nv; i++) { asg[vn[i]] = 0; first[vn[i]] = ""; firsttxt[vn[i]] = "" } }
      BEGIN { nv = split(vars, vn, " ") }
      !inb && /^[ \t]*```(bash|sh)[ \t]*$/ { inb = 1; reset(); next }
      !inb && /^[ \t]*```/ { other = !other; next }
      other { next }
      inb && /^[ \t]*```[ \t]*$/ { flush(); inb = 0; next }
      inb {
        if ($0 ~ /^[ \t]*#/) next
        for (i = 1; i <= nv; i++) {
          v = vn[i]
          if (first[v] == "" && ($0 ~ ("(^|[;&|( \t])(export[ \t]+|local[ \t]+|declare[ \t]+(-[A-Za-z]+[ \t]+)?|readonly[ \t]+)?" v "=") ||
              $0 ~ ("(^|[;&|( \t])read[ \t]+(-[A-Za-z]+[ \t]+)*([A-Za-z0-9_]+[ \t]+)*" v "([ \t;]|$)") ||
              $0 ~ ("(^|[;&|( \t])for[ \t]+" v "[ \t]+in[ \t]"))) asg[v] = 1
          if (first[v] == "" && $0 !~ /allowlist:fence-state/ &&
              ($0 ~ ("\\$" v "([^A-Za-z0-9_]|$)") || $0 ~ ("\\$\\{" v "([^A-Za-z0-9_]|$)"))) { first[v] = NR; firsttxt[v] = $0 }
        }
      }
    ' "$f")
    if [ -n "$hits" ]; then printf '%s\n' "$hits"; sfail=$((sfail + $(printf '%s\n' "$hits" | wc -l))); fi
  done <<EOS
$FILES
EOS
  echo "SPEC-FENCE-STATE: files=$sfiles violations=$sfail"
  [ "$sfail" -eq 0 ]
  exit $?
fi

if [ "$POSITIONAL" = 1 ]; then
  pfail=0; pfiles=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in *.md) ;; *) continue ;; esac
    [ -f "$f" ] || { echo "SKIP $f missing"; continue; }
    pfiles=$((pfiles + 1))
    hits=$(awk -v f="$f" '
      /^[ \t]*```/ { inb = !inb; next }
      inb && /\$[0-9]([^0-9]|$)/ && !/allowlist:positional-arg/ { print "FAIL " f ":" NR " positional arg ($0-$9) in fenced block: " $0 }
    ' "$f")
    if [ -n "$hits" ]; then printf '%s\n' "$hits"; pfail=$((pfail + $(printf '%s\n' "$hits" | wc -l))); fi
  done <<EOP
$FILES
EOP
  echo "SPEC-POSITIONAL: files=$pfiles violations=$pfail"
  [ "$pfail" -eq 0 ]
  exit $?
fi

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/check-spec-bash.XXXXXX") || exit 2
trap 'rm -rf "$TMPD"' EXIT

checked=0; failed=0; skipped=0; warned=0

changed_lines() { # changed_lines <file> → one new-side line number per line
  git diff -U0 "$BASE" -- "$1" 2>/dev/null | awk '
    /^@@/ { split($3, a, ","); s = substr(a[1], 2) + 0; n = (a[2] == "") ? 1 : a[2] + 0
            for (i = 0; i < n; i++) print s + i }'
}

while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in *.md) ;; *) continue ;; esac
  [ -f "$f" ] || { echo "SKIP $f missing"; continue; }

  CH="$TMPD/changed"; : > "$CH"
  if [ -n "$BASE" ]; then
    changed_lines "$f" > "$CH"
    [ -s "$CH" ] || continue
  fi

  # Split the file into one file per ```bash block, named by its opening line number.
  rm -f "$TMPD"/blk.*
  awk -v d="$TMPD" '
    !inb && /^[ \t]*```(bash|sh)[ \t]*$/ { inb = 1; start = NR; out = d "/blk." NR; printf "" > out
                                            if (prev ~ /^[ \t]*<!--[ \t]*allowlist:check-spec-bash[ \t]*-->[ \t]*$/) print "#ALLOWLISTED" > out
                                            next }
    inb && /^[ \t]*```[ \t]*$/ { inb = 0; close(out); print start "\t" NR > (d "/ranges"); next }
    inb { print > out; next }
    { if ($0 !~ /^[ \t]*$/) prev = $0 }
  ' "$f"
  [ -f "$TMPD/ranges" ] || continue

  while IFS="$(printf '\t')" read -r start end; do
    blk="$TMPD/blk.$start"
    if [ -n "$BASE" ]; then
      hit=$(awk -v s="$start" -v e="$end" '$1 >= s && $1 <= e { print "y"; exit }' "$CH")
      [ "$hit" = "y" ] || continue
    fi
    if head -1 "$blk" | grep -q '^#ALLOWLISTED$'; then
      skipped=$((skipped + 1)); echo "SKIP $f:$start allowlisted fragment"; continue
    fi
    if grep -Eq '(^|[^A-Za-z_])(Skill|Agent|Task|Read)\(' "$blk"; then
      skipped=$((skipped + 1)); echo "SKIP $f:$start pseudo tool call"; continue
    fi
    # Neutralise {PLACEHOLDER} notation (and {FORGE_SKILL_PREFIX}name) into a variable expansion,
    # so tests like [ -z "{X}" ] are not misread as constant strings.
    sed -E 's/\{[A-Z][A-Z0-9_]*\}/${PH}/g' "$blk" > "$blk.sh"
    checked=$((checked + 1))
    if ! err=$(bash -n "$blk.sh" 2>&1); then
      failed=$((failed + 1))
      echo "FAIL $f:$start bash -n: $(printf '%s' "$err" | head -1 | sed "s|$blk.sh|block|")"
      continue
    fi
    if [ "$SHELLCHECK" = 1 ] && command -v shellcheck >/dev/null 2>&1; then
      if ! err=$(shellcheck -S error -s bash "$blk.sh" 2>&1); then
        warned=$((warned + 1))
        echo "WARN $f:$start shellcheck: $(printf '%s' "$err" | grep -m1 -E 'SC[0-9]+' || printf '%s' "$err" | head -1)"
        continue
      fi
    fi
    echo "OK $f:$start"
  done < "$TMPD/ranges"
  rm -f "$TMPD/ranges"
done <<EOF
$FILES
EOF

echo "SPEC-BASH: checked=$checked failed=$failed skipped=$skipped shellcheck_warnings=$warned"
[ "$failed" -eq 0 ]
