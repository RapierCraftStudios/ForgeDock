#!/usr/bin/env bash
# review-pr-staging-finding-filter.test.sh — fixtures for the anchored open-finding filter (forge#3800).
# The spec's `# FINDING_PR_FILTER` line is extracted and run against issue shapes: the gate must keep a
# hit only when its title suffix or `**Source**:` line names exactly PR #N; hidden markers never count.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
command -v jq >/dev/null 2>&1 || { echo "review-pr-staging-finding-filter.test.sh: jq missing, skipped"; exit 0; }

extract() { grep -E '# FINDING_PR_FILTER$' "$1" | sed 's/[[:space:]]*# FINDING_PR_FILTER$//; s/^[[:space:]]*//'; }
SPEC="$ROOT/commands/review-pr-staging.md"
DEF="$(extract "$SPEC" | sort -u)"
[ "$(printf '%s\n' "$DEF" | grep -c .)" -eq 1 ] && ok || bad "review-pr-staging.md must carry one identical FINDING_PR_FILTER definition"
[ "$(extract "$ROOT/commands/deploy-info.md" | sort -u)" = "$DEF" ] && ok || bad "deploy-info.md filter differs from review-pr-staging.md"
[ "$(grep -c -F 'FINDING_PR_FILTER' "$SPEC")" -ge 3 ] && ok || bad "filter must be referenced by all three queries"
grep -q -F 'OVERRIDE: shipping with open findings' "$SPEC" && ok || bad "OVERRIDE text missing"
eval "$DEF"

run() { printf '%s' "$1" | jq -r --arg n "$2" "$FINDING_PR_FILTER"; }
J() { jq -n --arg t "$1" --arg b "$2" --argjson n "${3:-1}" '[{number:$n,title:$t,body:$b}]'; }

# #3605 shape: number only inside a hidden issue-create-token
OUT=$(run "$(J 'Some finding (review finding — PR #3593)' $'**Source**: PR #3593 — x\n\n<!-- issue-create-token:forge-create-20261010T165826Z-1996537-3776 -->' 3605)" 3776)
[ -z "$OUT" ] && ok || bad "issue-create-token ending in 3776 must not match"
# bare mention in prose
OUT=$(run "$(J 'Unrelated' 'see PR #3776 for context')" 3776); [ -z "$OUT" ] && ok || bad "prose mention must not match"
# longer number
OUT=$(run "$(J 'F (review finding — PR #37761)' $'**Source**: PR #37761 — x')" 3776); [ -z "$OUT" ] && ok || bad "PR #37761 must not match PR #3776"
OUT=$(run "$(J 'F (review finding — PR #3776)' 'b')" 37761); [ -z "$OUT" ] && ok || bad "PR #3776 must not match PR #37761"
# real findings still kept
OUT=$(run "$(J 'Bad thing (review finding — PR #3776)' 'no source line' 42)" 3776)
[ "$OUT" = "  - #42: Bad thing (review finding — PR #3776)" ] && ok || bad "title-suffix finding must be kept in the '  - #N: title' format (got: $OUT)"
OUT=$(run "$(J 'Bad thing' $'intro\n**Source**: PR #3776 — Some title\nmore' 43)" 3776)
[ "$OUT" = "  - #43: Bad thing" ] && ok || bad "Source-line finding must be kept"
OUT=$(run "$(J 'Bad thing' '**Source**: PR #3776' 44)" 3776); [ -n "$OUT" ] && ok || bad "Source line at end of body must be kept"
OUT=$(run "$(J 'Bad thing' null 45)" 3776); [ -z "$OUT" ] && ok || bad "body text 'null' must not match"
OUT=$(run '[{"number":1,"title":"x (review finding — PR #3776)","body":null}]' 3776); [ -n "$OUT" ] && ok || bad "null body must not break title match"

echo "review-pr-staging-finding-filter.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
