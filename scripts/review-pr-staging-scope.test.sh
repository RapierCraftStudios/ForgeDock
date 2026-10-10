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
mk() { jq -n --arg b "$1" --arg t "$2" '[{"body":$b,"author_association":"NONE","user":{"type":$t,"login":"x"}}]'; }
cnt() { bash "$TC" count "$RE"; }
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: '"$FULL"$'\n\nok' Bot | cnt)" = 1 ] && ok || bad "full Reviewed-SHA line should count"
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nreviewed '"$SHORT"' only' Bot | cnt)" = 0 ] && ok || bad "7-char substring must not count"
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: '"$SHORT"$'\n' Bot | cnt)" = 0 ] && ok || bad "short Reviewed-SHA must not count"
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: '"${FULL}"$'ff\n' Bot | cnt)" = 0 ] && ok || bad "longer sha must not count"
[ "$(mk $'<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: '"$FULL"$'\n' User | cnt)" = 0 ] && ok || bad "untrusted author must not count"
echo "review-pr-staging-scope.test.sh: passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
