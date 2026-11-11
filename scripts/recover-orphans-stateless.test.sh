#!/usr/bin/env bash
# recover-orphans-stateless.test.sh — the #5466 STATELESS branch in commands/recover-orphans.md Phase 2 must
# honour --dry-run and must not re-park an issue a human cleared (#5486). Runs the extracted block with gh mocked.
#
# Usage: bash scripts/recover-orphans-stateless.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEC="$SCRIPT_DIR/../commands/recover-orphans.md"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }

# Block: from the "#5466:" comment through the closing "fi" at two-space indent.
awk '/# #5466: a needs-human annotation/{f=1} f{print} f && /^  fi$/{exit}' "$SPEC" > "$TMP/block.sh"
[ -s "$TMP/block.sh" ] && ok "STATELESS block extracted" || { bad "STATELESS block extracted"; exit 1; }

mkdir "$TMP/bin"
cat > "$TMP/bin/gh" <<'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "api repos/o/r/issues/7/events") cat "$MOCK_EVENTS" ;;
  "issue edit") echo "EDIT $*" >> "$MOCK_LOG" ;;
esac
exit 0
MOCK
chmod +x "$TMP/bin/gh"

ISSUE='{"labels":[],"comments":[{"body":"<!-- FORGE:NEEDS_HUMAN -->\nx","createdAt":"2026-01-01T00:00:00Z"}]}'
NOEV='[]'
CLEARED='[{"event":"unlabeled","label":{"name":"needs-human"},"created_at":"2026-01-02T00:00:00Z"}]'
OLDER='[{"event":"unlabeled","label":{"name":"needs-human"},"created_at":"2025-12-31T00:00:00Z"}]'

# run <dry_run> <events-json>  -> sets LOG (edit calls), ACTION, REASON
run() {
  : > "$TMP/log"; echo "$2" > "$TMP/ev"
  local out
  out=$(PATH="$TMP/bin:$PATH" MOCK_LOG="$TMP/log" MOCK_EVENTS="$TMP/ev" DRY_RUN="$1" ISSUE="$ISSUE" ISSUE_LABELS="" \
    GH_REPO=o/r GH_FLAG="-R o/r" NUM=7 bash -c '
      declare -A DIAG_ACTION DIAG_REASON
      for _ in 1; do
        source "$0"
        echo "FELLTHROUGH"
      done
      echo "ACTION=${DIAG_ACTION[7]:-}"; echo "REASON=${DIAG_REASON[7]:-}"' "$TMP/block.sh" 2>&1)
  LOG=$(cat "$TMP/log"); OUT="$out"
}

run false "$NOEV"
echo "$LOG" | grep -q "add-label needs-human" && ok "live: stateless orphan restored" || bad "live: stateless orphan restored"
run true "$NOEV"
[ -z "$LOG" ] && ok "dry-run: no gh issue edit" || bad "dry-run: no gh issue edit"
echo "$OUT" | grep -q "would restore" && ok "dry-run: reports would-restore" || bad "dry-run: reports would-restore"
run false "$CLEARED"
[ -z "$LOG" ] && echo "$OUT" | grep -q "cleared by a human" && ok "human-cleared: not re-parked" || bad "human-cleared: not re-parked"
run false "$OLDER"
echo "$LOG" | grep -q "add-label needs-human" && ok "removal before annotation: still restored" || bad "removal before annotation: still restored"

echo "passed=$PASS failed=$FAILN"; [ "$FAILN" -eq 0 ]
