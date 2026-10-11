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

printf 'PASS: close-parent-c3\n'
