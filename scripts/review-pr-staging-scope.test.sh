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
grep -E '^# SCOPE_RULE: ' "$SPEC" | sed 's/^# SCOPE_RULE: //; s/[[:space:]]*#.*$//' > "$TMP/rule.sh"
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
echo "review-pr-staging-scope.test.sh: passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
