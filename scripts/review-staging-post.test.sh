#!/usr/bin/env bash
# review-staging-post.test.sh — cases for scripts/review-staging-post.sh (forge#4359): the incomplete-panel guard, Phase 6.75
# agent delivery and the Phase 6.5 test-gate verdict handling (formerly extracted from commands/review-pr-staging.md fences).
# gh is a PATH stub reading per-case fixtures; trust decisions go through the real scripts/trusted-comments.sh.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POST="$ROOT/scripts/review-staging-post.sh"
SPEC="$ROOT/commands/review-pr-staging.md"
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
command -v jq >/dev/null 2>&1 || { echo "review-staging-post.test.sh: jq missing, skipped"; exit 0; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FORGEDOCK_HOME="$ROOT"   # resolve helpers from this checkout, not an ambient install
HEAD=0123456789abcdef0123456789abcdef01234567
OTHER=fedcba9876543210fedcba9876543210fedcba98
blk() { awk -v n="$1" '$0 == "# BEGIN " n {f=1; next} $0 == "# END " n {f=0} f' "$POST"; }

# (1) the fences now live only in the script: the blocks exist, the spec no longer carries them
for b in panel-guard delivery-check test-gate-extract test-gate-verdict; do
  [ -n "$(blk "$b")" ] && ok || bad "block $b missing from review-staging-post.sh"
done
if grep -qE 'ACTUAL_AGENT_COUNT=\$\(gh api|MISSING_AGENT_COMMENTS=""|GATE_VERDICT_INVALID=0' "$SPEC"; then bad "the spec must not carry a copy of the panel-guard, delivery or verdict-handling fence"; else ok; fi
# 6.75 carries the findings-block lookahead; the 6.75 empty-list guard precedes the per-domain loop
blk delivery-check | grep -qF 'count "^(?=[\\s\\S]*<!-- REVIEW-FINDINGS-START -->[\\s\\S]*<!-- REVIEW-FINDINGS-END -->)<!-- FORGE:REVIEW-AGENT:${AGENT_DOMAIN} -->' && ok || bad "6.75 count must require the findings block"
G=$(blk delivery-check | grep -n 'launched-agent list is empty or unreadable' | head -1 | cut -d: -f1); L=$(blk delivery-check | grep -n '^for AGENT_DOMAIN in' | head -1 | cut -d: -f1)
[ -n "$G" ] && [ -n "$L" ] && [ "$G" -lt "$L" ] && ok || bad "6.75 empty-list guard must precede the for AGENT_DOMAIN loop"
# the producer never coerces an absent marker to SKIP; the catch-all arm never sets SKIP
if blk test-gate-extract | grep -q 'tail -1 || echo "SKIP"'; then bad "producer must not coerce an absent marker to SKIP"; else ok; fi
if blk test-gate-verdict | awk '/^  \*\)/,/;;/' | grep -q 'TEST_GATE_VERDICT="SKIP"'; then bad "catch-all arm must not set TEST_GATE_VERDICT=SKIP"; else ok; fi

# (2) usage errors
bash "$POST" bogus --repo o/r --pr 1 --sd "$TMP/u" >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "unknown subcommand must exit 2"
bash "$POST" delivery --repo o/r --pr x --sd "$TMP/u" >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "non-numeric --pr must exit 2"
bash "$POST" delivery --repo o/r --pr 1 >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "missing --sd must exit 2"
bash "$POST" test-gate --repo o/r --pr 1 --sd "$TMP/u" --output x --prs-file "$TMP/none" >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "unreadable --prs-file must exit 2"
bash "$POST" test-gate --repo o/r --pr 1 --sd "$TMP/u" --output x --prs-file /dev/null --posture lax >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "unknown --posture must exit 2"

# gh stub: $FIX/comments.json is the PR's comment list; posted bodies and edits go to $FIX/posted / $FIX/edits
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
F="$FIX"; a="$*"
case "$1 $2" in
  "pr comment") while [ $# -gt 0 ]; do [ "$1" = --body ] && printf '%s\n@@\n' "$2" >> "$F/posted"; shift; done; exit 0 ;;
  "pr edit") printf '%s\n' "$a" >> "$F/edits"; exit 0 ;;
  "label create") exit 0 ;;
  "pr view") [ -f "$F/head" ] && { cat "$F/head"; exit 0; }; exit 1 ;;
esac
if [ "$1" = api ]; then case "$a" in *"/comments"*) cat "$F/comments.json" 2>/dev/null || exit 1; exit 0 ;; esac; fi
echo "gh stub: unhandled: $a" >&2; exit 1
STUB
printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/yq"   # no yq: defaults apply
chmod +x "$TMP/bin/gh" "$TMP/bin/yq"
export PATH="$TMP/bin:$PATH"
newfix() { FIX="$TMP/fix.$1"; rm -rf "$FIX"; mkdir -p "$FIX/sd"; export FIX; }
FB=$'<!-- REVIEW-FINDINGS-START -->\n<!-- REVIEW-FINDINGS-END -->'
cm() { jq -n --arg b "$1" --arg t "${2:-Bot}" '{body:$b, author_association:"NONE", user:{type:$t, login:"x"}}'; }
agent() { printf '<!-- FORGE:REVIEW-AGENT:%s -->\nReviewed-SHA: %s\n\n%s' "$1" "${2:-$HEAD}" "${3-$FB}"; }
comments() { jq -s '.' > "$FIX/comments.json"; }
deliver() { bash "$POST" delivery --repo o/r --pr 42 --sd "$FIX/sd" --head "${1:-$HEAD}" 2>&1; echo "rc=$?"; }

# (3) delivery: a complete panel passes and posts nothing
newfix full; printf 'security\nmaterial-change\n' > "$FIX/sd/42_launched_review_agents"
{ cm "$(agent security)"; cm "$(agent material-change)"; } | comments
OUT=$(deliver); case "$OUT" in *"DELIVERY: OK (2/2"*"rc=0") ok ;; *) bad "complete panel must pass (got: $OUT)" ;; esac
[ ! -s "$FIX/posted" ] && ok || bad "a complete panel must post nothing"
# a duplicate domain line does not inflate the selected count
printf 'security\nsecurity\nmaterial-change\n' > "$FIX/sd/42_launched_review_agents"
OUT=$(deliver); case "$OUT" in *"rc=0") ok ;; *) bad "duplicate launched lines must count once (got: $OUT)" ;; esac

# (4) shortfalls: missing domain, block-less comment, untrusted author, other head -> panel-integrity failure
for c in missing noblock untrusted otherhead; do
  newfix "$c"; printf 'security\nmaterial-change\n' > "$FIX/sd/42_launched_review_agents"
  case "$c" in
    missing) cm "$(agent security)" | comments ;;
    noblock) { cm "$(agent security)"; cm "$(agent material-change "$HEAD" 'Verdict: APPROVE, no findings.')"; } | comments ;;
    untrusted) { cm "$(agent security)"; cm "$(agent material-change)" User; } | comments ;;
    otherhead) { cm "$(agent security)"; cm "$(agent material-change "$OTHER")"; } | comments ;;
  esac
  OUT=$(deliver)
  case "$OUT" in *"rc=1") ok ;; *) bad "$c: delivery must fail (got: $OUT)" ;; esac
  if [ "$c" = noblock ]; then
    case "$OUT" in *"missing findings comment(s) for: material-change"*) ok ;; *) bad "noblock: 6.75 must name the block-less domain (got: $OUT)" ;; esac
  else
    grep -qF '<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity -->' "$FIX/posted" 2>/dev/null && ok || bad "$c: shortfall must post GATE_FAILURE:TYPE=review-panel-integrity"
    grep -qF 'review-degraded' "$FIX/edits" 2>/dev/null && ok || bad "$c: shortfall must label the PR review-degraded"
  fi
done
# empty / absent launched list fails closed
newfix empty; : > "$FIX/sd/42_launched_review_agents"; cm "$(agent security)" | comments
OUT=$(deliver); case "$OUT" in *"rc=1") ok ;; *) bad "empty launched list must fail (got: $OUT)" ;; esac
newfix none; cm "$(agent security)" | comments
OUT=$(deliver); case "$OUT" in *"rc=1") ok ;; *) bad "absent launched list must fail (got: $OUT)" ;; esac
# unreadable comments count as 0 delivered
newfix unreadable; printf 'security\n' > "$FIX/sd/42_launched_review_agents"
OUT=$(deliver); case "$OUT" in *"rc=1") ok ;; *) bad "unreadable comments must fail closed (got: $OUT)" ;; esac
# a malformed --head with no resolvable head refuses
newfix badhead; printf 'security\n' > "$FIX/sd/42_launched_review_agents"; cm "$(agent security)" | comments
OUT=$(deliver "n/a"); case "$OUT" in *"rc=1") ok ;; *) bad "an unresolvable head must fail closed (got: $OUT)" ;; esac
# ...but a malformed --head is re-resolved from gh when it can be
printf '%s\n' "$HEAD" > "$FIX/head"
OUT=$(deliver "n/a"); case "$OUT" in *"rc=0") ok ;; *) bad "a malformed --head must be re-resolved from gh (got: $OUT)" ;; esac

# (5) test gate
tg() { bash "$POST" test-gate --repo o/r --pr 42 --sd "$FIX/sd" --output "$FIX/out" --prs-file "$FIX/prs" "$@" 2>&1; echo "rc=$?"; }
tfix() { newfix "tg$1"; printf '7\n8\n' > "$FIX/prs"; echo '[]' > "$FIX/comments.json"; }
v() { sed -n 1p "$FIX/sd/42_test_gate_verdict"; }
tfix skip; printf 'noise\nFORGE:TEST_GATE:RESULT=SKIP\n' > "$FIX/out"
OUT=$(tg); case "$OUT" in *"rc=0") ok ;; *) bad "SKIP must continue (got: $OUT)" ;; esac
[ "$(v)" = SKIP ] && ok || bad "SKIP must be persisted (got $(v))"
[ ! -s "$FIX/posted" ] && ok || bad "SKIP posts no gate marker from the test gate"
tfix pass; printf 'FORGE:TEST_GATE:RESULT=BLOCK\nFORGE:TEST_GATE:RESULT=PASS\n' > "$FIX/out"
OUT=$(tg); case "$OUT" in *"rc=0") ok ;; *) bad "PASS must continue (got: $OUT)" ;; esac
[ "$(v)" = PASS ] && ok || bad "the last marker wins (got $(v))"
grep -qF '<!-- FORGE:GATE_PASS:TYPE=test-gate|BUNDLE=7 8 -->' "$FIX/posted" && ok || bad "PASS must post GATE_PASS:TYPE=test-gate with the bundle"
for m in missing nofile; do
  tfix "$m"; [ "$m" = missing ] && printf 'all good, no marker\n' > "$FIX/out"
  OUT=$(tg); case "$OUT" in *"RESULT: BLOCK DEPLOY"*"rc=1") ok ;; *) bad "$m marker must fail closed as BLOCK (got: $OUT)" ;; esac
  [ "$(v)" = BLOCK ] && ok || bad "$m: persisted verdict must be BLOCK, never SKIP (got $(v))"
  grep -qF '<!-- FORGE:GATE_FAILURE:TYPE=test-gate|BUNDLE=7 8 -->' "$FIX/posted" && ok || bad "$m: blocking BLOCK must post GATE_FAILURE"
done
tfix advisory; printf 'FORGE:TEST_GATE:RESULT=BLOCK\n' > "$FIX/out"
OUT=$(tg --posture advisory); case "$OUT" in *"rc=0") ok ;; *) bad "advisory BLOCK must continue (got: $OUT)" ;; esac
grep -q 'advisory' "$FIX/sd/42_test_gate_reason" && ok || bad "advisory reason must be persisted"
tfix override; printf 'FORGE:TEST_GATE:RESULT=BLOCK\n' > "$FIX/out"
cm 'OVERRIDE: shipping with test failures — flaky infra, tracked in #9' | comments
OUT=$(tg); case "$OUT" in *"rc=0") ok ;; *) bad "a trusted override must downgrade BLOCK (got: $OUT)" ;; esac
[ "$(v)" = PASS ] && grep -q 'downgraded to PASS by override' "$FIX/sd/42_test_gate_reason" && ok || bad "override must persist PASS with the reason"
tfix untrustedov; printf 'FORGE:TEST_GATE:RESULT=BLOCK\n' > "$FIX/out"
cm 'OVERRIDE: shipping with test failures — me' User | comments
OUT=$(tg); case "$OUT" in *"rc=1") ok ;; *) bad "an untrusted override must not downgrade BLOCK (got: $OUT)" ;; esac
tfix phrase; printf 'FORGE:TEST_GATE:RESULT=BLOCK\n' > "$FIX/out"
cm 'SHIP IT (a.b) because' | comments
OUT=$(tg --override-phrase 'SHIP IT (a.b)'); case "$OUT" in *"rc=0") ok ;; *) bad "a configured override phrase must be honoured literally (got: $OUT)" ;; esac
# stale verdict from a prior run is reset before reading
tfix stale; printf 'PASS\n' > "$FIX/sd/42_test_gate_verdict"; printf 'nothing\n' > "$FIX/out"
OUT=$(tg); [ "$(v)" = BLOCK ] && ok || bad "a stale persisted PASS must not survive a missing marker (got $(v))"

echo "review-staging-post.test.sh: passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
