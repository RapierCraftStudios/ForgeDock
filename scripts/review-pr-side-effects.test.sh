#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# forge#5238: the always-on security reviewer must carry a "production side effects x frequency" step, and a
# #39949-shaped diff (30-minute probe that creates and deletes a real account) must hit its trigger terms.
# Run: bash scripts/review-pr-side-effects.test.sh (bash 3.2 compatible)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SPEC="$ROOT/commands/review-pr-agents/security.md"
pass=0; fail=0
ok() { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/review-pr-side-effects.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

awk '/^### Step 2.10: Production side effects/ {on=1; print; next} on && /^##/ {exit} on {print}' "$SPEC" > "$WORK/step"
[ -s "$WORK/step" ] && ok || bad "security.md has no Step 2.10 production side effects step"
for t in 'runs/day' 'schedule' 'downstream effects' 'idempotent or rate-bounded' 'CONFIRMED HIGH, blocking' 'cron' 'accounts' 'emails'; do
  grep -qF "$t" "$WORK/step" && ok || bad "step missing: $t"
done
grep -qF 'Step 2.10' <(grep '^|' "$SPEC") && ok || bad "coverage matrix has no Step 2.10 row"

# Replay of AlterLab #39949: periodic probe creating and deleting a real account.
cat > "$WORK/diff" <<'D'
+++ b/.github/workflows/agent-journey-probe.yml
+  schedule:
+    - cron: "*/30 * * * *"
+++ b/scripts/agent_journey_probe.py
+    acct = client.post("/api/v1/signup", json={"email": new_email()})
+    ...
+    client.delete(f"/api/v1/account/{acct['id']}")
D
grep -qE 'cron|schedule' "$WORK/diff" && grep -qiE 'signup|account' "$WORK/diff" && grep -qE 'post\(|delete\(' "$WORK/diff" && ok || bad "fixture lacks trigger shape"
for t in cron schedule accounts; do
  grep -qF "$t" "$WORK/step" && grep -qiE "${t%s}" "$WORK/diff" && ok || bad "replay does not reach step term: $t"
done

echo "review-pr-side-effects: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
