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

has "M3 records merged base head" 'BASESYNC_BASE_SHA=\$\(git rev-parse origin/'
has "re-sync rounds hard-capped" 'BASESYNC_MAX_ROUNDS'
has "M6 distinguishes advanced base" 'Base advanced'
has "M8 trail persists base sha" 'Base sync\*\*: ran \(base='
has "rounds derived from pushed sync merges" 'BASESYNC_ROUNDS=\$\(git rev-list --first-parent --merges --count origin/\{PR_BASE\}\.\.origin/\{HEAD_BRANCH\}'
has "unreadable round count treated as the cap" '\|\| BASESYNC_ROUNDS=\$BASESYNC_MAX_ROUNDS'
if grep -qF 'BASESYNC_ROUNDS=$(( ${BASESYNC_ROUNDS:-0}' "$SPEC"; then bad "no shell-state round counter"; else ok "no shell-state round counter"; fi
if grep -qF '[ -n "${BASESYNC_BASE_SHA:-}" ]' "$SPEC"; then bad "freshness pass not gated on a shell var"; else ok "freshness pass not gated on a shell var"; fi
has "freshness push rc checked" 'if git push origin HEAD:\{HEAD_BRANCH\}; then'
has "freshness merge re-gated before push" 'Run the Phase M4 pre-push ancestry guard'
if grep -qF 'do NOT sync a second time' "$SPEC"; then bad "unconditional second-sync refusal removed"; else ok "unconditional second-sync refusal removed"; fi

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

# Advanced base: merge main at T0, main advances, head differs and a second merge is clean; unchanged base keeps the same SHA.
(
  R="$T/adv"; mkdir "$R" && cd "$R" && git init -q -b main . && git config user.email t@t && git config user.name t
  echo a > f && git add f && git commit -qm base
  git checkout -qb feat && echo x > g && git add g && git commit -qm feat
  git checkout -q main && echo b > f && git commit -qam m1 && git checkout -q feat
  git update-ref refs/remotes/origin/main main
  sha0=$(git rev-parse origin/main); git merge origin/main --no-edit >/dev/null 2>&1
  same=$(git rev-parse origin/main)
  git checkout -q main && echo c > h && git add h && git commit -qm sibling && git checkout -q feat
  git update-ref refs/remotes/origin/main main
  sha1=$(git rev-parse origin/main)
  git merge origin/main --no-edit >/dev/null 2>&1; rc=$?
  echo "$([ "$sha0" = "$same" ] && echo unchanged-same || echo unchanged-differs) $([ "$sha0" != "$sha1" ] && echo advanced || echo notadvanced) $rc" > "$T/adv.out"
)
eq "advanced base: SHA differs, unchanged base same, second merge clean" "$(cat "$T/adv.out")" "unchanged-same advanced 0"

# Durable derivation (forge#3517): the M3/M6 lines, run in a fresh shell against a scratch repo, recover rounds and the
# recorded base head from the pushed branch; an unpushed merge does not count.
DERIVE="$(grep -m1 -E '^BASESYNC_ROUNDS=\$\(git rev-list' "$SPEC")"$'\n'"$(grep -m1 -E '^_lm=\$\(git rev-list' "$SPEC")"$'\n'"$(grep -m1 -E '^\[ -n "\$_lm" \]' "$SPEC")"
DERIVE="${DERIVE//\{PR_BASE\}/main}"; DERIVE="${DERIVE//\{HEAD_BRANCH\}/feat}"
(
  R="$T/derive"; mkdir "$R" && cd "$R" && git init -q -b main . && git config user.email t@t && git config user.name t
  derive() { BASESYNC_MAX_ROUNDS=2; eval "$DERIVE"; echo "$BASESYNC_ROUNDS ${_p2:-none}"; }
  echo a > f && git add f && git commit -qm base
  git checkout -qb feat && echo x > g && git add g && git commit -qm feat
  git update-ref refs/remotes/origin/main main; git update-ref refs/remotes/origin/feat feat
  r0=$(derive)
  git checkout -q main && echo b > f && git commit -qam m1 && git checkout -q feat
  git update-ref refs/remotes/origin/main main; b1=$(git rev-parse main)
  git merge origin/main --no-edit >/dev/null 2>&1
  r_unpushed=$(derive)
  git update-ref refs/remotes/origin/feat feat
  r1=$(derive)
  echo "$r0|$r_unpushed|$r1|$b1" > "$T/derive.out"
)
IFS='|' read -r D0 DU D1 B1 < "$T/derive.out"
eq "derive: no sync merge -> 0 rounds, no recorded head" "$D0" "0 none"
eq "derive: unpushed merge does not count" "$DU" "0 none"
eq "derive: pushed sync merge -> 1 round, recorded head = merged base" "$D1" "1 $B1"

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
