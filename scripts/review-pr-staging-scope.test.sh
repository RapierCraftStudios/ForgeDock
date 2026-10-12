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

# (1) severity rule: the two SCOPE_RULE lines live in scripts/review-finalize.sh (the staging triage runs `review-finalize.sh classify --scope-files`, #3841), marker stripped
grep -E '# SCOPE_RULE$' "$ROOT/scripts/review-finalize.sh" | sed 's/[[:space:]]*# SCOPE_RULE$//; s/^[[:space:]]*//' > "$TMP/rule.sh"
if [ "$(wc -l < "$TMP/rule.sh")" -eq 2 ]; then ok; else bad "SCOPE_RULE lines not found (expected 2)"; fi
demote() { F_SEV="$1"; OOS_DEMOTE=; eval "$(cat "$TMP/rule.sh")"; echo "$OOS_DEMOTE"; }
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
if grep -qE "^DEPLOY_WIRING_FILES=.*git diff" "$SPEC"; then bad "DEPLOY_WIRING_FILES must not pipe git diff directly"; else ok; fi
if grep -q 'git diff-tree .*|| { SCOPE_MODE=full' "$SPEC"; then ok; else bad "git diff-tree reads must fall back to full scope"; fi
# the staging triage is the shared script: scoped and prior-PR arguments reach `classify`, the scope file and member PR list are built from the persisted 0B.1 state, no classifier logic is copied into the spec
if grep -qF -- '--scope-files "$SCOPE_FILE"' "$SPEC" && grep -qF -- '--prior-prs "$PRIOR_PRS"' "$SPEC" && grep -q '_scope.env' "$SPEC" && grep -q 'review-finalize.sh' "$SPEC"; then ok; else bad "7A/7C must call review-finalize.sh classify with --scope-files and --prior-prs from the persisted 0B.1 scope"; fi
if grep -qE "^(classify_one|cap_pass|prior_findings_tsv)\(\) \{" "$SPEC"; then bad "review-pr-staging.md must not carry a copy of the classifier, cap or re-flag logic"; else ok; fi
if grep -qF 'FINDING_TEXT_FILE="$WORKDIR/finding-text.$I"; jq -r' "$ROOT/scripts/review-finalize.sh" && grep -qF -- '--text-file "$FINDING_TEXT_FILE"' "$ROOT/scripts/review-finalize.sh"; then ok; else bad "FINDING_TEXT_FILE must be written before the classifier call in review-finalize.sh"; fi
grep -q "skip-dedup" "$ROOT/scripts/review-finalize.sh" && ok || bad "review-finalize.sh must skip a deduped finding"
grep -q "review-prepare.sh" "$SPEC" && grep -q -- "--no-delta" "$SPEC" && ok || bad "staging must call review-prepare.sh --no-delta in 0C"
# (7) fail-closed guard: BLOCKED when the classifier is unresolvable, no manual classifier mode, no classifier-unavailable fallback
SPEC_FIN="$ROOT/scripts/review-finalize.sh"   # review-pr.md delegates classification to review-finalize.sh, which owns the fail-closed BLOCKED line (#3841)
if grep -qE 'classifier=manual|echo script \|\| echo manual|classifier-unavailable' "$SPEC"; then bad "review-pr-staging.md must carry no manual classifier mode"; else ok; fi
for _s in $SPEC_FIN; do   # one path today; unquoted so SC2066 does not flag a single-iteration loop
  if grep -qE 'BLOCKED.*classifier unavailable' "$_s" && ! grep -qF 'echo script || echo manual' "$_s" && ! grep -qF 'classifier=manual' "$_s" && ! grep -qF 'classifier-unavailable' "$_s"; then ok; else bad "$(basename "$_s") must fail closed with BLOCKED classifier unavailable and have no manual fallback"; fi
done
# (8) fresh-shell reload (forge#3654): the FENCE_BOOTSTRAP lines must reload PR_NUMBER / ALL_PR_NUMBERS from the scratchpad, stay empty (with a warning) when nothing was persisted, and reject a tampered number
# (forge#3778) the spec carries a byte-identical stub per fence; the body lives in scripts/lib/fence-bootstrap.sh, which is SOURCED
# in a fresh shell (the stub's locator + source line is executed for real, so the stub itself is covered too).
[ "$(grep '# FENCE_BOOTSTRAP$' "$SPEC" | sort -u | wc -l | tr -d ' ')" -eq 1 ] && ok || bad "FENCE_BOOTSTRAP stubs must be byte-identical"
[ "$(grep -c '# FENCE_BOOTSTRAP$' "$SPEC")" -ge 3 ] && ok || bad "bootstrap must be carried by 0B.1 and both 7B.5 fences"
grep '^type forge_resolve >/dev/null' "$SPEC" | sed 1q > "$TMP/boot.sh"
grep '# FENCE_BOOTSTRAP$' "$SPEC" | sed 1q >> "$TMP/boot.sh"
[ "$(wc -l < "$TMP/boot.sh")" -eq 2 ] && ok || bad "bootstrap stub (locator + source line) not found"
# forge#3681: EVERY bash fence after Phase 0B that reads cross-fence state must carry the bootstrap (a fresh Bash call loses it)
UNCOVERED=$(awk '
  /^```bash/ { infence=1; body=""; start=NR; next }
  /^```/ && infence { infence=0
    if (start > 400 && body ~ /PR_NUMBER|ALL_PR_NUMBERS|GH_REPO|DEFAULT_BRANCH|STAGING_BRANCH/ && body !~ /# FENCE_BOOTSTRAP/) printf "%d ", start
    next }
  infence { body = body "\n" $0 }' "$SPEC")
[ -z "$UNCOVERED" ] && ok || bad "bash fences starting at line(s) ${UNCOVERED}consume cross-fence state without the FENCE_BOOTSTRAP block"
# the persisted Phase 6.5 / 6.75 values: producers write them, consumers reload them validated
grep -q 'test_gate_verdict' "$SPEC" && grep -q 'launched_review_agents' "$SPEC" && ok || bad "TEST_GATE_VERDICT and LAUNCHED_REVIEW_AGENTS must be persisted to the scratchpad"
# PR-keyed (concurrent runs in one cwd must not share state) and reset by an executable command, not prose
if grep -qE '\$_SD/(test_gate_verdict|test_gate_reason|launched_review_agents)|\.forge-scratch\}/launched_review_agents' "$SPEC"; then bad "gate/launched-agent scratch files must be keyed by \${PR_NUMBER}_"; else ok; fi
grep -qF ': > "$_SD/${PR_NUMBER}_launched_review_agents"' "$SPEC" && grep -qF 'rm -f "$_SD/${PR_NUMBER}_test_gate_verdict" "$_SD/${PR_NUMBER}_test_gate_reason"' "$SPEC" && ok || bad "Phase 2 must truncate and Phase 6.5 must rm -f the PR-keyed scratch files in executable commands"
if awk '/^### 7E:/,/^### 7F:/' "$SPEC" | grep -qF '{GH_REPO}'; then bad "7E must not use the {GH_REPO} template token"; else ok; fi
# (8b) forge#3733: Phase 6.75 fails closed on an empty/absent launched-agent list or empty PR_NUMBER; Phase 6 fails closed on a bad SELECTED_AGENT_COUNT
F675=$(awk '/^### Phase 6.75/,/^### 7A/' "$SPEC" | awk '/^```bash/{f=1;next} /^```/{if(f)exit} f')
GUARD_LN=$(printf '%s\n' "$F675" | grep -n 'launched-agent list is empty or unreadable' | head -1 | cut -d: -f1)
LOOP_LN=$(printf '%s\n' "$F675" | grep -n '^for AGENT_DOMAIN in' | head -1 | cut -d: -f1)
[ -n "$GUARD_LN" ] && [ -n "$LOOP_LN" ] && [ "$GUARD_LN" -lt "$LOOP_LN" ] && ok || bad "6.75 empty-list guard must precede the for AGENT_DOMAIN loop"
printf '%s\n' "$F675" | sed -n "1,$((LOOP_LN-1))p" | grep -v '^[[:space:]]*gh ' > "$TMP/f675.sh"
mkdir -p "$TMP/sd9/empty" "$TMP/sd9/full" "$TMP/bin9"
printf '#!/bin/sh\necho stub-value\n' > "$TMP/bin9/yq"; printf '#!/bin/sh\nexit 0\n' > "$TMP/bin9/gh"; chmod +x "$TMP/bin9/yq" "$TMP/bin9/gh"
: > "$TMP/sd9/empty/42_launched_review_agents"
printf 'security\n' > "$TMP/sd9/full/42_launched_review_agents"
run675() { ( unset LAUNCHED_REVIEW_AGENTS REVIEW_SHA_FULL; export PATH="$TMP/bin9:$PATH" FORGE_SCRATCHPAD="$1" HOME="$TMP/nohome" FORGEDOCK_HOME="$ROOT"; [ -n "$2" ] && export PR_NUMBER="$2"; bash "$TMP/f675.sh" 2>&1; echo "rc=$?" ); }
for _case in "$TMP/sd9/empty|42" "$TMP/sd9/none|42" "$TMP/sd9/full|"; do
  OUT9=$(run675 "${_case%%|*}" "${_case##*|}")
  case "$OUT9" in *"REVIEW DELIVERY FAILURE: launched-agent list is empty or unreadable"*"rc=1"*) ok ;; *) bad "6.75 must exit 1 for case '$_case' (got '$OUT9')" ;; esac
done
OUT9=$(run675 "$TMP/sd9/full" 42)
case "$OUT9" in *"launched-agent list is empty"*) bad "6.75 guard must not fire for a non-empty list (got '$OUT9')" ;; *) ok ;; esac
# Phase 6 SELECTED_AGENT_COUNT validation: static order + behaviour of the reload/validate lines
F6=$(awk '/Selected isolated reviewers/{exit} {print}' "$SPEC" | awk '/^```bash/{b=""; f=1; next} /^```/{f=0; next} f{b=b $0 "\n"; last=b} END{printf "%s", last}')
printf '%s' "$F6" | grep -qF 'SELECTED_COUNT_INVALID' && ok || bad "Phase 6 fence must validate SELECTED_AGENT_COUNT (SELECTED_COUNT_INVALID)"
printf '%s' "$F6" | grep -F 'SELECTED_AGENT_COUNT=' | grep -F 'launched_review_agents' > "$TMP/sel.sh"
printf '%s\n' 'SELECTED_COUNT_INVALID=false' "$(printf '%s' "$F6" | grep -F 'case "${SELECTED_AGENT_COUNT:-}"')" > "$TMP/selcase.sh"
for _c in "$TMP/sd9/empty|42" "$TMP/sd9/none|42" "$TMP/sd9/full|42"; do
  OUT9=$( ( unset SELECTED_AGENT_COUNT; _SD="${_c%%|*}"; PR_NUMBER="${_c##*|}"; . "$TMP/sel.sh"; . "$TMP/selcase.sh"; echo "$SELECTED_COUNT_INVALID|$SELECTED_AGENT_COUNT" ) 2>&1 )
  case "${_c%%|*}" in */full) [ "$OUT9" = "false|1" ] && ok || bad "Phase 6: one launched agent must give SELECTED_AGENT_COUNT=1 (got '$OUT9')" ;; *) [ "$OUT9" = "true|0" ] && ok || bad "Phase 6: empty/absent list must be invalid (got '$OUT9')" ;; esac
done
OUT9=$( ( SELECTED_AGENT_COUNT="abc"; . "$TMP/selcase.sh"; echo "$SELECTED_COUNT_INVALID" ) 2>&1 )
[ "$OUT9" = "true" ] && ok || bad "Phase 6: non-integer SELECTED_AGENT_COUNT must be invalid (got '$OUT9')"
mkdir -p "$TMP/sd8/full" "$TMP/sd8/empty" "$TMP/sd8/bad" "$TMP/bin"
printf '#!/bin/sh\necho stub-value\n' > "$TMP/bin/yq"; chmod +x "$TMP/bin/yq"
printf '42\n' > "$TMP/sd8/full/staging_pr_number.runA"; printf '7\n8\n' > "$TMP/sd8/full/42_bundle-prs.txt"
printf '43\n' > "$TMP/sd8/full/staging_pr_number.runB"; printf '9\n' > "$TMP/sd8/full/43_bundle-prs.txt"
printf '42; rm -rf /\n' > "$TMP/sd8/bad/staging_pr_number.runA"
boot() { # scratch-dir -> prints "PR_NUMBER|ALL_PR_NUMBERS(joined)|GH_REPO" then any warning
  ( unset PR_NUMBER ALL_PR_NUMBERS GH_REPO DEFAULT_BRANCH STAGING_BRANCH; export PATH="$TMP/bin:$PATH" FORGE_SCRATCHPAD="$1" FORGE_RUN_KEY="${2:-runA}"
    export FORGEDOCK_HOME="$ROOT"; . "$TMP/boot.sh" 2>&1; echo "PR=${PR_NUMBER:-}|ALL=$(echo ${ALL_PR_NUMBERS:-})|REPO=${GH_REPO:-}|BR=${STAGING_BRANCH:-}" ) 2>&1; }
OUT8=$(boot "$TMP/sd8/full")
[ "$OUT8" = "PR=42|ALL=7 8|REPO=stub-value|BR=stub-value" ] && ok || bad "fresh shell must reload staging_pr_number and bundle-prs from the scratchpad (got '$OUT8')"
OUT8=$(boot "$TMP/sd8/full" runB)
[ "$OUT8" = "PR=43|ALL=9|REPO=stub-value|BR=stub-value" ] && ok || bad "two runs in one scratchpad must each reload their own PR (got '$OUT8')"
OUT8=$(boot "$TMP/sd8/full" runC)
case "$OUT8" in *"WARNING: PR_NUMBER is empty"*"PR=|"*) ok ;; *) bad "a run with no pointer must not read another run's pointer (got '$OUT8')" ;; esac
OUT8=$(boot "$TMP/sd8/full" '../x')
case "$OUT8" in *"PR=|"*) ok ;; *) bad "a path-like run key must be sanitised (got '$OUT8')" ;; esac
_KD='FORGE_RUN_KEY=$(printf'
[ "$(grep -F "$_KD" "$SPEC" | grep -F 'FORGE_RUN_KEY="${FORGE_RUN_KEY:-' | head -1)" = "$(grep -F "$_KD" "$ROOT/scripts/lib/fence-bootstrap.sh" | grep -F 'FORGE_RUN_KEY="${FORGE_RUN_KEY:-' | head -1)" ] && grep -qF 'FORGE_RUN_KEY="${FORGE_RUN_KEY:-' "$SPEC" && ok || bad "FORGE_RUN_KEY derivation must be identical in spec and fence-bootstrap.sh"
OUT8=$(boot "$TMP/sd8/empty")
case "$OUT8" in *"WARNING: PR_NUMBER is empty"*"PR=|ALL=|"*) ok ;; *) bad "empty scratchpad must leave PR_NUMBER empty and warn (got '$OUT8')" ;; esac
OUT8=$(boot "$TMP/sd8/bad")
case "$OUT8" in *"PR=|"*) ok ;; *) bad "non-numeric staging_pr_number must be rejected (got '$OUT8')" ;; esac
# an already-set PR_NUMBER wins over a stale scratch file
OUT8=$( ( unset ALL_PR_NUMBERS; PR_NUMBER=99; export PATH="$TMP/bin:$PATH" FORGE_SCRATCHPAD="$TMP/sd8/full" FORGEDOCK_HOME="$ROOT"; . "$TMP/boot.sh" >/dev/null 2>&1; echo "PR=$PR_NUMBER|ALL=${ALL_PR_NUMBERS:-}" ) )
[ "$OUT8" = "PR=99|ALL=" ] && ok || bad "in-shell PR_NUMBER must not be overridden by the scratch file (got '$OUT8')"
# producers persist, and 0B.1 / 7B.5 no longer use the unsubstituted-template repo token or a bare unquoted PR number in gh pr comment
grep -q 'staging_pr_number' "$SPEC" && grep -q '_bundle-prs.txt' "$SPEC" && ok || bad "Phase -1 / 0A must persist staging_pr_number and _bundle-prs.txt"
if awk '/^### 0B.1:/,/^## Phase 1:/' "$SPEC" | grep -q '{GH_REPO}'; then bad "0B.1 must not use the {GH_REPO} template token"; else ok; fi
if awk '/^### 7A:/,/^### 7D:/' "$SPEC" | grep -qE '\{GH_REPO\}|gh pr comment \$\{PR_NUMBER\}'; then bad "7A-7C must use quoted \$GH_REPO / \$PR_NUMBER"; else ok; fi
# (7) reviewer templates bind the full head SHA via the dispatch placeholder, not an orchestrator-only shell var
if grep -qE '^Reviewed-SHA: \$\{REVIEW_SHA_FULL\}$' "$SPEC"; then bad "reviewer template still uses \${REVIEW_SHA_FULL} (unbound in a fresh shell)"; else ok; fi
[ "$(grep -cE '^Reviewed-SHA: \[REVIEW_SHA\]$' "$SPEC")" -ge 5 ] && ok || bad "all five reviewer templates must use Reviewed-SHA: [REVIEW_SHA]"
if grep -E '^Reviewed-SHA:' "$SPEC" | grep -qvE '^Reviewed-SHA: \[REVIEW_SHA\]$'; then bad "every Reviewed-SHA template line must be [REVIEW_SHA]"; else ok; fi
grep -F 'substitute `[REVIEW_SHA]`' "$SPEC" | grep -qF '[REVIEW_SHA_SHORT]' || grep -qF 'Also substitute `[REVIEW_SHA]`' "$SPEC" && ok || bad "dispatch text must bind [REVIEW_SHA]"
# (8) cross-PR re-flag (forge#3641) and the per-review cap (forge#3642) now run inside review-finalize.sh classify: scripts/review-finalize.test.sh covers them (bundle re-flag, scope demotion, cap)
# (9) stale-head delta credit (forge#3638): the spec's bundle_delta_credit runs against real git fixtures and the REAL review-delta.sh / trusted-comments.sh.
# Fail-closed cases first: every FULL / error / untrusted path must leave the PR's commits UNREVIEWED (empty credit).
if command -v git >/dev/null 2>&1; then
awk '/^# BEGIN bundle-delta-credit$/{f=1;next} /^# END bundle-delta-credit$/{f=0} f' "$SPEC" > "$TMP/delta-fn.sh"
[ -s "$TMP/delta-fn.sh" ] && ok || bad "bundle-delta-credit block not found in the spec"
RDS="$ROOT/scripts/review-delta.sh"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
g9() { git -C "$W9" -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
commit9() { mkdir -p "$W9/$(dirname "$1")"; printf '%s\n' "$2" > "$W9/$1"; g9 add -A >/dev/null; g9 commit -q -m "$3" >/dev/null; }
C9=0
mkrepo9() { # W9 = clone with origin/main, branch feat with one PR commit
  C9=$((C9+1)); local o="$TMP/do$C9"; W9="$TMP/dw$C9"
  git init -q --bare -b main "$o"; git clone -q "$o" "$W9" 2>/dev/null
  g9 checkout -q -b main 2>/dev/null; commit9 a.txt base base; g9 push -q origin main; g9 checkout -q feat 2>/dev/null || g9 checkout -q -b feat; commit9 pr.txt pr1 pr1
}
agent9() { printf '<!-- FORGE:REVIEW-AGENT:%s -->\nReviewed-SHA: %s\n\n<!-- REVIEW-FINDINGS-START -->\nNo findings.\n<!-- REVIEW-FINDINGS-END -->' "$1" "$2"; }
synth9() { printf '<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->\nReviewed-SHA: %s\n\nsynth' "$1"; }
carried9() { printf '<!-- FORGE:REVIEW-CARRIED -->\nReviewed-SHA: %s\nCarried-From-SHA: %s\n' "$1" "$2"; }
cm9() { jq -n --arg b "$1" --arg t "${2:-Bot}" '{"body":$b,"author_association":"NONE","user":{"type":$t,"login":"x"}}'; }
panel9() { CM9=$(printf '%s\n' "$(cm9 "$(agent9 security "$1")")" "$(cm9 "$(agent9 api "$1")")" "$(cm9 "$(synth9 "$1")")" | jq -s '.'); }
credit9() { # args: head, labels-csv (default none); needs W9 CM9; prints "<DELTA_FULL>|<credited oids, short>"
  local head="$1" labels="${2:-}" J
  J=$(git -C "$W9" log --format=%H origin/main..HEAD | jq -R . | jq -s --arg h "$head" --arg l "$labels" '{headRefOid:$h,baseRefName:"main",mergeCommit:null,labels:($l|split(",")|map(select(.!="")|{name:.})),commits:(map({oid:.})|reverse)}')
  ( cd "$W9"; pr=7; PR_NUMBER=9; GH_REPO=o/r; _SD="$TMP"; _HEAD="$head"; _J="$J"; _CM="$CM9"; TRUSTED_SCRIPT="${T9_TRUSTED:-$TC}"; REVIEW_DELTA_SCRIPT="${T9_RD-$RDS}"
    . "$TMP/delta-fn.sh"; bundle_delta_credit; echo "$DELTA_FULL|$(for o in $DELTA_COMMITS; do printf '%s ' "${o:0:7}"; done)" )
}
short9() { git -C "$W9" rev-parse --short=7 "$1"; }
# stale-SHA PR, but no trusted panel: stays UNREVIEWED
mkrepo9; R=$(git -C "$W9" rev-parse HEAD); commit9 pr.txt pr2 pr2; H=$(git -C "$W9" rev-parse HEAD); CM9='[]'
[ "$(credit9 "$H")" = "0|" ] && ok || bad "stale head with no trusted panel must credit nothing (got '$(credit9 "$H")')"
# untrusted reviewer comments (User type): stays UNREVIEWED
CM9=$(printf '%s\n' "$(cm9 "$(agent9 security "$R")" User)" "$(cm9 "$(agent9 api "$R")" User)" "$(cm9 "$(synth9 "$R")" User)" | jq -s '.')
[ "$(credit9 "$H")" = "0|" ] && ok || bad "untrusted panel comments must credit nothing (got '$(credit9 "$H")')"
# resolver script missing / garbage / error: UNREVIEWED
panel9 "$R"
[ "$(T9_RD="" credit9 "$H")" = "0|" ] && ok || bad "unresolved review-delta.sh must credit nothing"
printf '#!/bin/sh\necho "DELTA garbage"\necho FULL_ROUNDS=1\n' > "$TMP/rd-garbage.sh"
[ "$(T9_RD="$TMP/rd-garbage.sh" credit9 "$H")" = "0|" ] && ok || bad "malformed resolver output must credit nothing"
printf '#!/bin/sh\nexit 3\n' > "$TMP/rd-error.sh"
[ "$(T9_RD="$TMP/rd-error.sh" credit9 "$H")" = "0|" ] && ok || bad "a failing resolver must credit nothing"
printf '#!/bin/sh\necho FULL\necho FULL_ROUNDS=0\n' > "$TMP/rd-full.sh"
[ "$(T9_RD="$TMP/rd-full.sh" credit9 "$H")" = "0|" ] && ok || bad "resolver FULL must credit nothing"
printf '#!/bin/sh\necho "DELTA %s..%s"\necho FULL_ROUNDS=1\n' "$H" "$H" > "$TMP/rd-same.sh"
[ "$(T9_RD="$TMP/rd-same.sh" credit9 "$H")" = "0|" ] && ok || bad "a resolver DELTA whose from equals head must credit nothing"
printf '#!/bin/sh\necho "DELTA %s..%s"\necho FULL_ROUNDS=1\n' "$R" "$R" > "$TMP/rd-wrongto.sh"
[ "$(T9_RD="$TMP/rd-wrongto.sh" credit9 "$H")" = "0|" ] && ok || bad "a resolver DELTA whose to is not the PR head must credit nothing"
# degraded label: the resolver forces FULL
[ "$(credit9 "$H" review-degraded)" = "0|" ] && ok || bad "a review-degraded PR must credit nothing"
# force-pushed PR (reviewed sha no longer an ancestor): all UNREVIEWED
mkrepo9; R=$(git -C "$W9" rev-parse HEAD); panel9 "$R"; g9 reset -q --hard HEAD~1; commit9 pr.txt rewritten rewritten; H=$(git -C "$W9" rev-parse HEAD)
[ "$(credit9 "$H")" = "0|" ] && ok || bad "force-pushed PR must keep every commit UNREVIEWED (got '$(credit9 "$H")')"
# resolver says DELTA from a sha that is not an ancestor of the PR commits (stub): per-commit ancestor test credits nothing
mkrepo9; R=$(git -C "$W9" rev-parse HEAD); commit9 pr.txt pr2 pr2; H=$(git -C "$W9" rev-parse HEAD); panel9 "$R"
g9 checkout -q -b other main; commit9 o.txt o other; O=$(git -C "$W9" rev-parse HEAD); g9 checkout -q feat
printf '#!/bin/sh\necho "DELTA %s..%s"\necho FULL_ROUNDS=1\n' "$O" "$H" > "$TMP/rd-unrelated.sh"
[ "$(T9_RD="$TMP/rd-unrelated.sh" credit9 "$H")" = "0|" ] && ok || bad "a DELTA from an unrelated sha must credit no PR commit"
# carried base-sync: untrusted / absent record stays UNREVIEWED
mkrepo9; R=$(git -C "$W9" rev-parse HEAD); panel9 "$R"; g9 checkout -q main; commit9 b.txt b1 b1; g9 push -q origin main; g9 checkout -q feat; g9 fetch -q origin
g9 merge -q --no-ff -m "merge main" origin/main >/dev/null 2>&1; H=$(git -C "$W9" rev-parse HEAD)
PANEL9=$CM9
[ "$(credit9 "$H")" = "0|" ] && ok || bad "BASE_SYNC_ONLY with no carried record must credit nothing (got '$(credit9 "$H")')"
CM9=$(printf '%s\n%s\n' "$(printf '%s' "$PANEL9" | jq -c '.[]')" "$(cm9 "$(carried9 "$H" "$R")" User)" | jq -s '.')
[ "$(credit9 "$H")" = "0|" ] && ok || bad "an untrusted REVIEW-CARRIED record must credit nothing (got '$(credit9 "$H")')"
CM9=$(printf '%s\n%s\n' "$(printf '%s' "$PANEL9" | jq -c '.[]')" "$(cm9 "$(carried9 "$H" "$(printf 'c%.0s' $(seq 1 40))")")" | jq -s '.')
[ "$(credit9 "$H")" = "0|" ] && ok || bad "a carried record naming another reviewed sha must credit nothing"
# --- happy paths
CM9=$(printf '%s\n%s\n' "$(printf '%s' "$PANEL9" | jq -c '.[]')" "$(cm9 "$(carried9 "$H" "$R")")" | jq -s '.')
[ "$(credit9 "$H")" = "1|" ] && ok || bad "carried base-sync with a trusted record must credit the whole PR (got '$(credit9 "$H")')"
# stale-SHA PR: older trusted complete panel at R, one real new commit -> only the old commit is credited
mkrepo9; R=$(git -C "$W9" rev-parse HEAD); R7=$(short9 "$R"); commit9 pr.txt pr2 pr2; H=$(git -C "$W9" rev-parse HEAD); H7=$(short9 "$H"); panel9 "$R"
OUT9=$(credit9 "$H")
[ "$OUT9" = "0|$R7 " ] && ok || bad "stale-SHA PR must credit only commits up to the reviewed sha, not the new one (got '$OUT9', new commit $H7)"
# partially reviewed PR: two commits reviewed, two new -> only the reviewed two credited
mkrepo9; commit9 pr.txt pr1b pr1b; R=$(git -C "$W9" rev-parse HEAD); panel9 "$R"; commit9 pr.txt pr3 pr3; commit9 pr.txt pr4 pr4; H=$(git -C "$W9" rev-parse HEAD)
OUT9=$(credit9 "$H"); N9=$(printf '%s' "${OUT9#*|}" | wc -w)
[ "${OUT9%%|*}" = 0 ] && [ "$N9" -eq 2 ] && case "$OUT9" in *"$(short9 HEAD)"*|*"$(short9 HEAD~1)"*) false ;; *) true ;; esac && ok || bad "partial review must credit exactly the 2 reviewed commits (got '$OUT9')"
# spec text guards: the resolver is reused, never copied; carried record accepted; the unchanged cross-PR and merge-resolution paths are still present
grep -q 'review-delta.sh' "$SPEC" && grep -q 'REVIEW-CARRIED' "$SPEC" && ok || bad "spec must call review-delta.sh and accept the REVIEW-CARRIED record"
if grep -qE 'merge-base --is-ancestor.*REVIEWED_SHA_STALE|diff_shape\(\)' "$SPEC"; then bad "spec must not carry a second copy of the resolver logic"; else ok; fi
grep -qF 'printf '"'"'%s\n'"'"' "$_FILES" | sort -u | sed "s|^|$pr |" >> "$_PF"' "$SPEC" && grep -qF 'git diff-tree --no-commit-id --name-only -r --cc "$c"' "$SPEC" && ok || bad "CROSS_PR_FILES accumulation and --cc merge scoping must stay intact"
[ "$(grep -c '# FENCE_BOOTSTRAP$' "$SPEC" | head -1)" -ge 3 ] && ok || bad "FENCE_BOOTSTRAP stubs must remain"
# an unresolvable helper fails the fence closed (exit 1), never an unsourced bootstrap
OUT8=$( ( unset FORGEDOCK_HOME FORGE_HOME FORGE_ROOT CLAUDE_PLUGIN_ROOT CLAUDE_CONFIG_DIR CODEX_HOME FORGE_SOURCED_ROOT FORGEDOCK_MARKETPLACE; export HOME="$TMP/nohome"; cd "$TMP" && bash -c "$(cat "$TMP/boot.sh"); echo reached" ) 2>&1 )
case "$OUT8" in *BLOCKED*) case "$OUT8" in *reached*) bad "unresolved bootstrap helper must stop the fence" ;; *) ok ;; esac ;; *) bad "unresolved bootstrap helper must print BLOCKED (got '$OUT8')" ;; esac
# a stale-head PR must not credit its own merge commit (it contains the post-review commits): the DELTA branch only appends DELTA_COMMITS
if awk '/^bundle_delta_credit\(\)/,/^\}/' "$SPEC" | grep -q 'mergeCommit'; then bad "the DELTA path must not credit the PR merge commit"; else ok; fi
# (10) fail-closed gate verdict (forge#3734): an empty/missing/invalid persisted verdict must never become SKIP
awk '/^\*\*Verdict handling\*\*:/{f=1;next} f&&/^```bash/{g=1;next} g&&/^```/{exit} g' "$SPEC" | grep -v '# FENCE_BOOTSTRAP$' > "$TMP/vh.sh"
[ -s "$TMP/vh.sh" ] && ok || bad "could not extract the Phase 6.5 verdict-handling fence"
if awk '/^  \*\)/,/;;/' "$SPEC" | grep -q 'TEST_GATE_VERDICT="SKIP"'; then bad "catch-all arm must not set TEST_GATE_VERDICT=SKIP"; else ok; fi
grep -qF 'missing/invalid' "$SPEC" && ok || bad "spec must document missing/invalid gate-verdict handling"
if grep -F 'FORGE:TEST_GATE:RESULT=' "$SPEC" | grep -q 'tail -1 || echo "SKIP"'; then bad "producer must not coerce an absent marker to SKIP"; else ok; fi
vh10() { # $1 posture, $2 persisted verdict content ('-' = no file), $3 env verdict (optional)
  local sd="$TMP/vh10.$RANDOM"; mkdir -p "$sd"
  [ "$2" = "-" ] || printf '%s\n' "$2" > "$sd/5_test_gate_verdict"
  ( export _SD="$sd" PR_NUMBER=5 GH_REPO=o/r DEFAULT_BRANCH=main ALL_PR_NUMBERS="5" CONFIG_FILE=/dev/null P10="$1"
    [ -z "${3:-}" ] || export TEST_GATE_VERDICT="$3"
    forge_resolve() { :; }; yq() { case "$*" in *posture*) echo "$P10" ;; *) echo "OVERRIDE: x" ;; esac; }; gh() { return 0; }
    . "$TMP/vh.sh" >"$sd/out" 2>&1; echo "rc=0" >> "$sd/out" ) ; local rc=$?
  VH10_OUT=$(cat "$sd/out"); VH10_V=$(cat "$sd/5_test_gate_verdict" 2>/dev/null); VH10_R=$(cat "$sd/5_test_gate_reason" 2>/dev/null)
}
for case10 in "-" "" "garbage" "pass" "SKIP extra"; do
  vh10 blocking "$case10"
  case "$VH10_OUT" in *rc=0*) bad "blocking posture must exit non-zero for persisted verdict '$case10'" ;; *) ok ;; esac
  [ "$VH10_V" = "BLOCK" ] && case "$VH10_R" in *missing/invalid*) true ;; *) false ;; esac && ok || bad "blocking posture must persist BLOCK + missing/invalid reason for '$case10' (got '$VH10_V' / '$VH10_R')"
  vh10 advisory "$case10"
  case "$VH10_OUT" in *rc=0*) ok ;; *) bad "advisory posture must not block for persisted verdict '$case10'" ;; esac
  [ "$VH10_V" = "BLOCK" ] && case "$VH10_R" in *advisory*missing/invalid*) true ;; *) false ;; esac && ok || bad "advisory posture must record BLOCK (advisory) missing/invalid for '$case10' (got '$VH10_V' / '$VH10_R')"
done
vh10 blocking "-" "bogus"
case "$VH10_OUT" in *rc=0*) bad "an unrecognised in-env verdict must fail closed under blocking posture" ;; *) ok ;; esac
vh10 blocking "PASS"
case "$VH10_OUT" in *rc=0*) [ "$VH10_V" = "PASS" ] && ok || bad "a valid persisted PASS must stay PASS" ;; *) bad "a valid persisted PASS must not block" ;; esac
vh10 blocking "SKIP"
case "$VH10_OUT" in *rc=0*) [ "$VH10_V" = "SKIP" ] && ok || bad "a valid persisted SKIP must stay SKIP" ;; *) bad "a valid persisted SKIP must not block" ;; esac
else echo "review-pr-staging-scope.test.sh: git missing, delta section skipped"; fi
echo "review-pr-staging-scope.test.sh: passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
