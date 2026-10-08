#!/usr/bin/env bash
# close-dossier-no-main-commit.test.sh — close.md Phase C1.7 must never write or commit in the main checkout.
#
# Static asserts on the spec plus execution of the real extracted C1.7 block
# against a temp repo with a bare origin and a stubbed gh.
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
printf '%s\n' "$C17" | grep -q 'force-with-lease' && ok "C1.7 pushes with --force-with-lease" || bad "C1.7 missing force-with-lease"
printf '%s\n' "$C17" | grep -qE 'push .*--force( |$)' && bad "C1.7 uses bare --force" || ok "C1.7 has no bare --force"
printf '%s\n' "$C17" | grep -q 'gh pr list' && ok "C1.7 checks for an existing open PR" || bad "C1.7 missing gh pr list"
printf '%s\n' "$C17" | grep -q 'realpath -m' && printf '%s\n' "$C17" | grep -q 'TMP_REAL}/' && ok "C1.7 has realpath containment against the temp worktree" || bad "C1.7 missing realpath containment"
printf '%s\n' "$C17" | grep -qF -- '-L "$DOSSIER_ABS"' && ok "C1.7 rejects a symlinked dossier target" || bad "C1.7 missing -L check on DOSSIER_ABS"
grep -q 'FORGE:DOSSIER_UPDATED' "$CLOSE_MD" && ok "FORGE:DOSSIER_UPDATED marker kept" || bad "FORGE:DOSSIER_UPDATED marker missing"

# --- Dynamic: execute the REAL C1.7 block extracted from close.md (gh stubbed) ---
BLOCK=$(printf '%s\n' "$C17" | awk '/^```bash/{f=1;next} /^```/{f=0} f')
if [ -z "$BLOCK" ]; then
  bad "could not extract the C1.7 bash block"
elif ! command -v perl >/dev/null 2>&1 || ! yq --version 2>&1 | grep -q 'mikefarah'; then
  bad "dynamic section needs perl and mikefarah yq v4 (not silently skipped)"
else
printf '%s\n' "$BLOCK" | grep -q '^_dossier_run()' && printf '%s\n' "$BLOCK" | grep -q '^_dossier_cleanup()' \
  && ok "extracted block defines _dossier_run and _dossier_cleanup" || bad "extracted block missing _dossier_run/_dossier_cleanup"

# Substitute only the exact {NAME} placeholders; leave ${NAME} shell expansions intact.
printf '%s\n' "$BLOCK" | perl -pe 's/(?<!\$)\{GH_REPO\}/o\/r/g; s/(?<!\$)\{NUMBER\}/1/g; s/(?<!\$)\{PR_NUMBER\}/2/g; s/(?<!\$)\{GH_FLAG\}/-R o\/r/g' > "$TMP/block.sh"
bash -n "$TMP/block.sh" && ok "substituted C1.7 block parses (bash -n)" || bad "substituted C1.7 block has a syntax error"

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
git init -q --bare "$TMP/origin.git"
git init -q -b staging "$TMP/main"
mkdir -p "$TMP/main/devdocs/modules"
echo seed > "$TMP/main/devdocs/modules/m.md"
printf 'modules:\n  - name: m\n    glob: "*.sh"\n    path: modules/m.md\n' > "$TMP/main/devdocs/index.yaml"
git -C "$TMP/main" add -A && git -C "$TMP/main" commit -q -m seed
git -C "$TMP/main" remote add origin "$TMP/origin.git"
git -C "$TMP/main" push -q origin staging 2>/dev/null

# gh stub: never touches the network; every call is logged.
mkdir -p "$TMP/bin" "$TMP/tmpd" "$TMP/cwd"
cat > "$TMP/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
case "$1 $2" in
  "api repos/o/r/issues/1/comments")
    printf '<!-- FORGE:BUILDER -->\n### Changes\n- `scripts/foo.sh` changed\n### Next\n' ;;
  "pr view") echo "Test PR title" ;;
  "pr list")
    echo "pr-list worktrees: $(git -C "$REPO_PATH" worktree list | wc -l)" >> "$GH_LOG"
    [ "${GH_KILL_ON_PR_LIST:-}" = 1 ] && kill -TERM "$(cat "$PIDF")" && sleep 1
    echo "${GH_PR_LIST_URL:-}" ;;
  "pr create") [ "${GH_FAIL_PR_CREATE:-}" = 1 ] && exit 1; echo "https://example.invalid/o/r/pull/9" ;;
esac
exit 0
GHEOF
chmod +x "$TMP/bin/gh"
export GH_LOG="$TMP/gh.log" PIDF="$TMP/pid" REPO_PATH="$TMP/main" PR_BASE=staging NUMBER=1
[ "$(PATH="$TMP/bin:$PATH" command -v gh)" = "$TMP/bin/gh" ] && ok "gh resolves to the stub" || bad "gh stub not first on PATH"

HEAD_BEFORE=$(git -C "$TMP/main" rev-parse HEAD)
BRANCH_BEFORE=$(git -C "$TMP/main" branch --show-current)

# run_block: executes the real block in a fresh bash, cwd without forge.yaml.
run_block() { : > "$GH_LOG"; ( cd "$TMP/cwd" && env PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tmpd" "$@" bash -c 'echo $$ > "$PIDF"; source "$1"' _ "$TMP/block.sh" ) > "$TMP/out.log" 2>&1; }
main_untouched() {
  [ "$(git -C "$TMP/main" rev-parse HEAD)" = "$HEAD_BEFORE" ] && [ "$(git -C "$TMP/main" branch --show-current)" = "$BRANCH_BEFORE" ] \
    && [ -z "$(git -C "$TMP/main" status --porcelain)" ]
}
no_leak() {
  [ -z "$(ls -A "$TMP/tmpd" 2>/dev/null)" ] && [ "$(git -C "$TMP/main" worktree list | wc -l)" -eq 1 ]
}

# Scenario A: happy path
run_block; RC=$?
[ "$RC" -eq 0 ] && ok "A: real block exits 0" || bad "A: real block exit $RC"
main_untouched && ok "A: main checkout untouched (HEAD, branch, clean tree)" || bad "A: main checkout modified"
git -C "$TMP/origin.git" rev-parse -q --verify refs/heads/docs/dossier-1 >/dev/null && ok "A: dossier branch pushed to origin" || bad "A: dossier branch not pushed"
git -C "$TMP/origin.git" show refs/heads/docs/dossier-1:devdocs/modules/m.md 2>/dev/null | grep -q '^## Entry' && ok "A: dossier entry appended on pushed branch" || bad "A: no entry on pushed branch"
grep -q '^gh pr create' "$GH_LOG" && ok "A: gh pr create called" || bad "A: gh pr create not called"
grep -q 'FORGE:DOSSIER_UPDATED' "$GH_LOG" && ok "A: FORGE:DOSSIER_UPDATED comment posted" || bad "A: no FORGE:DOSSIER_UPDATED comment"
no_leak && ok "A: temporary worktree removed" || bad "A: temporary worktree leaked"

# Scenario B: retry over the existing remote branch (real fetch + --force-with-lease)
OLD=$(git -C "$TMP/origin.git" rev-parse refs/heads/docs/dossier-1)
sleep 1  # commit SHAs embed second-resolution timestamps; ensure the retry differs
run_block; RC=$?
NEW=$(git -C "$TMP/origin.git" rev-parse refs/heads/docs/dossier-1)
[ "$RC" -eq 0 ] && [ "$OLD" != "$NEW" ] && ok "B: retry push over existing remote branch succeeds" || bad "B: retry push failed (rc=$RC)"
main_untouched && no_leak && ok "B: main untouched and worktree removed" || bad "B: main modified or worktree leaked"

# Scenario C: fault injection - SIGTERM after worktree add, before the explicit cleanup.
# Only the block's real EXIT trap can remove the worktree.
run_block GH_KILL_ON_PR_LIST=1 2>/dev/null
grep -q '^pr-list worktrees: 2' "$GH_LOG" && ok "C: worktree existed when the fault fired" || bad "C: fault did not fire after worktree add (vacuous)"
grep -q '^gh pr create' "$GH_LOG" && bad "C: block continued past the injected fault" || ok "C: block aborted before pr create"
no_leak && ok "C: real EXIT trap cleaned the worktree" || bad "C: worktree leaked after abort (EXIT trap regression)"
main_untouched && ok "C: main checkout untouched" || bad "C: main checkout modified"

# Scenario D: gh pr create fails - block still exits 0, logs a skip, cleans up
run_block GH_FAIL_PR_CREATE=1; RC=$?
[ "$RC" -eq 0 ] && grep -q 'skipped - gh pr create failed' "$TMP/out.log" && ok "D: pr create failure logged as skip, exit 0" || bad "D: pr create failure not handled"
grep -q 'issue comment' "$GH_LOG" && bad "D: annotation posted despite no PR" || ok "D: no annotation without a PR"
no_leak && ok "D: worktree removed" || bad "D: worktree leaked"
fi

echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
