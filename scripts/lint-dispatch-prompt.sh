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
#   3. Outside the context block, no verdict/fix-prescribing or resume-shortcut language
#      (the Issue title text is scanned too), and every line before the title must
#      match a line of the real Step 4A template (allowlist, placeholder-tolerant).
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
    # Per-placeholder value charsets (forge#3078): a {PLACEHOLDER} is NOT free text.
    # Only ISSUE_TITLE is free (it is scanned for directive language separately).
    BEGIN {
      np2 = split("do not dont just close ignore prior previous instructions instruction investigate this that issue the and then fix skip please instead only without verify resolve resolved already fixed stop merge delete remove", _pw, " ")
      for (pi = 1; pi <= np2; pi++) PROSE_WORDS[_pw[pi]] = 1
    }
    function ok_val(name, v) {
      if (name == "ISSUE_TITLE") return 1
      # The literal shell-style token {AGENT_TOKEN} is template prose, not free text.
      if (v == "{AGENT_TOKEN}") return 1
      # PROJECT_NAME is a free-form label (may contain spaces); still no sentence punctuation, at most 3 words, 40 chars (forge#3089).
      if (name == "PROJECT_NAME") return (length(v) > 0 && length(v) <= 40 && split(v, _w, " ") <= 3 && v ~ /^[A-Za-z0-9._ ()+-]+$/)
      if (name == "GH_REPO") return v ~ /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
      if (name == "FORGE_GIST_CAPABLE") return (v == "true" || v == "false")
      # REPO_PATH: validated structurally, not by charset (forge#3085). Must look like an
      # absolute path (/..., ~..., X:\... or X:/..., \\server\...); spaces, +, parentheses and
      # non-ASCII are legitimate path characters; shell metacharacters, quotes, sentence
      # punctuation and control chars are not.
      if (name == "REPO_PATH") {
        if (length(v) == 0 || length(v) > 260) return 0
        if (v !~ /^(\/|~|[A-Za-z]:[\\\/]|\\\\)/) return 0
        if (v ~ /[`$;|&<>"'"'"'!?,*{}\[\]]/ || v ~ /[[:cntrl:]]/) return 0
        if (v ~ /  / || v ~ /(^|[\/\\]) /) return 0
        # Prose guard (forge#3089): a real path with spaces has few of them, and nearly every
        # space-separated token carries a path separator. Allow at most 2 spaces and at most
        # one separator-less token after the first, so "/x then do not investigate ..." fails.
        nsp = gsub(/ /, " ", v)
        if (nsp > 2) return 0
        nt = split(v, _t, " "); bare = 0
        for (ti = 2; ti <= nt; ti++) if (_t[ti] !~ /[\/\\]/) bare++
        if (bare > 1) return 0
        # Slash-joined prose (forge#3091): "/x do/not/investigate" has one space and every token
        # carries a separator, so also split on / \ and space and reject directive/stopword tokens.
        nw = split(tolower(v), _w2, /[\/\\ ]+/)
        for (ti = 1; ti <= nw; ti++) if (_w2[ti] in PROSE_WORDS) return 0
        return 1
      }
      # Numbers: digits, optionally preceded by a satellite prefix when two placeholders are adjacent.
      if (name == "NUMBER") return v ~ /^([A-Za-z0-9._-]+:)?[0-9]+$/
      # Prefixes are single tokens (no "/"): SATELLITE_PREFIX is followed by ":" in the template;
      # PROJECT_PREFIX / FORGE_SKILL_PREFIX carry their own trailing ":" (or are empty).
      if (name == "SATELLITE_PREFIX") return v ~ /^[A-Za-z0-9._-]+$/
      if (name == "PROJECT_PREFIX" || name == "FORGE_SKILL_PREFIX") return v ~ /^([A-Za-z0-9._-]+:)?$/
      # Branch names: no leading "/" or "-", no empty segments or "..", so a file-path-shaped
      # directive such as /ignore/the/issue/fix.patch cannot ride in a branch slot.
      if (name == "STAGING_BRANCH" || name == "SOURCE_BRANCH" || name == "PR_BASE") {
        if (length(v) == 0 || length(v) > 100) return 0
        if (v !~ /^[A-Za-z0-9._][-A-Za-z0-9._\/]*$/) return 0
        if (v ~ /\/\// || v ~ /\.\./ || v ~ /\/$/) return 0
        return 1
      }
      # Remaining slots (LANE, SUBAGENT_MODEL, ...) are single tokens: no "/" , no spaces.
      return v ~ /^[-A-Za-z0-9._]*$/
    }
    function matches(line, pat,   rest, lit, name, nl, idx, val) {
      rest = line
      while (1) {
        if (!match(pat, /\{[A-Z_]+\}/)) return rest == pat
        lit = substr(pat, 1, RSTART - 1); name = substr(pat, RSTART + 1, RLENGTH - 2)
        pat = substr(pat, RSTART + RLENGTH)
        if (substr(rest, 1, length(lit)) != lit) return 0
        rest = substr(rest, length(lit) + 1)
        if (match(pat, /\{[A-Z_]+\}/)) nl = substr(pat, 1, RSTART - 1); else nl = pat
        if (pat == "") { val = rest; rest = "" }
        else if (nl == "") { val = "" }   # adjacent placeholders: the later one absorbs the value
        else if (nl == pat) {
          if (length(rest) < length(nl) || substr(rest, length(rest) - length(nl) + 1) != nl) return 0
          val = substr(rest, 1, length(rest) - length(nl)); rest = nl
        } else {
          idx = index(rest, nl); if (idx == 0) return 0
          val = substr(rest, 1, idx - 1); rest = substr(rest, idx)
        }
        if (!ok_val(name, val)) return 0
      }
    }
    FNR == NR { if ($0 !~ /^[ \t]*(\{[A-Z_]+\}[ \t]*)+$/ && $0 != "") pats[++np] = $0; next }
    $0 ~ /^[ \t]*$/ { next }
    { ok = 0; for (i = 1; i <= np; i++) if (matches($0, pats[i])) { ok = 1; break }
      if (!ok) { print substr($0, 1, 120); c++ } if (c >= 5) exit }
  ' <(printf '%s\n' "$TPL") <(printf '%s\n' "$HEAD_PART"))
  [ -z "$UNMATCHED" ] || while IFS= read -r l; do fail "line does not match the Step 4A template: ${l}"; done <<< "$UNMATCHED"
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
