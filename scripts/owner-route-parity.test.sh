#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Release review #5103 (QA-3, BUG-2): scripts/file-deferred-followups.sh owner_route must agree with
# bin/lean/conformance.mjs ownerRoute on every case, including the over-broad matches the review found.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
eval "$(sed -n '/^POSTPROM_ERE=/,/^}/p' "$ROOT/scripts/file-deferred-followups.sh")"
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
post-deploy|verify the dashboard after release
CASES
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
