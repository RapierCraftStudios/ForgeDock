#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# lint-dispatch-prompt.sh — Mechanical enforcement of /orchestrate Hard Rule 1
# ("copy the Phase 4A template verbatim; no custom prompts").
#
# Lints a RENDERED dispatch prompt (the text handed to Agent(prompt=...)) so an
# orchestrator cannot pre-solve an issue or pre-decide its verdict in a custom brief.
#
# Usage:
#   lint-dispatch-prompt.sh <prompt-file>      (or "-" / no arg to read stdin)
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
#   3. Outside the context block, no verdict/fix-prescribing or resume-shortcut language.
#   4. Inside the context block, the strongest directive phrases are rejected
#      (context may legitimately quote investigations, so the list is narrower).
#
# Output: LINT: PASS | LINT: FAIL, then one "VIOLATION: <reason>" line per problem.
# Exit codes: 0 pass, 1 violations, 2 unreadable input.

set -uo pipefail

SRC="${1:--}"
if [ "$SRC" = "-" ]; then
  PROMPT="$(cat)"
elif [ -r "$SRC" ]; then
  PROMPT="$(cat "$SRC")"
else
  echo "LINT: ERROR"; echo "VIOLATION: cannot read prompt file: $SRC"; exit 2
fi
[ -n "$PROMPT" ] || { echo "LINT: ERROR"; echo "VIOLATION: empty prompt"; exit 2; }

BEGIN='<!-- DISPATCH_CONTEXT:BEGIN -->'
END='<!-- DISPATCH_CONTEXT:END -->'
FAILS=()
fail() { FAILS+=("$1"); }

# Phrases that pre-decide a verdict or fix, or turn a relaunch into "finish the leftovers".
STRONG='(likely|probably|possibly) (already )?(resolved|fixed|moot|invalid|a duplicate)|already (resolved|fixed|implemented)[ ,.]*(—|-|,)? *(verify|close)|verify (it|this)?[ ,]*and close|\b(proposed|suggested|recommended|prescribed) (fix|solution)\b|make (the|this|that) [a-z_ -]{1,60}(terminal|return early|raise)|implement the following|(continue|resume|pick up) (from )?where (you|the previous (agent|run)) left off|finish (what|the work|the uncommitted)|uncommitted (work|changes) (from|left)'
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
OUTSIDE=$(printf '%s\n' "$HEAD_PART" | grep -vF -- '**Issue title**:')
OUTSIDE="$OUTSIDE
$AFTER"
HITS=$(grep -inE -- "$WIDE" <<< "$OUTSIDE" | head -5)
[ -z "$HITS" ] || while IFS= read -r l; do fail "verdict/fix-prescribing language outside context block: ${l:0:160}"; done <<< "$HITS"

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
