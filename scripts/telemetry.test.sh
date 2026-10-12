#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Tests for scripts/lib/telemetry.sh (forge_emit): record shape per event, upsert, rollover, buffer/flush,
# kill switch, never-fails guarantee. No network: gh is replaced via FORGE_TELEMETRY_GH.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB="$HERE/lib/telemetry.sh"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1" >&2; }
check() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got '$2', want '$3')"; fi; }

TD=$(mktemp -d); trap 'rm -rf "$TD"' EXIT
export TD FORGE_REPO=o/r FORGE_ISSUE=5 FORGE_TELEMETRY_BUFFER_DIR="$TD/buf"
unset FORGE_TELEMETRY FORGE_PR FORGE_RUN FORGE_PHASE FORGE_TELEMETRY_MAX_CHARS
cat > "$TD/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$TD/calls"
case "$*" in
  "api --paginate "*) if [ -f "$TD/comments.json" ]; then cat "$TD/comments.json"; else echo '[]'; fi ;;
  "api -X PATCH"*) b="${@: -1}"; printf '%s' "${b#body=}" > "$TD/patched" ;;
  "api -X POST"*) b="${@: -1}"; printf '%s' "${b#body=}" > "$TD/posted" ;;
esac
STUB
cat > "$TD/gh-fail" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$TD/gh" "$TD/gh-fail"
export FORGE_TELEMETRY_GH="$TD/gh"
set_comments() { jq -n --arg b "$1" --arg t "${2:-Bot}" '[{id:77,body:$b,user:{type:$t},author_association:"NONE"}]' > "$TD/comments.json"; }
nrec() { printf '%s\n' "$1" | grep -c '^{'; }
reset() { rm -rf "$TD/calls" "$TD/posted" "$TD/patched" "$TD/comments.json" "$TD/buf"; }

. "$LIB"

# 1. One fixture per event shape: record carries the shared keys plus the payload, typed.
reset
forge_emit diff_size lines=10 excluded=2 threshold=0 result=OK
REC=$(grep '^{' "$TD/posted")
check "post has marker" "$(head -n 1 "$TD/posted")" "<!-- FORGE:TELEMETRY v1 -->"
check "shared keys" "$(printf '%s' "$REC" | jq -c 'keys_unsorted[:9]')" '["v","ts","forge_version","repo","issue","pr","run","phase","event"]'
check "issue number" "$(printf '%s' "$REC" | jq -r '.issue')" "5"
check "pr null" "$(printf '%s' "$REC" | jq -r '.pr')" "null"
check "numeric payload" "$(printf '%s' "$REC" | jq -r '.lines + .excluded')" "12"
check "string payload" "$(printf '%s' "$REC" | jq -r '.result')" "OK"
for fx in "acceptance_gate phase=review verified=3 failed=0 malformed=1 deferred=0:phase" \
          "finding_disposition severity=HIGH confidence=CONFIRMED agent=auth disposition=ISSUE reason=severity-HIGH:disposition" \
          "review_panel agents_selected=4 agents_completed=4 mode=FULL:mode" \
          "ci_gate result=PASS rc=0 checks=7:checks" \
          "liveness decision=DEFER why=lease:decision"; do
  reset; FORGE_PR=9 forge_emit ${fx%%:*}
  key=${fx##*:}; ev=${fx%% *}
  check "fixture $ev event" "$(grep '^{' "$TD/posted" | jq -r '.event')" "$ev"
  check "fixture $ev key $key" "$(grep '^{' "$TD/posted" | jq -r --arg k "$key" 'has($k)')" "true"
done
reset; FORGE_PR=9 forge_emit finding_disposition severity=MEDIUM scope=introduced disposition=INPR_FIX
check "finding_disposition carries scope" "$(grep '^{' "$TD/posted" | jq -r '.scope')" "introduced"
# review-side events go to the PR, others to the issue
reset; FORGE_PR=9 forge_emit review_panel mode=FULL; grep -q 'issues/9/comments' "$TD/calls" && ok || bad "review_panel targets PR"
reset; FORGE_PR=9 forge_emit diff_size lines=1; grep -q 'issues/5/comments' "$TD/calls" && ok || bad "diff_size targets issue"

# 2. Sanitising: reserved keys, bad keys, backticks and newlines never reach the record.
reset
forge_emit x repo=evil 'a b=1' ok='a`b
c'
REC=$(grep '^{' "$TD/posted")
check "reserved key ignored" "$(printf '%s' "$REC" | jq -r '.repo')" "o/r"
check "value sanitised" "$(printf '%s' "$REC" | jq -r '.ok')" "a_b c"
check "bad key dropped" "$(printf '%s' "$REC" | jq 'has("a b")')" "false"

# 3. Upsert edits the single trusted comment in place; an untrusted one is ignored.
reset; forge_emit ci_gate result=PASS; set_comments "$(cat "$TD/posted")"
forge_emit liveness decision=PROCEED
check "upsert patches" "$(nrec "$(cat "$TD/patched")")" "2"
check "no second post" "$(grep -c 'POST' "$TD/calls")" "1"
reset; forge_emit ci_gate result=PASS; set_comments "$(cat "$TD/posted")" User; rm -f "$TD/posted"
forge_emit liveness decision=PROCEED
[ -f "$TD/posted" ] && [ ! -f "$TD/patched" ] && ok || bad "untrusted comment must not be patched"

# 4. Rollover to part=N near the size limit.
reset; forge_emit ci_gate result=PASS; set_comments "$(cat "$TD/posted")"; rm -f "$TD/posted"
FORGE_TELEMETRY_MAX_CHARS=200 forge_emit liveness decision=PROCEED
check "rollover header" "$(head -n 1 "$TD/posted")" "<!-- FORGE:TELEMETRY v1 part=2 -->"

# 5. Buffer on failure, flush on next emit, nothing lost.
reset
FORGE_TELEMETRY_GH="$TD/gh-fail" forge_emit diff_size lines=1
check "buffered" "$(ls "$TD/buf")" "o_r__5.jsonl"
forge_emit diff_size lines=2
check "flushed both records" "$(nrec "$(cat "$TD/posted")")" "2"
[ ! -e "$TD/buf/o_r__5.jsonl" ] && ok || bad "buffer removed after flush"

# 6. Never fails the caller: unwritable buffer dir, no gh, kill switch, bad event name, caller options intact.
reset; : > "$TD/afile"
FORGE_TELEMETRY_GH=/nonexistent FORGE_TELEMETRY_BUFFER_DIR="$TD/afile/buf" forge_emit diff_size lines=1; check "unwritable dir rc" "$?" "0"
OUT=$(set -e; forge_emit ci_gate result=PASS; echo still-running); check "caller set -e survives" "$OUT" "still-running"
check "stdout silent" "$(forge_emit ci_gate result=PASS 2>&1)" ""
reset; FORGE_TELEMETRY=off forge_emit ci_gate result=PASS; [ ! -e "$TD/calls" ] && ok || bad "FORGE_TELEMETRY=off must not call gh"
reset; forge_emit 'bad event!' a=1; [ ! -e "$TD/calls" ] && ok || bad "bad event name dropped"
reset; (unset FORGE_ISSUE; forge_emit ci_gate result=PASS); [ ! -e "$TD/calls" ] && ok || bad "no target dropped"

# 7. Exec'd CLI form used by spec call sites.
reset; bash "$LIB" ci_gate result=PASS; check "cli rc" "$?" "0"; [ -f "$TD/posted" ] && ok || bad "cli form emits"

echo "telemetry.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
