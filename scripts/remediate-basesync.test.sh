#!/usr/bin/env bash
# remediate-basesync.test.sh — spec guard for the Phase M3 base-sync block in commands/work-on/remediate.md (forge#3515)
# Asserts rc capture, MERGE_HEAD classification/guard, distinct refused blocker, sync-before-edits ordering,
# clean-tree precondition, and a scratch-repo check of the git behaviour the spec relies on. No network.
# Usage: bash scripts/remediate-basesync.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SPEC="$ROOT/commands/work-on/remediate.md"

PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
has() { if grep -qE -- "$2" "$SPEC"; then ok "$1"; else bad "$1"; fi; }

has "merge rc captured into MERGE_RC" 'MERGE_RC=\$\?'
has "MERGE_HEAD guard present" 'git rev-parse -q --verify MERGE_HEAD'
has "distinct refused-merge blocker" 'base-sync: merge refused'
has "ordering: sync before any other FIXABLE edit" 'before any (other )?(FIXABLE|fix) edit'
has "clean-tree precondition" 'git diff --quiet'
has "empty CONFLICT_FILES fallback" 'CONFLICT_FILES="\(no conflicted files'
has "unresolvable blocker unchanged" 'base-sync: unresolvable conflicts'
has "FORGE:BASESYNC_FAILED marker kept" 'FORGE:BASESYNC_FAILED'
if grep -nE '^[[:space:]]*git merge --abort' "$SPEC" >/dev/null; then bad "no bare git merge --abort line"; else ok "no bare git merge --abort line"; fi
if grep -nE 'git merge --abort' "$SPEC" | grep -vq 'MERGE_HEAD'; then bad "every git merge --abort is MERGE_HEAD-guarded"; else ok "every git merge --abort is MERGE_HEAD-guarded"; fi
# Unannotated side-effect lines would trip the #3541 gate
if grep -E 'git merge (origin|--abort)' "$SPEC" | grep -v 'allowlist:check-command-side-effects' | grep -vq '^[[:space:]]*$'; then
  grep -E 'git merge (origin|--abort)' "$SPEC" | grep -v 'allowlist:check-command-side-effects' | grep -qE '^[[:space:]]*(MERGE_OUT=|git merge|if git rev-parse)' && bad "side-effect lines annotated" || ok "side-effect lines annotated"
else ok "side-effect lines annotated"; fi

# Behavioural: dirty tree + base change -> refused (rc!=0, no MERGE_HEAD, empty U-list); real conflict -> MERGE_HEAD present.
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
(
  cd "$T" && git init -q -b main . && git config user.email t@t && git config user.name t
  echo a > f && git add f && git commit -qm base
  git checkout -qb feat && git checkout -q main && echo b > f && git commit -qam basechange
  git checkout -q feat && echo local > f
  out=$(git merge main --no-edit 2>&1); echo "$? $(git rev-parse -q --verify MERGE_HEAD >/dev/null && echo head || echo nohead) [$(git diff --name-only --diff-filter=U)]" > "$T/refused.out"
  git checkout -q -- f && echo c > f && git commit -qam featchange
  git merge main --no-edit >/dev/null 2>&1; echo "$? $(git rev-parse -q --verify MERGE_HEAD >/dev/null && echo head || echo nohead)" > "$T/conflict.out"
)
eq "refused merge: rc=1, no MERGE_HEAD, empty conflict list" "$(cat "$T/refused.out")" "1 nohead []"
eq "real conflict: rc=1 with MERGE_HEAD" "$(cat "$T/conflict.out")" "1 head"

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
