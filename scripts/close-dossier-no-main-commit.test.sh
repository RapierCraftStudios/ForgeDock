#!/usr/bin/env bash
# close-dossier-no-main-commit.test.sh — close.md Phase C1.7 must never write or commit in the main checkout.
#
# Static asserts on the spec plus a dynamic simulation of the temp-worktree
# sequence (the C1.7 Step 2/3 git commands) in a temp repo with a bare origin.
#
# Usage: bash scripts/close-dossier-no-main-commit.test.sh
# Exit code: 0 if all assertions pass, 1 if any fail.
#
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOSE_MD="$SCRIPT_DIR/../commands/work-on/close.md"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# --- Static asserts on the spec ---
if grep -nE 'git -C "\$\{REPO_PATH\}" (commit|add)' "$CLOSE_MD" >/dev/null; then
  bad "close.md still runs git add/commit against REPO_PATH"
else ok "close.md has no git add/commit against REPO_PATH"; fi

C17=$(sed -n '/^## Phase C1.7/,/^## Phase C1.5/p' "$CLOSE_MD")
if printf '%s\n' "$C17" | grep -nE '^\s*cd "\$\{REPO_PATH\}"' >/dev/null; then
  bad "C1.7 changes directory into REPO_PATH"
else ok "C1.7 does not cd into REPO_PATH"; fi
printf '%s\n' "$C17" | grep -q 'Phase C1.7: skipped' && ok "C1.7 logs skip reasons" || bad "C1.7 missing 'Phase C1.7: skipped'"
printf '%s\n' "$C17" | grep -q 'worktree add --detach' && ok "C1.7 uses a temporary detached worktree" || bad "C1.7 missing temp worktree"
printf '%s\n' "$C17" | grep -q 'gh pr create' && ok "C1.7 opens a PR" || bad "C1.7 missing gh pr create"
[ "$(printf '%s\n' "$C17" | grep -c '^```bash')" -eq 1 ] && ok "C1.7 is a single bash block (no cross-block shell state)" || bad "C1.7 must be exactly one bash block"
printf '%s\n' "$C17" | grep -qE "^\s*trap .*EXIT" && ok "C1.7 registers an EXIT trap" || bad "C1.7 missing EXIT trap"
printf '%s\n' "$C17" | grep -q 'worktree remove --force' && ok "C1.7 cleanup removes the worktree" || bad "C1.7 cleanup missing worktree remove"
ADD_LN=$(printf '%s\n' "$C17" | grep -n 'worktree add --detach' | head -1 | cut -d: -f1)
TRAP_LN=$(printf '%s\n' "$C17" | grep -nE "^\s*trap .*EXIT" | head -1 | cut -d: -f1)
[ -n "$ADD_LN" ] && [ -n "$TRAP_LN" ] && [ "$TRAP_LN" -gt "$ADD_LN" ] && ok "EXIT trap registered after worktree add" || bad "EXIT trap must follow worktree add"
grep -q 'FORGE:DOSSIER_UPDATED' "$CLOSE_MD" && ok "FORGE:DOSSIER_UPDATED marker kept" || bad "FORGE:DOSSIER_UPDATED marker missing"

# --- Dynamic: simulate the temp-worktree sequence ---
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
git init -q --bare "$TMP/origin.git"
git init -q -b staging "$TMP/main"
mkdir -p "$TMP/main/devdocs/modules"
echo seed > "$TMP/main/devdocs/modules/m.md"
git -C "$TMP/main" add -A && git -C "$TMP/main" commit -q -m seed
git -C "$TMP/main" remote add origin "$TMP/origin.git"
git -C "$TMP/main" push -q origin staging 2>/dev/null

HEAD_BEFORE=$(git -C "$TMP/main" rev-parse HEAD)
BRANCH_BEFORE=$(git -C "$TMP/main" branch --show-current)

WT=$(mktemp -d)
git -C "$TMP/main" fetch -q origin staging
git -C "$TMP/main" worktree add --detach "$WT" origin/staging >/dev/null 2>&1
printf '\n## Entry\n' >> "$WT/devdocs/modules/m.md"
git -C "$WT" add devdocs/modules/m.md
git -C "$WT" checkout -q -B docs/dossier-1
git -C "$WT" commit -q -s -m "docs(dossier): test"
git -C "$WT" push -q -u origin docs/dossier-1 2>/dev/null
git -C "$TMP/main" worktree remove --force "$WT"
git -C "$TMP/main" worktree prune

[ "$(git -C "$TMP/main" rev-parse HEAD)" = "$HEAD_BEFORE" ] && ok "main checkout HEAD unchanged" || bad "main checkout HEAD changed"
[ "$(git -C "$TMP/main" branch --show-current)" = "$BRANCH_BEFORE" ] && ok "main checkout branch unchanged" || bad "main checkout branch changed"
[ -z "$(git -C "$TMP/main" status --porcelain)" ] && ok "main checkout working tree clean" || bad "main checkout working tree dirty"
git -C "$TMP/origin.git" rev-parse -q --verify refs/heads/docs/dossier-1 >/dev/null && ok "dossier branch pushed to origin" || bad "dossier branch not pushed"
[ ! -d "$WT" ] && ok "temporary worktree removed" || bad "temporary worktree leaked"

# Dynamic: trap-based cleanup removes the worktree even when the block exits without explicit removal
WT2=$(mktemp -d)
( set -e
  _cl() { git -C "$TMP/main" worktree remove --force "$WT2" >/dev/null 2>&1 || rm -rf "$WT2"; git -C "$TMP/main" worktree prune >/dev/null 2>&1 || true; }
  git -C "$TMP/main" worktree add --detach "$WT2" origin/staging >/dev/null 2>&1
  trap _cl EXIT
  exit 3 ) ; true
[ ! -d "$WT2" ] && ! git -C "$TMP/main" worktree list | grep -qF "$WT2" && ok "EXIT trap cleans worktree on abort" || bad "EXIT trap did not clean worktree"

echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
