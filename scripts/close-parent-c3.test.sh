#!/usr/bin/env bash
# close-parent-c3.test.sh — Phase C3 (close.md) behaviour for decomposition.close_parent:
# the last child of a CLOSED parent posts "All sub-issues complete" and sets merged
# without closing or reopening; an OPEN parent is auto-closed as before.
#
# Usage: bash scripts/close-parent-c3.test.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOSE="$ROOT/commands/work-on/close.md"

# The all-children-checked-off branch of C3.
BLOCK=$(awk '/^if \[ "\$OPEN_SUBS" -eq 0 \]; then/{p=1} p{print} p&&/^fi$/{exit}' "$CLOSE")
[ -n "$BLOCK" ] || { printf 'FAIL: close.md C3 completion block not found\n' >&2; exit 1; }
grep -q 'close_parent' "$CLOSE" || { printf 'FAIL: close.md does not mention close_parent\n' >&2; exit 1; }

run_case() {
  local parent_state="$1" already_posted="$2" log
  log=$(mktemp)
  gh() {
    case "$1 $2" in
      "issue view") echo "$parent_state" ;;
      "api repos/"*) echo "$already_posted" ;;
      *) echo "gh $*" >>"$log" ;;
    esac
  }
  set_workflow_state() { echo "set_workflow_state $*" >>"$log"; }
  # Render the spec placeholders.
  local rendered
  rendered=$(printf '%s\n' "$BLOCK" | sed -e 's/{GH_FLAG}/-R o\/r/g' -e 's/{GH_REPO}/o\/r/g' -e 's/{NUMBER}/7/g')
  OPEN_SUBS=0 PARENT_REF=5 PR_NUMBER=9 PARENT_CLOSED=false
  eval "$rendered"
  cat "$log"; rm -f "$log"
}

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

OUT=$(run_case CLOSED 0)
printf '%s\n' "$OUT" | grep -q 'gh issue comment 5 .*All sub-issues complete' || fail "closed parent: completion comment missing"
printf '%s\n' "$OUT" | grep -q 'set_workflow_state 5 merged' || fail "closed parent: merged not set"
printf '%s\n' "$OUT" | grep -q 'gh issue close' && fail "closed parent: must not be closed again"
printf '%s\n' "$OUT" | grep -qE 'reopen|--state open' && fail "closed parent: must not be reopened"

OUT=$(run_case CLOSED 1)
printf '%s\n' "$OUT" | grep -q 'gh issue comment' && fail "closed parent: completion comment must not repeat"
printf '%s\n' "$OUT" | grep -q 'set_workflow_state 5 merged' || fail "closed parent resume: merged not set"

OUT=$(run_case OPEN 0)
printf '%s\n' "$OUT" | grep -q 'gh issue close 5 .*All sub-issues complete' || fail "open parent: must be auto-closed"
printf '%s\n' "$OUT" | grep -q 'set_workflow_state 5 merged' || fail "open parent: merged not set"
printf '%s\n' "$OUT" | grep -q 'gh issue comment' && fail "open parent: no separate comment expected"

# ---- Verified-retry checkbox write + state-derived OPEN_SUBS (concurrent sibling close race) ----
WRITE_BLOCK=$(awk '/^PARENT_UPDATED=false$/{p=1} p{print} p&&/^\[ "\$PARENT_UPDATED" = true \]/{exit}' "$CLOSE")
DERIVE_BLOCK=$(awk '/^PARENT_FRESH=/{p=1} p{print} p&&/^OPEN_SUBS=\$\{OPEN_SUBS:-0\}$/{exit}' "$CLOSE")
[ -n "$WRITE_BLOCK" ] || fail "close.md C3 verified-retry write block not found"
[ -n "$DERIVE_BLOCK" ] || fail "close.md C3 state-derivation block not found"

# run_derive <parent body> <states "N=STATE ..."> [lost_edits]
# gh stub: parent body lives in a file; the first <lost_edits> edits are clobbered by a stale sibling write.
run_derive() {
  local body="$1" states="$2" lost="${3:-0}" dir rendered
  dir=$(mktemp -d)
  printf '%s\n' "$body" >"$dir/body"; printf '%s\n' "$body" >"$dir/stale"
  echo 0 >"$dir/edits"
  gh() {
    case "$1 $2" in
      "issue view")
        if [ "$6" = "--json" ] && [ "$7" = "body" ]; then cat "$dir/body"; return 0; fi
        if [ "$6" = "--json" ] && [ "$7" = "state" ]; then
          local kv; for kv in $states; do [ "${kv%%=*}" = "$3" ] && { echo "${kv#*=}"; return 0; }; done
          return 1
        fi ;;
      "issue edit")
        local n; n=$(( $(cat "$dir/edits") + 1 )); echo "$n" >"$dir/edits"
        if [ "$n" -le "$lost" ]; then cp "$dir/stale" "$dir/body"; else printf '%s\n' "$7" >"$dir/body"; fi ;;
    esac
  }
  sleep() { :; }
  rendered=$(printf '%s\n%s\n' "$WRITE_BLOCK" "$DERIVE_BLOCK" | sed -e 's/{GH_FLAG}/-R o\/r/g' -e 's/{GH_REPO}/o\/r/g' -e 's/{NUMBER}/7/g')
  PARENT_REF=5
  eval "$rendered" >/dev/null 2>&1 || true
  printf 'OPEN_SUBS=%s UPDATED=%s EDITS=%s CHECKED7=%s\n' "$OPEN_SUBS" "$PARENT_UPDATED" "$(cat "$dir/edits")" \
    "$(grep -cE '^- \[x\] #7( |$)' "$dir/body" || true)"
  rm -rf "$dir"; unset -f gh sleep
}

TWO=$'- [ ] #7 first\n- [ ] #8 second'

# Lost checkbox is re-applied by the retry loop (first write clobbered by a sibling).
OUT=$(run_derive "$TWO" "7=CLOSED 8=CLOSED" 1)
printf '%s\n' "$OUT" | grep -q 'CHECKED7=1' || fail "retry: checkbox not restored after a lost write ($OUT)"
printf '%s\n' "$OUT" | grep -q 'UPDATED=true' || fail "retry: PARENT_UPDATED not set ($OUT)"
printf '%s\n' "$OUT" | grep -q 'EDITS=2' || fail "retry: expected exactly 2 writes ($OUT)"

# Race: every write is lost, boxes stay unchecked, but all subs are CLOSED => 0 open (parent completes).
OUT=$(run_derive "$TWO" "7=CLOSED 8=CLOSED" 9)
printf '%s\n' "$OUT" | grep -q 'OPEN_SUBS=0' || fail "race: stale checklist with all subs CLOSED must derive 0 open ($OUT)"
printf '%s\n' "$OUT" | grep -q 'EDITS=3' || fail "race: retries must be bounded at 3 writes ($OUT)"

# A still-OPEN sibling keeps the parent open.
OUT=$(run_derive "$TWO" "7=CLOSED 8=OPEN")
printf '%s\n' "$OUT" | grep -q 'OPEN_SUBS=1' || fail "one open sibling must derive 1 open ($OUT)"

# State lookup failure falls back to the checklist count (fail closed, never 0 from a failed lookup).
OUT=$(run_derive "$TWO" "7=CLOSED")
printf '%s\n' "$OUT" | grep -q 'OPEN_SUBS=1' || fail "lookup failure must fall back to checklist count ($OUT)"

# Already-checked box: no write needed.
OUT=$(run_derive $'- [x] #7 first\n- [ ] #8 second' "7=CLOSED 8=CLOSED")
printf '%s\n' "$OUT" | grep -q 'EDITS=0' || fail "already checked: must not rewrite the parent ($OUT)"

# #7 must not match #70.
OUT=$(run_derive $'- [ ] #70 other\n- [ ] #7 first' "7=CLOSED 70=OPEN")
printf '%s\n' "$OUT" | grep -q 'OPEN_SUBS=1' || fail "#70 must stay open and not be confused with #7 ($OUT)"
printf '%s\n' "$OUT" | grep -q 'CHECKED7=1' || fail "#7 checkbox must be checked without touching #70 ($OUT)"

printf 'PASS: close-parent-c3\n'
