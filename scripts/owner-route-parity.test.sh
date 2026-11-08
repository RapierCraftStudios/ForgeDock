#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Release review #5103 (QA-3, BUG-2): scripts/file-deferred-followups.sh owner_route must agree with
# bin/lean/conformance.mjs ownerRoute on every case, including the over-broad matches the review found.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
eval "$(sed -n '/^ROUTE_CLI=/,/^host_route()/p' "$ROOT/scripts/file-deferred-followups.sh")"
PASS=0; FAIL=0
while IFS='|' read -r want why; do
  [ -z "$why" ] && continue
  sh=$(owner_route "$why")
  js=$(node -e 'import(process.argv[1]).then(m=>console.log(m.ownerRoute({bucket:"owner:x", why: process.argv[2]})))' "$ROOT/bin/lean/conformance.mjs" "$why")
  if [ "$sh" = "$want" ] && [ "$js" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: '$why' want=$want sh=$sh js=$js"; fi
done <<'CASES'
host|read-only production telemetry from ovh
host|ssh ovh-monitor to capture the queue depth
host|obs-psql count of the jobs table
host|run a production query against the replica
host|capture production logs for the failing run
host|prod query of the job table
external|Should we delete production data older than 90 days?
external|add uptime-monitor dashboard
external|needs the production database password to query prod data
external|needs the prod ssh key to read production logs
external|product manager decides the pricing page
external|production dataset retention policy
external|provide the Stripe API key, needed before rollout
external|ssh ovh-monitor and restart the worker
external|rotate the prod monitor webhook
external|update the production telemetry config
external|remove the stale prod monitor alert
external|grant read-only prod access to the analyst
external|alter the production query timeout
post-deploy|verify the dashboard after release
CASES
# #5197: host_route goes through the same JS source as hostRoute; cases cover the pre-promotion and external-need guards.
while IFS='|' read -r want why; do
  [ -z "$why" ] && continue
  sh=$(host_route "$why")
  js=$(node -e 'import(process.argv[1]).then(m=>console.log(m.hostRoute({bucket:"host", why: process.argv[2]})))' "$ROOT/bin/lean/conformance.mjs" "$why")
  if [ "$sh" = "$want" ] && [ "$js" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL(host): '$why' want=$want sh=$sh js=$js"; fi
done <<'CASES'
post-deploy|verify the dashboard after release
post-deploy|check the queue depth after promotion
host|capture the queue depth before promotion
host|read the logs pre-release, then promote
host|provide the API key after release
host|capture production logs
CASES
# The shell must not carry its own copy of the routing patterns.
if grep -qE '^(POSTPROM|PREPROM|EXTNEED|ROPROD)_ERE=' "$ROOT/scripts/file-deferred-followups.sh"; then FAIL=$((FAIL+1)); echo "FAIL: file-deferred-followups.sh re-declares a routing ERE"; fi
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
