#!/usr/bin/env bash
# check-spec-size.test.sh — cases for scripts/check-spec-size.sh (forge#3762).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-spec-size.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }

git init -q --bare "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/w" 2>/dev/null
cd "$TMP/w" || exit 1
git config user.email t@example.com; git config user.name t
mkdir -p commands/work-on
gen() { awk -v n="$1" 'BEGIN{for(i=0;i<n;i++) print "line of spec text number " i}'; }
gen 4000 > commands/review-pr.md          # ~110 KB: 2% ~ 2.2 KB < 4 KB cap
gen 20000 > commands/work-on.md           # ~560 KB: 2% ~ 11 KB, so the 4 KB cap binds
gen 100 > commands/other.md
printf 'HELPER_SCRIPT=""\n' > commands/donor.md
gen 100 > commands/work-on/remediate.md
git add -A; git commit -qm base; git branch -M staging; git push -q origin staging 2>/dev/null
git checkout -q -b feat

reset() { git reset -q --hard origin/staging; git clean -qfd; }
run() { # name want_rc [env...]
  local name="$1" want="$2"; shift 2
  local sum="$TMP/summary"; : > "$sum"
  env GITHUB_STEP_SUMMARY="$sum" PR_LABELS="" PR_HEAD_REF="" PR_BASE_REF="" "$@" bash "$S" origin/staging >"$TMP/out" 2>"$TMP/err"
  local rc=$?
  if [ "$rc" = "$want" ]; then ok; else bad "$name (rc=$rc want $want)"; cat "$TMP/err"; fi
}
has() { grep -qF "$2" "$TMP/summary" && ok || bad "$1 (summary lacks: $2)"; }

reset; run "no change passes" 0
has "summary shows delta table" "| File | Base | Head | Delta |"

reset; gen 100 >> commands/review-pr.md   # +~2.8 KB on ~110 KB = ~2.5% (>2%, <4 KB)
run "over 2% fails" 1; has "over-budget flagged" "OVER BUDGET"

reset; gen 200 >> commands/work-on.md     # +~5.6 KB (<2% of 560 KB, >4 KB)
run "over 4 KB fails" 1

reset; gen 5 >> commands/review-pr.md     # small growth under both limits
run "small growth passes" 0

reset; gen 5000 >> commands/other.md      # not a budgeted spec
run "non-budgeted growth passes" 0

reset; gen 100 > commands/review-pr.md    # shrink
run "shrink passes" 0

reset; printf 'TRUSTED_SCRIPT=""\n' >> commands/other.md
run "new TRUSTED_SCRIPT copy fails" 1; has "dup flagged" "NEW CANONICAL BLOCK COPY"

reset; printf '_SD=x; mkdir -p "$_SD"   # FENCE_BOOTSTRAP\n' >> commands/other.md
run "new FENCE_BOOTSTRAP anchor fails" 1

reset; printf 'echo hi   # FENCE_BOOTSTRAP\n' >> commands/other.md
run "non-anchor FENCE_BOOTSTRAP tag passes" 0

reset; printf '# FORGE_ROOT bootstrap (canonical)\n' > commands/new-spec.md; git add -A
run "new spec file with block fails" 1

# Existing block, count unchanged or reduced, passes
reset; printf 'HELPER_SCRIPT=""\n' >> commands/other.md; git commit -qam x; git push -q origin HEAD:staging 2>/dev/null
git fetch -q origin staging
run "unchanged count passes" 0
: > commands/other.md; git add -A
run "reduced count passes" 0

# Exemption
reset; gen 100 >> commands/review-pr.md
run "exempt by label" 0 PR_LABELS="bug,spec-size-exempt"; has "label reported" "EXEMPT"
run "body marker does not exempt" 1 PR_BODY=$'text\n<!-- spec-size-exempt: security fix -->\nmore'
run "label substring not exempt" 1 PR_LABELS="spec-size-exempt-not"

# Net counting: moves and stubs pass (the #3493 / #3590 shape)
reset; : > commands/donor.md; printf 'HELPER_SCRIPT=""\n' >> commands/other.md
run "net move between files passes" 0
reset; : > commands/donor.md; printf 'HELPER_SCRIPT=""\n' > commands/new-spec.md; git add -A
run "move to a new file passes" 0
reset; git rm -q commands/donor.md; gen 5 > commands/review-pr.md; printf 'HELPER_SCRIPT=""\n' > commands/helper-stub.md; git add -A
run "stub replaces deleted block passes" 0
reset; printf 'HELPER_SCRIPT=""\n' >> commands/other.md
run "copy without removal still fails" 1

# Release PR skip (staging -> main only)
reset; gen 100 >> commands/review-pr.md
run "release PR skipped" 0 PR_HEAD_REF=staging PR_BASE_REF=main; has "skip reported" "SKIPPED"
run "hotfix to main still checked" 1 PR_HEAD_REF=hotfix PR_BASE_REF=main
run "staging to other base still checked" 1 PR_HEAD_REF=staging PR_BASE_REF=dev

# Merge-base: base advancing after branching must not count against the PR
reset; git checkout -q -b old-branch; git checkout -q staging 2>/dev/null || git checkout -q -B staging origin/staging
gen 300 >> commands/review-pr.md; git commit -qam "base grows"; git push -q origin HEAD:staging 2>/dev/null
git checkout -q old-branch; git fetch -q origin staging
run "base tip growth ignored (merge-base)" 0
git checkout -q feat; git branch -qD old-branch; git branch -qf staging origin/staging; reset

# Script extracted from the base ref behaves the same
git show origin/staging:scripts/check-spec-size.sh > "$TMP/base-script.sh" 2>/dev/null || cp "$S" "$TMP/base-script.sh"
gen 100 >> commands/review-pr.md
: > "$TMP/summary"
GITHUB_STEP_SUMMARY="$TMP/summary" PR_LABELS="" bash "$TMP/base-script.sh" origin/staging >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && ok || bad "extracted base-ref script fails over-budget change (rc=$rc)"
reset

# Fail closed on unresolvable base
: > "$TMP/summary"
GITHUB_STEP_SUMMARY="$TMP/summary" bash "$S" origin/does-not-exist >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok || bad "unresolved base fails closed (rc=$rc)"

echo "check-spec-size.test: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
