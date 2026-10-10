#!/usr/bin/env bash
# review-pr-staging-scope.test.sh — cases for the review-pr-staging scoped-review gates (forge#3451):
#   (1) the 7B out-of-scope rule may only demote MEDIUM/LOW/INFO, never HIGH/CRITICAL or unknown severity;
#   (2) the 0B.1 "reviewed" test needs the full-length Reviewed-SHA line, not a 7-char substring.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT/commands/review-pr-staging.md"
TC="$ROOT/scripts/trusted-comments.sh"
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
command -v jq >/dev/null 2>&1 || { echo "review-pr-staging-scope.test.sh: jq missing, skipped"; exit 0; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# (1) severity rule: the two SCOPE_RULE lines, marker stripped
grep -E '# SCOPE_RULE$' "$SPEC" | sed 's/[[:space:]]*# SCOPE_RULE$//; s/^[[:space:]]*//' > "$TMP/rule.sh"
if [ "$(wc -l < "$TMP/rule.sh")" -eq 2 ]; then ok; else bad "SCOPE_RULE lines not found (expected 2)"; fi
demote() { FINDING_SEVERITY="$1"; OOS_DEMOTE=; eval "$(cat "$TMP/rule.sh")"; echo "$OOS_DEMOTE"; }
chk() { [ "$(demote "$1")" = "$2" ] && ok || bad "severity '$1' expected demote=$2"; }
chk HIGH 0; chk high 0; chk " High " 0; chk CRITICAL 0; chk critical 0
chk MEDIUM 1; chk medium 1; chk LOW 1; chk INFO 1
chk "" 0; chk "SEVERE" 0; chk "HIGH/MEDIUM" 0

# (2) full-sha reviewed test: the _AGENT regex from the spec, run through the real trusted-comments predicate
LINE=$(grep -E '^[[:space:]]*_AGENT=' "$SPEC" | head -1)
RE=$(printf '%s' "$LINE" | sed -n 's/.*count "\(.*\)") ||.*/\1/p')
if [ -n "$RE" ]; then ok; else bad "_AGENT regex not found in review-pr-staging.md"; fi
FULL=0123456789abcdef0123456789abcdef01234567; SHORT=${FULL:0:7}
RE=${RE//\\\\/\\}; RE=${RE//\$\{_HEAD\}/$FULL}
FB=$'<!-- REVIEW-FINDINGS-START -->\nNo findings.\n<!-- REVIEW-FINDINGS-END -->'
mk() { jq -n --arg b "$1" --arg t "$2" '[{"body":$b,"author_association":"NONE","user":{"type":$t,"login":"x"}}]'; }
cnt() { bash "$TC" count "$RE"; }
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: '"$FULL"$'\n\n'"$FB" Bot | cnt)" = 1 ] && ok || bad "full Reviewed-SHA line should count"
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nreviewed '"$SHORT"' only' Bot | cnt)" = 0 ] && ok || bad "7-char substring must not count"
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: '"$SHORT"$'\n' Bot | cnt)" = 0 ] && ok || bad "short Reviewed-SHA must not count"
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: '"${FULL}"$'ff\n'"$FB" Bot | cnt)" = 0 ] && ok || bad "longer sha must not count"
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: '"$FULL"$'\n'"$FB" User | cnt)" = 0 ] && ok || bad "untrusted author must not count"
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: '"$FULL"$'\n\nno findings block here' Bot | cnt)" = 0 ] && ok || bad "comment without a findings block must not count (panel integrity)"

# (3) _ROUTE regex: real mode on the final head counts, spec-evolution-blocked and a stale sha do not
RLINE=$(grep -E '^[[:space:]]*_ROUTE=' "$SPEC" | head -1)
RRE=$(printf '%s' "$RLINE" | sed -n 's/.*count "\(.*\)") ||.*/\1/p'); RRE=${RRE//\\\\/\\}; RRE=${RRE//\$\{_HEAD7\}/$SHORT}
rcnt() { bash "$TC" count "$RRE"; }
[ "$(mk '<!-- FORGE:REVIEW_ROUTE mode=single-pr spec=review-pr.md sha='"$SHORT"' -->' Bot | rcnt)" = 1 ] && ok || bad "route marker on the final head should count"
[ "$(mk '<!-- FORGE:REVIEW_ROUTE mode=spec-evolution-blocked spec=review-pr.md sha='"$SHORT"' -->' Bot | rcnt)" = 0 ] && ok || bad "spec-evolution-blocked route must not count"
[ "$(mk '<!-- FORGE:REVIEW_ROUTE mode=single-pr spec=review-pr.md sha=abcdef0 -->' Bot | rcnt)" = 0 ] && ok || bad "stale-sha route must not count"

# (4) spec text guards: agents may not be told to suppress findings; no $PWD tier in the classifier resolver; git reads are status-checked
if grep -q 'MUST NOT report a defect' "$SPEC"; then bad "Phase 2 must not tell agents to suppress findings (7B owns demotion)"; else ok; fi
if grep -n 'FINDING_TEXT_FILE=$(mktemp' "$SPEC" >/dev/null && grep -q '> "$FINDING_TEXT_FILE"' "$SPEC"; then ok; else bad "FINDING_TEXT_FILE must be written before the classifier call"; fi
if awk '/^CLASSIFY_SCRIPT=""/,/^done <<</' "$SPEC" | grep -q 'PWD'; then bad "classifier resolver must have no PWD tier"; else ok; fi
if grep -qE "^DEPLOY_WIRING_FILES=.*git diff" "$SPEC"; then bad "DEPLOY_WIRING_FILES must not pipe git diff directly"; else ok; fi
if grep -q 'git diff-tree .*|| { SCOPE_MODE=full' "$SPEC"; then ok; else bad "git diff-tree reads must fall back to full scope"; fi
if grep -q 'classify_one()' "$SPEC" && grep -q 'REVIEWED_MERGES' "$SPEC" && grep -q '_scope.env' "$SPEC"; then ok; else bad "7B.5 must be a per-finding function with persisted scope state"; fi
if grep -q 'DUPLICATE: #' "$SPEC" && grep -q 'grep -qF -- "$_SAFE_FILE"' "$SPEC"; then ok; else bad "7E exit 1 must be confirmed by file before skipping"; fi
# (5) run the spec's classify_one with a stub classifier: HIGH out of scope stays ISSUE; LOW out of scope is demoted and listed; multi-file in-scope is not demoted
awk '/^classify_one\(\) \{/,/^\}/' "$SPEC" > "$TMP/fn.sh"
printf '#!/bin/sh\necho "$STUB_DISP"\n' > "$TMP/classify.sh"
run1() { # severity stub-disposition paths -> prints DISPOSITION
  ( _SD="$TMP"; PR_NUMBER=9; CLASSIFY_SCRIPT="$TMP/classify.sh"; SCOPE_MODE=scoped; CROSS_PR_FILES="a/in.sh"; UNREVIEWED_FILES=""; DEPLOY_WIRING_FILES=""
    NOTE_LIST_FILE="$TMP/n.md"; : > "$NOTE_LIST_FILE"; NOTES_LISTED=0; FINDINGS_FILED=0; OUT_OF_SCOPE=0
    FINDING_ID=X1; FINDING_SEVERITY="$1"; FINDING_CONFIDENCE=CONFIRMED; FINDING_AGENT=Security; FINDING_TITLE=t; FINDING_BODY=b; FINDING_FILE=z/out.sh; FINDING_PATHS="$3"
    export STUB_DISP="$2"; . "$TMP/fn.sh"; classify_one; echo "$DISPOSITION" ) 2>&1 | tail -1; }
[ "$(run1 HIGH 'ISSUE severity-HIGH' 'z/out.sh')" = "ISSUE severity-HIGH" ] && ok || bad "HIGH out of scope must stay ISSUE"
[ "$(run1 high 'ISSUE severity-HIGH' 'z/out.sh')" = "ISSUE severity-HIGH" ] && ok || bad "lowercase high out of scope must stay ISSUE"
[ "$(run1 LOW 'NOTE LOW-LIKELY' 'z/out.sh')" = "NOTE out_of_scope" ] && ok || bad "LOW out of scope should be demoted and listed"
[ "$(run1 MEDIUM 'ISSUE MEDIUM-CONFIRMED' 'z/out.sh')" = "NOTE out_of_scope" ] && ok || bad "MEDIUM out of scope should be demoted"
[ "$(run1 MEDIUM 'ISSUE MEDIUM-CONFIRMED' $'z/out.sh\na/in.sh')" = "ISSUE MEDIUM-CONFIRMED" ] && ok || bad "multi-file finding with an in-scope file must not be demoted"
[ "$(run1 LOW 'ISSUE safety-exemption-auth' 'z/out.sh')" = "ISSUE safety-exemption-auth" ] && ok || bad "safety-exempt finding must not be demoted"
echo "review-pr-staging-scope.test.sh: passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
