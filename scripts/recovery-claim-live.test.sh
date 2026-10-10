#!/usr/bin/env bash
# recovery-claim-live.test.sh — tests for scripts/recovery-claim-live.sh
# No network: `gh` is mocked on PATH; MOCK_GH_JSON names a fixture holding the JSON array
# `gh api .../comments` would return. MOCK_GH_FAIL=1 simulates an outage.
#
# Usage: bash scripts/recovery-claim-live.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/recovery-claim-live.sh"
TMP_BIN=$(mktemp -d); TMP_FX=$(mktemp -d)
trap 'rm -rf "$TMP_BIN" "$TMP_FX"' EXIT

cat > "$TMP_BIN/gh" <<'MOCK'
#!/usr/bin/env bash
if [ "${MOCK_GH_FAIL:-}" = "1" ]; then echo "mock gh: outage" >&2; exit 1; fi
cat "$MOCK_GH_JSON"
MOCK
chmod +x "$TMP_BIN/gh"
export PATH="$TMP_BIN:$PATH"

PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }

now_iso()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
old_iso()  { date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%SZ; }

# fx <name> <json-array>
fx() { echo "$2" > "$TMP_FX/$1.json"; echo "$TMP_FX/$1.json"; }
claim()   { jq -cn --arg id "$1" --arg t "$2" '{body:("<!-- FORGE:RECOVERY_CLAIM -->\n**Sweep: "+$id+"**\nHolder: /recover-orphans"), updated_at:$t}'; }
release() { jq -cn --arg id "$1" --arg t "$2" '{body:("<!-- FORGE:RECOVERY_CLAIM_RELEASED -->\n**Sweep: "+$id+"**\nReleased"), updated_at:$t}'; }
# comment <marker> <second-line> <updated_at>: built by jq, never hand-escaped. macOS /bin/bash 3.2 mis-parses
# escaped double quotes inside "$(fx name "...")", which turned literal JSON fixtures into invalid JSON there.
comment() { jq -cn --arg m "$1" --arg l "$2" --arg t "$3" '{body:("<!-- "+$m+" -->\n"+$l), updated_at:$t}'; }

run() { local f="$1"; shift; OUT=$(MOCK_GH_JSON="$f" bash "$CHECK" 7 -R o/r "$@" 2>/dev/null); RC=$?; }
expect() { # name rc needle
  [ "$RC" -eq "$2" ] && grep -q "$3" <<< "$OUT" && ok "$1" || bad "$1 (rc=$RC out=$OUT)"
}

N=$(now_iso); O=$(old_iso)

run "$(fx live "[$(claim sweep-A "$N")]")";                      expect "fresh claim is LIVE" 1 "CLAIM: LIVE sweep-A"
run "$(fx exp "[$(claim sweep-A "$O")]")";                       expect "expired claim is FREE" 0 "CLAIM: FREE"
run "$(fx rel "[$(claim sweep-A "$N"), $(release sweep-A "$N")]")"; expect "released claim is FREE" 0 "CLAIM: FREE"
run "$(fx relother "[$(claim sweep-A "$N"), $(release sweep-B "$N")]")"; expect "release of another sweep does not free the claim" 1 "CLAIM: LIVE sweep-A"
run "$(fx unkrel "[$(comment FORGE:RECOVERY_CLAIM "no sweep line" "$N"), $(comment FORGE:RECOVERY_CLAIM_RELEASED "no sweep line" "$N")]")"; expect "release with no sweep id does not free an id-less claim" 1 "CLAIM: LIVE unknown"
run "$(fx own "[$(claim sweep-A "$N")]")" --exempt-sweep sweep-A; expect "own sweep id is exempt" 0 "CLAIM: FREE"
run "$(fx other "[$(claim sweep-A "$N")]")" --exempt-sweep sweep-B; expect "other sweep id is not exempt" 1 "CLAIM: LIVE sweep-A"
run "$(fx two "[$(claim sweep-A "$N"), $(claim sweep-B "$N")]")" --exempt-sweep sweep-A; expect "exempting A still sees live B" 1 "CLAIM: LIVE sweep-B"
run "$(fx unk "[$(comment FORGE:RECOVERY_CLAIM "no sweep line" "$N")]")" --exempt-sweep sweep-A; expect "claim with no sweep id is never exempt" 1 "CLAIM: LIVE"
run "$(fx unk2 "[$(comment FORGE:RECOVERY_CLAIM "no sweep line" "$N")]")" --exempt-sweep unknown; expect "--exempt-sweep unknown is rejected" 2 "CLAIM: ERROR"
run "$(fx none '[]')";                                            expect "no comments is FREE" 0 "CLAIM: FREE"
run "$(fx hb "[$(comment FORGE:HEARTBEAT "Phase 3" "$N")]")"; expect "heartbeat alone is not a recovery claim" 0 "CLAIM: FREE"
run "$(fx bad "[$(comment FORGE:RECOVERY_CLAIM "no sweep line" "$N")]")"; expect "malformed claim fails closed (LIVE)" 1 "CLAIM: LIVE"
run "$(fx nodate "[$(comment FORGE:RECOVERY_CLAIM "**Sweep: sweep-A**" garbage)]")"; expect "unparsable updated_at fails closed (LIVE)" 1 "CLAIM: LIVE"

OUT=$(MOCK_GH_FAIL=1 MOCK_GH_JSON=/dev/null bash "$CHECK" 7 -R o/r 2>/dev/null); RC=$?
expect "gh outage is ERROR (exit 2)" 2 "CLAIM: ERROR"
OUT=$(MOCK_GH_JSON="$(fx junk 'not json')" bash "$CHECK" 7 -R o/r 2>/dev/null); RC=$?
expect "unparsable response is ERROR (exit 2)" 2 "CLAIM: ERROR"
OUT=$(bash "$CHECK" 2>/dev/null); RC=$?;                          expect "no args is a usage error" 2 "CLAIM: ERROR"
OUT=$(bash "$CHECK" 7 -R 2>/dev/null); RC=$?;                     expect "-R without value is a usage error" 2 "CLAIM: ERROR"

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
