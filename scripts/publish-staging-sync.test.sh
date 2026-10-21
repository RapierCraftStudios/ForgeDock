#!/usr/bin/env bash
# publish-staging-sync.test.sh — guards the publish.yml "Sync version to staging" step (forge#3695, forge#4357)
# and the deploy-pr Phase 2A.5 version-sync pre-flight. Static assertions plus a local-only run of the step (bare origin, stub gh); no network.
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
stepHas "step is non-fatal" "continue-on-error: true"
stepHas "step is guarded by SKIP_PUBLISH" "env.SKIP_PUBLISH != 'true'"
# forge#4357: staging is protected (GH006), so the sync goes through a PR, never a direct push.
stepHas "step pushes to a chore/sync-version-X.Y.Z branch" 'SYNC_BRANCH="chore/sync-version-${VERSION}"'
stepHas "step force-pushes the sync branch" 'git push -f origin "HEAD:refs/heads/$SYNC_BRANCH"'
stepHas "step looks up an existing sync PR" 'gh pr list --head "$SYNC_BRANCH" --base staging'
stepHas "step opens a PR to staging" 'gh pr create --base staging --head "$SYNC_BRANCH"'
stepHas "step authenticates gh" 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'
stepHas "step skips when staging is at or above the version" "nothing to sync"
if printf '%s\n' "$STEP" | grep -E 'git push' | grep -qE 'HEAD:staging|refs/heads/staging|origin staging'; then
  bad "step must not push directly to staging"; else ok "step does not push directly to staging"; fi
if printf '%s\n' "$STEP" | grep -E 'git commit' | grep -qF '[skip ci]'; then
  bad "sync commit (PR head) must not carry [skip ci]"; else ok "sync commit does not carry [skip ci]"; fi
PERMS=$(awk '/^    permissions:/{f=1;next} f&&/^    [a-z]/{exit} f{print}' "$PUB")
if printf '%s\n' "$PERMS" | grep -qE '^ +pull-requests: write'; then ok "publish job grants pull-requests: write"; else bad "publish job grants pull-requests: write"; fi
stepHas "only version files are staged" "git add package.json .claude-plugin/plugin.json"
stepHas "failure emits a warning" "::warning::"
if printf '%s\n' "$STEP" | grep -qE 'git (merge|pull)'; then bad "step must not merge main (version-only commit)"; else ok "step does not merge main"; fi

# Behavioural: run the step's script against a local bare origin with a stub gh.
RUN=$(printf '%s\n' "$STEP" | awk '/^        run: \|/{f=1;next} f{sub(/^          /,"");print}')
SB=$(mktemp -d "${TMPDIR:-/tmp}/pubsync.XXXXXX")
trap 'rm -rf "$SB"' EXIT
(
  set -e
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
  git init -q --bare "$SB/origin.git"
  git init -q -b staging "$SB/seed"; cd "$SB/seed"
  mkdir .claude-plugin
  echo '{"name":"x","version":"1.9.0"}' > package.json
  echo '{"name":"x","version":"1.9.0"}' > .claude-plugin/plugin.json
  echo keep > other.txt
  git add -A; git commit -qm seed; git push -q "$SB/origin.git" staging
  git clone -q -b staging "$SB/origin.git" "$SB/work"
  mkdir "$SB/bin"
  printf '#!/bin/sh\necho "$*" >> "%s/gh.log"\ncase "$2" in create) echo https://example.test/pr/1;; list) [ -z "$GH_STUB_LIST" ] || echo "$GH_STUB_LIST";; esac\n' "$SB" > "$SB/bin/gh"
  chmod +x "$SB/bin/gh"
) >/dev/null 2>&1 || bad "behavioural sandbox setup"
runStep() { (cd "$SB/work" && PATH="$SB/bin:$PATH" RUNNER_TEMP="$SB/rt" VERSION="$1" bash -c "$RUN") >"$SB/out" 2>&1; }
mkdir -p "$SB/rt"
STAGING_BEFORE=$(git -C "$SB/origin.git" rev-parse staging 2>/dev/null)
if runStep 1.10.0; then ok "step exits 0"; else bad "step exits 0"; fi
[ "$(git -C "$SB/origin.git" rev-parse staging 2>/dev/null)" = "$STAGING_BEFORE" ] && ok "staging is not pushed to" || bad "staging is not pushed to"
SYNCV=$(git -C "$SB/origin.git" show chore/sync-version-1.10.0:package.json 2>/dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).version)" 2>/dev/null)
[ "$SYNCV" = "1.10.0" ] && ok "sync branch carries the new version" || bad "sync branch carries the new version (got '$SYNCV')"
CHANGED=$(git -C "$SB/origin.git" diff --name-only staging chore/sync-version-1.10.0 2>/dev/null | sort | tr '\n' ' ')
[ "$CHANGED" = ".claude-plugin/plugin.json package.json " ] && ok "sync commit is version-only" || bad "sync commit is version-only (got '$CHANGED')"
grep -q -- 'pr create --base staging --head chore/sync-version-1.10.0' "$SB/gh.log" 2>/dev/null && ok "gh pr create targets staging" || bad "gh pr create targets staging"
: > "$SB/gh.log"
if GH_STUB_LIST=https://example.test/pr/7 runStep 1.10.0 && grep -q 'Updated existing staging sync PR https://example.test/pr/7' "$SB/out" \
   && ! grep -q 'pr create' "$SB/gh.log"; then
  ok "an open sync PR is updated, not duplicated"; else bad "an open sync PR is updated, not duplicated"; fi
: > "$SB/gh.log"
if runStep 1.9.0 && grep -q 'nothing to sync' "$SB/out" && [ ! -s "$SB/gh.log" ]; then
  ok "skipped when staging is already at the version"; else bad "skipped when staging is already at the version"; fi

has "deploy-pr has the 2A.5 pre-flight" "### 2A.5: Version Sync Pre-flight" "$DEP"
has "deploy-pr pre-flight compares package.json" "package.json" "$DEP"

if git -C "$ROOT" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  if git -C "$ROOT" diff --quiet origin/main -- .github/workflows/version-guard.yml; then ok "version-guard.yml unchanged"; else bad "version-guard.yml unchanged"; fi
fi

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
