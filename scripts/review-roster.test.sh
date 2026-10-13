#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Tests for scripts/review-roster.sh (risk-tiered reviewer roster, forge#3599): the tier cases, the path triggers that
# escalate in every tier, and the regression table of the 13 review-driven holds. Run: bash scripts/review-roster.test.sh
# (bash 3.2 compatible)
#
# Hold table fixture: the changed-line count, file count and file list of each PR, the PR's linked-issue lineage, and
# the reviewers whose posted findings were CRITICAL or BLOCKER on it (from the FORGE:REVIEW-AGENT comments). The
# regression gate: at least one catching reviewer stays selected on every hold, and the sole catcher always does.

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$DIR/review-roster.sh"
pass=0; fail=0
ok() { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/review-roster.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

SEL=""; TIER=""; REASON=""
# run <files, newline separated> <review-roster flags...>
run() {
  printf '%s\n' "$1" > "$WORK/files"; shift
  out=$(bash "$SCRIPT" --files-file "$WORK/files" "$@") || { bad "script exited non-zero for: $*"; return 1; }
  SEL=$(printf '%s\n' "$out" | sed -n 's/^SELECTED_AGENTS=//p')
  TIER=$(printf '%s\n' "$out" | sed -n 's/^TIER=//p')
  REASON=$(printf '%s\n' "$out" | sed -n 's/^REASON=//p')
}
has() { case " $SEL " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
expect_sel() { if [ "$SEL" = "$2" ]; then ok; else bad "$1: roster '$SEL', want '$2' (tier $TIER; $REASON)"; fi; }
expect_has() { if has "$2"; then ok; else bad "$1: '$2' missing from '$SEL' (tier $TIER; $REASON)"; fi; }
expect_not() { if has "$2"; then bad "$1: '$2' should not be in '$SEL' (tier $TIER)"; else ok; fi; }
expect_tier() { if [ "$TIER" = "$2" ]; then ok; else bad "$1: tier '$TIER', want '$2'"; fi; }

SC_QUIET="AUTH=0 BILLING=0 CONCURRENCY=0 DATABASE=0 INFRA=0 SECURITY=1 SCRAPING=0 FRONTEND=0 API=0"
SC_NOISY="AUTH=3 BILLING=1 CONCURRENCY=0 DATABASE=1 INFRA=3 SECURITY=4 SCRAPING=0 FRONTEND=2 API=2"
SC_BUSY="AUTH=3 BILLING=3 CONCURRENCY=3 DATABASE=3 INFRA=3 SECURITY=1 SCRAPING=0 FRONTEND=2 API=2"

# Case 1: a small diff gives Security only, even when diff-text scores are loud
run "commands/foo.md" --scores "$SC_NOISY" --changed-lines 40 --changed-files 1
expect_sel "small diff" "security"; expect_tier "small diff" small
run "scripts/a.sh
scripts/b.sh" --scores "$SC_NOISY" --changed-lines 60 --changed-files 2
expect_sel "60-line boundary" "security"
# a single file is small up to 150 lines, not beyond
run "scripts/a.sh" --scores "$SC_QUIET" --changed-lines 120 --changed-files 1
expect_tier "single file" small
run "scripts/a.sh" --scores "$SC_QUIET" --changed-lines 400 --changed-files 1
expect_tier "single large file" standard

# Case 2: a small diff touching bin/engine/** adds concurrency and spec-cli
run "bin/engine/phases.mjs" --scores "$SC_QUIET" --changed-lines 30 --changed-files 1 --spec-cli true
expect_has "small bin/engine" concurrency; expect_has "small bin/engine" spec-cli; expect_has "small bin/engine" security; expect_tier "small bin/engine" small
run "bin/engine/phases.mjs" --scores "$SC_QUIET" --changed-lines 30 --changed-files 1 --spec-cli false
expect_has "consumer repo bin/engine" concurrency; expect_not "consumer repo bin/engine" spec-cli

# Case 3: a fix PR gives Security only
run "commands/orchestrate/phase-4-execution.md
commands/work-on.md" --scores "$SC_NOISY" --changed-lines 120 --changed-files 2 --fix-pr true --source-severity MEDIUM
expect_sel "fix PR" "security"; expect_tier "fix PR" fix-pr

# Case 3b (forge#3848): the fix-pr tier is capped at 150 known lines; larger or unknown-size fix PRs follow the size ladder
SC_MULTI="AUTH=0 BILLING=5 CONCURRENCY=0 DATABASE=4 INFRA=0 FRONTEND=3 API=0"
run "svc/x.py" --scores "$SC_MULTI" --changed-lines 900 --changed-files 30 --fix-pr true --source-severity MEDIUM
expect_tier "fix PR 900 lines" standard; expect_has "fix PR 900 lines" billing; expect_has "fix PR 900 lines" database
run "svc/x.py" --scores "$SC_QUIET" --changed-lines 150 --changed-files 2 --fix-pr true
expect_tier "fix-PR-at-cap" fix-pr
run "svc/x.py" --scores "$SC_QUIET" --changed-lines 151 --changed-files 2 --fix-pr true
expect_tier "fix PR over cap" standard
run "svc/x.py" --scores "$SC_MULTI" --fix-pr true
expect_tier "fix-PR-unknown-size" standard
run "svc/x.py" --scores "$SC_MULTI" --changed-lines abc --fix-pr true
expect_tier "fix PR non-numeric size" standard
run "svc/x.py" --scores "$SC_QUIET" --changed-lines 400 --changed-files 5 --fix-pr true --source-severity HIGH --source-domain Concurrency
expect_has "capped-fix-PR,-HIGH-source" concurrency; expect_tier "capped-fix-PR,-HIGH-source" standard
run "svc/x.py" --scores "$SC_QUIET" --changed-lines 400 --changed-files 5 --fix-pr true --contract-flags "HIGH_RISK" --review-depth EXTENDED
expect_tier "capped-fix-PR-with-HIGH_RISK-and-EXTENDED" standard

# Case 4: a fix PR whose source finding was HIGH adds the domain agent
run "commands/work-on.md" --scores "AUTH=0 BILLING=0 CONCURRENCY=2 DATABASE=0 INFRA=0 FRONTEND=0 API=0" --changed-lines 40 --fix-pr true --source-severity HIGH --source-domain Concurrency
expect_sel "fix PR, HIGH source finding" "security concurrency"
run "commands/work-on.md" --scores "AUTH=0 BILLING=0 CONCURRENCY=2 DATABASE=0 INFRA=0 FRONTEND=0 API=0" --changed-lines 40 --fix-pr true --source-severity critical
expect_sel "fix PR, CRITICAL source, top domain" "security concurrency"

# Case 5: CONTRACT HIGH_RISK escalates in every tier
for tier_args in "--changed-lines 30 --changed-files 1" "--changed-lines 100" "--changed-lines 400" "--changed-lines 30 --fix-pr true"; do
  # shellcheck disable=SC2086
  run "svc/x.py" --scores "$SC_QUIET" $tier_args --contract-flags "HIGH_RISK CONTRACT_AUTH CONTRACT_BILLING"
  expect_has "HIGH_RISK ($tier_args)" auth; expect_has "HIGH_RISK ($tier_args)" billing; expect_has "HIGH_RISK ($tier_args)" concurrency
done
run "svc/x.py" --scores "$SC_QUIET" --changed-lines 30 --contract-flags "CONTRACT_AUTH"
expect_not "CONTRACT_AUTH without HIGH_RISK" auth

# Case 6: --thorough and milestone give the full union
run "svc/x.py" --scores "$SC_BUSY" --changed-lines 10 --thorough true
expect_tier "thorough" full
for d in security auth billing concurrency database infra frontend api; do expect_has "thorough" "$d"; done
expect_not "thorough, scraping not configured" scraper
run "svc/x.py" --scores "$SC_BUSY SCRAPING=3" --changed-lines 10 --milestone true --scraping-configured true
expect_tier "milestone" full; expect_has "milestone" scraper

# Path gates: auth and infra only by path; the other path triggers fire in the small tier
run "svc/app/routers/session.py" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth path" auth
run "scripts/trusted-comments.sh" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "trust-filter path" auth
run "svc/authorization.py" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth path authorization.py" auth
run "svc/authMiddleware.ts" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth-path-authMiddleware.ts" auth
run "svc/oauth2.ts" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth path oauth2.ts" auth
run "svc/permissions.py" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth path permissions.py" auth
run "svc/rbac.py" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth path rbac.py" auth
run "svc/deps.py" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth path deps.py" auth
run "svc/tokens.py" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth path tokens.py" auth
run "svc/api_keys.py" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth path api_keys.py" auth
run "svc/auth_utils.py" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "auth-path-auth_utils.py" auth
run "AUTHORS.md" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_not "no-auth-path-AUTHORS.md" auth
run "docs/author.md" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_not "no auth path docs/author.md" auth
run "svc/tokenizer.py" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_not "no-auth-path-svc/tokenizer.py" auth
run "commands/review-pr.md" --scores "AUTH=3 INFRA=0 DATABASE=0 BILLING=0 CONCURRENCY=0" --changed-lines 20 --changed-files 1
expect_not "auth-from-prose-score-alone" auth
run "commands/review-pr.md" --scores "AUTH=3 INFRA=3 DATABASE=0 BILLING=0 CONCURRENCY=0" --changed-lines 120
expect_not "auth from prose score alone" auth; expect_not "infra from prose score alone" infra
run ".github/workflows/ci.yml" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "infra path" infra
run "docker-compose.prod.yml" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "docker path" infra
# Infra path gate covers deploy scripts, container entrypoints and Compose v2 names (basename-anchored)
for f in scripts/deploy.sh scripts/deploy-prod.sh docker-entrypoint.sh svc/docker-entrypoint.sh compose.yaml compose.yml; do
  run "$f" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
  expect_has "infra path: $f" infra
done
for f in scripts/resolve-deploy-gate.sh commands/deploy-pr.md; do
  run "$f" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
  expect_not "no-infra-path-$f" infra
done
run "$(printf 'README.md\nscripts/deploy.sh')" --scores "$SC_QUIET" --changed-lines 20 --changed-files 2
expect_has "infra-path-multi-file-list" infra
run "Scripts/Deploy.SH" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "infra-path-case-insensitive" infra
run "db/migrations/0042_add.sql" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "migration path" database
run "sdk/node/src/index.ts" --scores "$SC_QUIET" --changed-lines 20 --changed-files 1
expect_has "sdk path" api
run "svc/x.py" --scores "AUTH=2 BILLING=2" --changed-lines 20 --changed-files 1
expect_has "cross-critical" auth; expect_has "cross-critical" billing
run "svc/x.py" --scores "BILLING=3 CONCURRENCY=3" --changed-lines 20 --changed-files 1 --churn true
expect_has "churn hot-spot top domain" billing
run "svc/x.py" --scores "BILLING=3" --changed-lines 20 --changed-files 2
expect_not "billing score in small tier" billing
run "svc/x.py
svc/y.py" --scores "BILLING=3" --changed-lines 100
expect_has "billing score in medium tier" billing; expect_has "billing score in medium tier" concurrency

# Tier shape: standard keeps the top-2 baseline, medium does not
run "web/src/app/a.tsx
web/src/b.tsx" --scores "FRONTEND=3 API=2 BILLING=1 DATABASE=1" --changed-lines 300
expect_tier "standard" standard; expect_has "standard" frontend; expect_has "standard" api; expect_not "standard top-2 only" billing
run "web/src/app/a.tsx
web/src/b.tsx" --scores "FRONTEND=3 API=2" --changed-lines 100
expect_sel "medium has no baseline" "security"
run "svc/x.py" --scores "FRONTEND=3" --changed-lines ""
expect_tier "unknown size" standard; expect_has "unknown size" frontend
run "commands/x.md
commands/y.md" --scores "$SC_QUIET" --changed-lines 300 --spec-cli true
expect_has "standard commands/** adds spec-cli" spec-cli
run "commands/x.md
commands/y.md" --scores "$SC_QUIET" --changed-lines 100 --spec-cli true
expect_not "medium commands/** has no spec-cli" spec-cli

# Roster output is canonical and duplicate free
run "bin/engine/a.mjs
.github/workflows/a.yml" --scores "$SC_BUSY" --changed-lines 300 --spec-cli true
n=$(printf '%s' "$SEL" | tr ' ' '\n' | grep -c .); u=$(printf '%s' "$SEL" | tr ' ' '\n' | sort -u | grep -c .)
if [ "$n" -eq "$u" ]; then ok; else bad "duplicate roster entries in '$SEL'"; fi
case "$SEL" in *[A-Z]*) bad "non-canonical roster '$SEL'" ;; *) ok ;; esac

# Unknown flag fails (callers fall back to the full union)
if bash "$SCRIPT" --bogus 1 >/dev/null 2>&1; then bad "unknown flag accepted"; else ok; fi

# Regression table: the 13 review-driven holds. Columns: PR | lines | files | fix-PR | catchers (CRITICAL/BLOCKER) | sole catcher | file list
hold() {
  pr="$1"; lines="$2"; nf="$3"; fixpr="$4"; catchers="$5"; sole="$6"; files="$7"
  run "$(printf '%s' "$files" | tr ' ' '\n')" --scores "$SC_QUIET" --changed-lines "$lines" --changed-files "$nf" --fix-pr "$fixpr" --spec-cli true
  found=""
  for c in $catchers; do has "$c" && found=1; done
  if [ -n "$found" ]; then ok; else bad "hold #$pr: none of [$catchers] selected: '$SEL' (tier $TIER)"; fi
  if [ -n "$sole" ]; then if has "$sole"; then ok; else bad "hold #$pr: sole catcher '$sole' not selected: '$SEL'"; fi; fi
  if has security; then ok; else bad "hold #$pr: security missing"; fi
}
hold 3426 126 3 true "security concurrency" "" "commands/orchestrate/phase-4-execution.md commands/work-on.md commands/work-on/remediate.md"
hold 3438 227 8 false "spec-cli" "spec-cli" "commands/review-pr-agents/protocols.md commands/review-pr.md commands/work-on.md commands/work-on/remediate.md commands/work-on/review.md docs/WORK-ON-RUNTIME.md docs/spec/review-protocol.md scripts/forge-root.test.sh"
hold 3461 454 12 false "security spec-cli" "" "commands/work-on.md commands/work-on/build.md commands/work-on/build/implement.md commands/work-on/close.md commands/work-on/decompose.md docs/CONFIG.md docs/spec/forge-protocol-v1.md forge.yaml.example packages/protocol/src/types.js scripts/check-spec-markers.sh scripts/diff-size.sh scripts/diff-size.test.sh"
hold 3464 53 2 true "security concurrency" "" "commands/orchestrate/phase-4-execution.md commands/work-on.md"
hold 3480 56 3 true "security" "" "commands/orchestrate/phase-4-execution.md commands/work-on.md scripts/check-spec-markers.sh"
hold 3490 220 3 false "security" "" "commands/review-pr-staging.md commands/review-pr.md scripts/review-pr-arguments.test.sh"
hold 3500 263 5 false "security" "" ".github/workflows/check-commands.yml commands/work-on/build/validate.md commands/work-on/review.md scripts/check-branch-ancestry.sh scripts/check-branch-ancestry.test.sh"
hold 3502 813 11 false "concurrency" "concurrency" "bin/engine-cli.mjs bin/engine.mjs bin/engine/phases-args.test.mjs bin/engine/phases.mjs bin/engine/runlog.mjs bin/tests/engine-crash.test.mjs bin/tests/engine-phases.test.mjs bin/tests/engine-runlog.test.mjs bin/tests/engine.test.mjs docs/WORK-ON-RUNTIME.md packages/protocol/src/phases.js"
hold 3509 274 6 false "security spec-cli" "" "bin/engine.mjs bin/engine/phases.mjs bin/tests/engine-crash.test.mjs bin/tests/engine-phases.test.mjs bin/tests/engine-runlog.test.mjs bin/tests/engine.test.mjs"
hold 3513 205 7 false "security concurrency infra spec-cli" "" "commands/orchestrate/phase-4-execution.md commands/review-pr.md commands/work-on.md commands/work-on/remediate.md commands/work-on/review.md docs/WORK-ON-RUNTIME.md scripts/check-spec-markers.sh"
hold 3520 4977 9 false "concurrency" "concurrency" "bin/engine-cli.mjs bin/engine.mjs bin/engine/runlog.mjs bin/forgedock.mjs bin/runner.mjs bin/tests/engine.test.mjs bin/tests/runner.test.mjs commands/orchestrate/phase-4-execution.md devdocs/modules/runner.md"
hold 3524 156 5 false "spec-cli" "spec-cli" "bin/engine.mjs bin/engine/phases.mjs bin/runner.mjs bin/tests/engine-phases.test.mjs bin/tests/engine.test.mjs"
hold 3555 137 8 false "security" "" "bin/engine/phases.mjs bin/tests/engine-phases.test.mjs commands/work-on/build.md commands/work-on/build/implement.md commands/work-on/decompose.md commands/work-on/investigate.md packages/protocol/CHANGELOG.md packages/protocol/src/phases.js"

# forge#3862: extended review depth (from the build's review_weight / scope flag) only ever adds reviewers
SC_TOP="AUTH=0 BILLING=1 CONCURRENCY=0 DATABASE=1 INFRA=0 SECURITY=1 SCRAPING=0 FRONTEND=2 API=2"
run "svc/a.py" --scores "$SC_TOP" --changed-lines 40 --changed-files 1
expect_tier "no depth flag stays small" small; expect_sel "no depth flag stays security-only" "security"
case "$out" in *DEPTH=*) bad "standard roster prints no DEPTH line" ;; *) ok ;; esac
run "svc/a.py" --scores "$SC_TOP" --changed-lines 40 --changed-files 1 --review-depth STANDARD
expect_tier "STANDARD depth stays small" small
run "svc/a.py" --scores "$SC_TOP" --changed-lines 40 --changed-files 1 --review-depth extended
expect_tier "lowercase depth is not EXTENDED" small
run "svc/a.py" --scores "$SC_TOP" --changed-lines 40 --changed-files 1 --review-depth EXTENDED
expect_tier "EXTENDED lifts small to standard" standard; expect_has "EXTENDED keeps security" security
expect_has "EXTENDED small adds top domains" frontend; expect_has "EXTENDED small adds top domains" api
case "$out" in *DEPTH=extended*) ok ;; *) bad "extended roster prints DEPTH=extended" ;; esac
run "svc/a.py" --scores "$SC_TOP" --changed-lines 400 --changed-files 6
expect_not "standard top-2 omits the third domain" database
run "svc/a.py" --scores "$SC_TOP" --changed-lines 400 --changed-files 6 --review-depth EXTENDED
expect_has "EXTENDED standard takes a third domain" database; expect_has "EXTENDED standard keeps security" security
run "svc/a.py" --scores "$SC_TOP" --changed-lines 30 --fix-pr true --review-depth EXTENDED
expect_tier "EXTENDED lifts fix-pr to standard" standard
run "svc/a.py" --scores "$SC_TOP" --changed-lines 400 --thorough true --review-depth EXTENDED
expect_tier "full stays full" full

echo "review-roster: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
