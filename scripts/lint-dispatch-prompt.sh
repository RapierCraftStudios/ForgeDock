#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# lint-dispatch-prompt.sh — Best-effort enforcement of /orchestrate Hard Rule 1
# ("copy the Phase 4A template verbatim; no custom prompts").
#
# NOTE: this is a best-effort, self-run guard, not a tamper-proof gate: no hook gates
# Agent(...), so the orchestrator must run it. Free-text slots (issue title, DISPATCH_CONTEXT)
# are phrase-scanned only and can be bypassed by rephrasing.
#
# Lints a RENDERED dispatch prompt (the text handed to Agent(prompt=...)) so an
# orchestrator cannot pre-solve an issue or pre-decide its verdict in a custom brief.
#
# Usage:
#   lint-dispatch-prompt.sh [--expect KEY=VALUE]... <prompt-file>   (or "-" / no file to read stdin)
#
#   Every placeholder the orchestrator resolves itself (PROJECT_NAME, GH_REPO, REPO_PATH, LANE,
#   PR_BASE, STAGING_BRANCH, SOURCE_BRANCH, NUMBER, FORGE_GIST_CAPABLE, SUBAGENT_MODEL,
#   PROJECT_PREFIX, SATELLITE_PREFIX, FORGE_SKILL_PREFIX) must EXACTLY equal the value passed via
#   --expect KEY=VALUE (repeatable; split on the first "="; an empty VALUE is legal). The value
#   is never eval'd or re-interpreted, so spaces, parentheses, backslashes and non-ASCII are safe
#   (pass it as one quoted argument). A resolvable slot present in the prompt with NO --expect is
#   refused (fail closed); there is no charset/stopword fallback. Free-text slots (the issue
#   title, the DISPATCH_CONTEXT block) cannot be pre-resolved and keep the directive-phrase scan.
#
# Structure expected (see commands/orchestrate/phase-4-execution.md Step 4A):
#   <fixed 4A template text>
#   **Issue title**: ...
#   <!-- DISPATCH_CONTEXT:BEGIN -->   (allowed variable blocks only:
#   ...                                       GIST_CONTEXT, SOURCE_PR_HINT_CONTEXT,
#   <!-- DISPATCH_CONTEXT:END -->       claims board, same-file "what changed")
#   (nothing else)
#
# Checks:
#   1. Required template anchors are present (mission, loop contract, Skill invocation).
#   2. Nothing but the context block follows the "**Issue title**" line.
#   3. Outside the context block, no verdict/fix-prescribing or resume-shortcut language
#      (the Issue title text is scanned too), and every line before the title must
#      match a line of the real Step 4A template (allowlist); resolvable placeholders must
#      equal their --expect value byte for byte.
#   4. Inside the context block, the strongest directive phrases are rejected
#      (context may legitimately quote investigations, so the list is narrower).
#
# Output: LINT: PASS | LINT: FAIL, then one "VIOLATION: <reason>" line per problem.
# Exit codes: 0 pass, 1 violations, 2 unreadable input.

set -uo pipefail

# Expected values for orchestrator-resolved placeholders: one "KEY=VALUE" line per --expect in a
# temp file that awk reads byte-exact (no shell/awk escape processing of the value).
EXPECT_FILE="$(mktemp)"; trap 'rm -f "$EXPECT_FILE"' EXIT
NL='
'
SRC="-"; SRC_SET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --expect)
      if [ $# -lt 2 ] || [[ "$2" != [A-Z_]*=* ]]; then
        echo "LINT: ERROR"; echo "VIOLATION: --expect needs KEY=VALUE (KEY is UPPER_CASE)"; exit 2
      fi
      case "$2" in *"$NL"*) echo "LINT: ERROR"; echo "VIOLATION: --expect value must not contain a newline"; exit 2;; esac
      printf '%s\n' "$2" >> "$EXPECT_FILE"; shift 2 ;;
    --expect=*)
      echo "LINT: ERROR"; echo "VIOLATION: use '--expect KEY=VALUE' (separate arguments)"; exit 2 ;;
    *) if [ "$SRC_SET" -eq 1 ]; then echo "LINT: ERROR"; echo "VIOLATION: unexpected argument: $1"; exit 2; fi
       SRC="$1"; SRC_SET=1; shift ;;
  esac
done
if [ "$SRC" = "-" ]; then
  PROMPT="$(cat)"
elif [ -r "$SRC" ]; then
  PROMPT="$(cat "$SRC")"
else
  echo "LINT: ERROR"; echo "VIOLATION: cannot read prompt file: $SRC"; exit 2
fi
# Normalize CRLF -> LF so Windows-authored prompts are compared on content (forge#3078).
# Strip only a TRAILING CR per line: a mid-line CR is content and must not be silently
# erased (it could hide text from the line-oriented checks). printf-built CR keeps this
# portable to BSD sed, which does not interpret \r (forge#3085).
CR="$(printf '\r')"
PROMPT="$(printf '%s' "$PROMPT" | sed "s/${CR}\$//")"
[ -n "$PROMPT" ] || { echo "LINT: ERROR"; echo "VIOLATION: empty prompt"; exit 2; }

BEGIN='<!-- DISPATCH_CONTEXT:BEGIN -->'
END='<!-- DISPATCH_CONTEXT:END -->'
FAILS=()
fail() { FAILS+=("$1"); }

# Phrases that pre-decide a verdict or fix, or turn a relaunch into "finish the leftovers".
STRONG='(likely|probably|possibly) (already )?(resolved|fixed|moot|invalid|a duplicate)|already (resolved|fixed|implemented)[ ,.]*(—|-|,)? *(verify|close)|verify (it|this)?[ ,]*and close|\b(proposed|suggested|recommended|prescribed) (fix|solution)\b|make (the|this|that) [a-z_ -]{1,60}(terminal|return early|raise)|implement the following|(continue|resume|pick up) (from )?where (you|the previous (agent|run)) left off|finish (what|the work|the uncommitted)|uncommitted (work|changes) (from|left)|the (fix|solution) (is|was)([ ,]+(simply|just))?([ ,]+to\b|[ ,]*:)'
# Outside the context block additionally reject generic fix-design language.
WIDE="$STRONG|the (fix|root cause|diagnosis|solution) is\\b|\\broot cause( is|:)|\\bdiagnosis:|(just|simply) (read and edit|edit the file)"

# --- 1. anchors -------------------------------------------------------------
for anchor in '**YOUR MISSION**' 'LABEL-STATE LOOP CONTRACT' 'Skill(skill=' '--under-orchestration' '**LANE**' '**Issue title**:'; do
  grep -qF -- "$anchor" <<< "$PROMPT" || fail "missing required template anchor: $anchor"
done

# --- 2. structure after the Issue title line ---------------------------------
TITLE_LN=$(grep -nF -- '**Issue title**:' <<< "$PROMPT" | head -1 | cut -d: -f1)
if [ -n "$TITLE_LN" ]; then
  HEAD_PART=$(printf '%s\n' "$PROMPT" | sed -n "1,${TITLE_LN}p")
  TAIL_PART=$(printf '%s\n' "$PROMPT" | sed -n "$((TITLE_LN+1)),\$p")
else
  HEAD_PART="$PROMPT"; TAIL_PART=""
fi

FIRST_NONBLANK=$(grep -v '^[[:space:]]*$' <<< "$TAIL_PART" | head -1)
CTX=""; AFTER=""
if grep -qF -- "$BEGIN" <<< "$TAIL_PART"; then
  if [ "$FIRST_NONBLANK" != "$BEGIN" ]; then
    fail "content between '**Issue title**' and the DISPATCH_CONTEXT block is not allowed"
  fi
  if grep -qF -- "$END" <<< "$TAIL_PART"; then
    CTX=$(printf '%s\n' "$TAIL_PART" | sed -n "/$(printf '%s' "$BEGIN" | sed 's/[][\/.*^$]/\\&/g')/,/$(printf '%s' "$END" | sed 's/[][\/.*^$]/\\&/g')/p")
    AFTER=$(printf '%s\n' "$TAIL_PART" | sed -n "/$(printf '%s' "$END" | sed 's/[][\/.*^$]/\\&/g')/,\$p" | tail -n +2)
  else
    fail "DISPATCH_CONTEXT block is not closed"
  fi
else
  # No context block: nothing but whitespace/closing quote may follow the title line.
  AFTER="$TAIL_PART"
fi
AFTER_STRIPPED=$(tr -d '[:space:]' <<< "$AFTER")
if [ -n "$AFTER_STRIPPED" ] && [ "$AFTER_STRIPPED" != '"' ]; then
  fail "unexpected content after the DISPATCH_CONTEXT block (custom prompt text is not allowed)"
fi

# --- 3. forbidden language outside the context block -------------------------
# The title line is NOT exempt: its text is untrusted free text, so the strongest
# directive phrases are scanned in it (forge#3072).
TITLE_TEXT=$(printf '%s\n' "$HEAD_PART" | grep -F -- '**Issue title**:' | head -1)
TITLE_TEXT="${TITLE_TEXT#*\*\*Issue title\*\*:}"
HITS=$(grep -inE -- "$STRONG" <<< "$TITLE_TEXT" | head -5)
[ -z "$HITS" ] || while IFS= read -r l; do fail "directive language in the Issue title line: ${l:0:160}"; done <<< "$HITS"

OUTSIDE=$(printf '%s\n' "$HEAD_PART" | grep -vF -- '**Issue title**:')
OUTSIDE="$OUTSIDE
$AFTER"
HITS=$(grep -inE -- "$WIDE" <<< "$OUTSIDE" | head -5)
[ -z "$HITS" ] || while IFS= read -r l; do fail "verdict/fix-prescribing language outside context block: ${l:0:160}"; done <<< "$HITS"

# --- 3b. allowlist: every head line must match a Step 4A template line --------
# The denylist above is bypassable by rephrasing, so the head is also diffed
# against the real template extracted from the spec (placeholders {UPPER_CASE}
# match any text; pure-placeholder template lines match nothing). Fails closed
# when the spec/template cannot be found. Resolved relative to THIS script.
SPEC_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../commands/orchestrate/phase-4-execution.md"
TPL=""
[ -r "$SPEC_FILE" ] && TPL=$(awk '/Copy this template. Fill in variables/{f=1} f&&/^Agent\($/{g=1} g{print} g&&/^\)$/{exit}' "$SPEC_FILE" \
  | sed -e '/^Agent($/d' -e '/^  subagent_type/d;/^  model=/d;/^  description=/d;/^  run_in_background/d' \
        -e 's/^  prompt="//' -e '/^)$/d' | sed -e '$ { /^"$/ d; }' \
  | sed -e '/DISPATCH_CONTEXT:BEGIN/,$d')
if [ -z "$TPL" ]; then
  fail "cannot extract the Step 4A template from $SPEC_FILE (fail closed)"
else
  UNMATCHED=$(awk '
    # Resolvable placeholders must EXACTLY equal the --expect value (EXP[], read from file 1).
    # No expected value -> fail closed (MISSING[]). Only ISSUE_TITLE is free text (it is scanned
    # for directive language separately); {AGENT_TOKEN} is literal template prose.
    function expected(name) { return (name in EXP) }
    function matches(line, pat,   rest, lit, name, nl, idx, val) {
      rest = line
      while (1) {
        if (!match(pat, /\{[A-Z_]+\}/)) return rest == pat
        lit = substr(pat, 1, RSTART - 1); name = substr(pat, RSTART + 1, RLENGTH - 2)
        pat = substr(pat, RSTART + RLENGTH)
        if (substr(rest, 1, length(lit)) != lit) return 0
        rest = substr(rest, length(lit) + 1)
        if (name == "AGENT_TOKEN") { val = "{AGENT_TOKEN}"; if (substr(rest, 1, length(val)) != val) return 0; rest = substr(rest, length(val) + 1); continue }
        if (name == "ISSUE_TITLE") {
          if (match(pat, /\{[A-Z_]+\}/)) nl = substr(pat, 1, RSTART - 1); else nl = pat
          if (pat == "") { rest = "" }
          else if (nl == "") { }
          else if (nl == pat) {
            if (length(rest) < length(nl) || substr(rest, length(rest) - length(nl) + 1) != nl) return 0
            rest = nl
          } else { idx = index(rest, nl); if (idx == 0) return 0; rest = substr(rest, idx) }
          continue
        }
        if (!expected(name)) { TM[name] = 1; return 0 }
        val = EXP[name]
        if (substr(rest, 1, length(val)) != val) return 0
        rest = substr(rest, length(val) + 1)
      }
    }
    FILENAME == ARGV[1] { i = index($0, "="); if (i > 1) EXP[substr($0, 1, i - 1)] = substr($0, i + 1); next }
    FILENAME == ARGV[2] {
      if ($0 !~ /^[ \t]*(\{[A-Z_]+\}[ \t]*)+$/ && $0 != "") pats[++np] = $0; next }
    $0 ~ /^[ \t]*$/ { next }
    { ok = 0; delete TM; for (i = 1; i <= np; i++) if (matches($0, pats[i])) { ok = 1; break }
      if (!ok) { for (n in TM) MISSING[n] = 1 }
      if (!ok) { print "LINE:" substr($0, 1, 120); c++ } if (c >= 5) exit }
    END { for (n in MISSING) print "MISSING:" n }
  ' "$EXPECT_FILE" <(printf '%s\n' "$TPL") <(printf '%s\n' "$HEAD_PART"))
  while IFS= read -r l; do
    case "$l" in
      LINE:*) fail "line does not match the Step 4A template: ${l#LINE:}" ;;
      MISSING:*) fail "no expected value supplied for resolvable slot {${l#MISSING:}} (pass --expect ${l#MISSING:}=VALUE; fail closed)" ;;
    esac
  done <<< "$UNMATCHED"
fi
# --- 4. strongest directives inside the context block ------------------------
if [ -n "$CTX" ]; then
  HITS=$(grep -inE -- "$STRONG" <<< "$CTX" | head -5)
  [ -z "$HITS" ] || while IFS= read -r l; do fail "pre-solved/directive language inside context block: ${l:0:160}"; done <<< "$HITS"
fi

if [ "${#FAILS[@]}" -eq 0 ]; then
  echo "LINT: PASS"; exit 0
fi
echo "LINT: FAIL"
for f in "${FAILS[@]}"; do echo "VIOLATION: $f"; done
exit 1
