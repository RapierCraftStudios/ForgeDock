#!/usr/bin/env bash
# publish-staging-sync.test.sh — guards the publish.yml "Sync version to staging" step (forge#3695)
# and the deploy-pr Phase 2A.5 version-sync pre-flight. Static assertions, no network.
# Usage: bash scripts/publish-staging-sync.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUB="$ROOT/.github/workflows/publish.yml"
DEP="$ROOT/commands/deploy-pr.md"

PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }
has() { if grep -qF -e "$2" "$3"; then ok "$1"; else bad "$1 (missing '$2')"; fi; }

# Extract the sync step block (from its name line to the next step's name line).
STEP=$(awk '/- name: Sync version to staging/{f=1;print;next} f&&/^      - name: /{exit} f{print}' "$PUB")
[ -n "$STEP" ] && ok "publish.yml has the Sync version to staging step" || bad "publish.yml has the Sync version to staging step"

L_PUSH=$(grep -n -- '- name: Push version bump' "$PUB" | head -1 | cut -d: -f1)
L_SYNC=$(grep -n -- '- name: Sync version to staging' "$PUB" | head -1 | cut -d: -f1)
L_REL=$(grep -n -- '- name: Create GitHub Release' "$PUB" | head -1 | cut -d: -f1)
if [ -n "$L_PUSH" ] && [ -n "$L_SYNC" ] && [ -n "$L_REL" ] && [ "$L_PUSH" -lt "$L_SYNC" ] && [ "$L_SYNC" -lt "$L_REL" ]; then
  ok "sync step sits between Push version bump and Create GitHub Release"
else bad "sync step sits between Push version bump and Create GitHub Release"; fi

stepHas() { if printf '%s\n' "$STEP" | grep -qF -e "$2"; then ok "$1"; else bad "$1 (missing '$2')"; fi; }
stepHas "step fetches origin/staging" "origin/staging"
stepHas "step pushes HEAD to staging" "git push origin HEAD:staging"
stepHas "step is non-fatal" "continue-on-error: true"
stepHas "step is guarded by SKIP_PUBLISH" "env.SKIP_PUBLISH != 'true'"
stepHas "commit carries [skip ci]" "[skip ci]"
stepHas "only version files are staged" "git add package.json .claude-plugin/plugin.json"
stepHas "failure emits a warning" "::warning::"
if printf '%s\n' "$STEP" | grep -qE 'git (merge|pull)'; then bad "step must not merge main (version-only commit)"; else ok "step does not merge main"; fi

has "deploy-pr has the 2A.5 pre-flight" "### 2A.5: Version Sync Pre-flight" "$DEP"
has "deploy-pr pre-flight compares package.json" "package.json" "$DEP"

if git -C "$ROOT" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  if git -C "$ROOT" diff --quiet origin/main -- .github/workflows/version-guard.yml; then ok "version-guard.yml unchanged"; else bad "version-guard.yml unchanged"; fi
fi

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
