#!/usr/bin/env bash
# extract-affected-files.test.sh — Unit-style tests for scripts/extract-affected-files.sh
#
# No network/GitHub API access required: `gh` is replaced with a mock that
# returns fixture text via MOCK_GH_COMMENTS (FORGE:INVESTIGATOR comment body,
# already pre-filtered the way `gh api ... --jq 'select(...)|.body'` would
# return it) and MOCK_GH_BODY (raw issue body, as `gh issue view --json body
# --jq '.body'` would return it) — same fixture-file-via-env-var mocking
# convention as scripts/issue-dedup.test.sh.
#
# Usage: bash scripts/extract-affected-files.test.sh
# Exit code: 0 if all assertions pass, 1 if any fail.
#
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRACT="$SCRIPT_DIR/extract-affected-files.sh"

TMP_BIN=$(mktemp -d)
TMP_FIXTURES=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_BIN" "$TMP_FIXTURES"
}
trap cleanup EXIT

# --------------------------------------------------------------------------- #
# Mock `gh` — intercepts:
#   gh api .../comments --jq '...FORGE:CONTRACT...'      -> cat $MOCK_GH_CONTRACT (if set+exists, else empty)
#   gh api .../comments --jq '...FORGE:INVESTIGATOR...'  -> cat $MOCK_GH_COMMENTS (if set+exists, else empty)
#   gh issue view <num> -R <repo> --json body --jq '...'  -> cat $MOCK_GH_BODY (if set+exists, else empty)
# Any other invocation is a test setup error.
#
# forge#2848: the two `gh api` call sites hit the same endpoint and differ only in
# their --jq selector, so the mock dispatches on which FORGE marker the selector
# names. This keeps the contract source and the investigator source independently
# fixturable — required to assert the contract-beats-investigator ordering rule.
#
# forge#2504: MOCK_GH_COMMENTS_FAIL=1 / MOCK_GH_BODY_FAIL=1 force the respective
# call site to simulate a genuine `gh` failure (non-zero exit, nothing on
# stdout) instead of a "call succeeded, empty/no-match result" — this is the
# distinction extract-affected-files.sh must now surface as PROVENANCE=error.
# MOCK_GH_CONTRACT_FAIL=1 does the same for the contract fetch alone; note that
# MOCK_GH_COMMENTS_FAIL=1 fails BOTH `gh api` call sites, which is the faithful
# simulation of a real network/auth/rate-limit outage (a real outage does not
# selectively spare one of two calls to the same endpoint).
# --------------------------------------------------------------------------- #
cat > "$TMP_BIN/gh" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "api" ]]; then
  if [[ "$*" == *"FORGE:CONTRACT"* ]]; then
    if [[ "${MOCK_GH_CONTRACT_FAIL:-}" == "1" || "${MOCK_GH_COMMENTS_FAIL:-}" == "1" ]]; then
      echo "mock gh api: simulated failure (network error / rate limit)" >&2
      exit 1
    fi
    if [[ -n "${MOCK_GH_CONTRACT:-}" && -f "${MOCK_GH_CONTRACT:-}" ]]; then
      cat "$MOCK_GH_CONTRACT"
    fi
    exit 0
  fi
  if [[ "${MOCK_GH_COMMENTS_FAIL:-}" == "1" ]]; then
    echo "mock gh api: simulated failure (network error / rate limit)" >&2
    exit 1
  fi
  if [[ -n "${MOCK_GH_COMMENTS:-}" && -f "${MOCK_GH_COMMENTS:-}" ]]; then
    cat "$MOCK_GH_COMMENTS"
  fi
  exit 0
fi
if [[ "$1" == "issue" && "$2" == "view" ]]; then
  if [[ "${MOCK_GH_BODY_FAIL:-}" == "1" ]]; then
    echo "mock gh issue view: simulated failure (network error / rate limit)" >&2
    exit 1
  fi
  if [[ -n "${MOCK_GH_BODY:-}" && -f "${MOCK_GH_BODY:-}" ]]; then
    cat "$MOCK_GH_BODY"
  fi
  exit 0
fi
echo "extract-affected-files.test.sh: unexpected gh mock invocation: $*" >&2
exit 1
MOCK
chmod +x "$TMP_BIN/gh"

export PATH="$TMP_BIN:$PATH"

PASS=0
FAIL=0

# assert_output <description> <expected_provenance> <expected_files_csv_or_empty> <extract args...>
#
# forge#2504: stdout is captured separately from stderr (`2>/dev/null`, not
# `2>&1`) because the script's PROVENANCE=/file-list contract lives entirely
# on stdout — the new gh-failure paths intentionally also emit a stderr
# WARNING (see extract-affected-files.sh), which must not be merged into the
# line this helper parses as "line 1 == PROVENANCE=...".
assert_output() {
  local desc="$1" expected_prov="$2" expected_files="$3"
  shift 3
  OUT=$("$EXTRACT" "$@" 2>/dev/null)
  ACTUAL_PROV=$(echo "$OUT" | head -1)
  ACTUAL_FILES=$(echo "$OUT" | tail -n +2 | tr '\n' ',' | sed 's/,$//')
  if [[ "$ACTUAL_PROV" == "PROVENANCE=$expected_prov" && "$ACTUAL_FILES" == "$expected_files" ]]; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc"
    echo "  expected: PROVENANCE=$expected_prov / files=[$expected_files]"
    echo "  actual:   $ACTUAL_PROV / files=[$ACTUAL_FILES]"
    FAIL=$((FAIL + 1))
  fi
}

# assert_exit <description> <expected_exit> <extract args...>
assert_exit() {
  local desc="$1" expected="$2"
  shift 2
  set +e
  OUT=$("$EXTRACT" "$@" 2>&1)
  ACTUAL=$?
  set -e
  if [[ "$ACTUAL" -eq "$expected" ]]; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected exit $expected, got $ACTUAL)"
    echo "  output: $OUT"
    FAIL=$((FAIL + 1))
  fi
}

# --------------------------------------------------------------------------- #
# Scenario 1 (forge#2382 regression fixture): no FORGE:INVESTIGATOR comment.
# Issue body lists three context-only paths under "## Context" and has NO
# "## Affected Files" section. Must yield PROVENANCE=none and zero files —
# NOT the pre-fix behavior of scraping the three context paths.
# --------------------------------------------------------------------------- #
BODY_2382="$TMP_FIXTURES/body_2382.txt"
cat > "$BODY_2382" <<'EOF'
## Problem

Something is broken in the batching logic.

## Context

This follows the pattern of `bin/hooks/pre-tool-use.mjs`, already implements
part of `scripts/transition-label.sh`, and is related to prior work in
`scripts/worktree-lifecycle.sh`.

## Root Cause

Unknown — investigation needed.
EOF

unset MOCK_GH_COMMENTS
MOCK_GH_BODY="$BODY_2382" assert_output \
  "forge#2382 regression: context-only paths under ## Context, no ## Affected Files -> zero files, PROVENANCE=none" \
  "none" "" 2382 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 2: body has a real "## Affected Files" section AND an unrelated
# "## Context" section with different paths. Only the Affected Files paths
# must be extracted; the Context paths must be ignored.
# --------------------------------------------------------------------------- #
BODY_SCOPED="$TMP_FIXTURES/body_scoped.txt"
cat > "$BODY_SCOPED" <<'EOF'
## Problem

Bug description.

## Affected Files

1. `bin/engine.mjs` — fix the thing
2. `bin/engine/phases.mjs` — related fix

## Context

Follows the pattern of `bin/unrelated-context-file.mjs`.

## Expected Behavior

It should work.
EOF

unset MOCK_GH_COMMENTS
MOCK_GH_BODY="$BODY_SCOPED" assert_output \
  "body-fallback scoped to ## Affected Files: extracts only the 2 listed files, ignores ## Context path" \
  "body-fallback" "bin/engine.mjs,bin/engine/phases.mjs" 2383 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 3: extension regex must cover mjs/js/sh/md (previously missing).
# ## Deliverables heading variant also exercised here.
# --------------------------------------------------------------------------- #
BODY_EXT="$TMP_FIXTURES/body_ext.txt"
cat > "$BODY_EXT" <<'EOF'
## Deliverables

1. `bin/cli-spawn-shared.mjs`
2. `scripts/danger-zones.mjs`
3. `scripts/flaky-quarantine.sh`
4. `devdocs/project/architecture.md`
EOF

unset MOCK_GH_COMMENTS
MOCK_GH_BODY="$BODY_EXT" assert_output \
  "extension regex covers mjs/sh/md under ## Deliverables heading" \
  "body-fallback" "bin/cli-spawn-shared.mjs,devdocs/project/architecture.md,scripts/danger-zones.mjs,scripts/flaky-quarantine.sh" \
  2384 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 4: "### Files to change" heading variant.
# --------------------------------------------------------------------------- #
BODY_FTC="$TMP_FIXTURES/body_ftc.txt"
cat > "$BODY_FTC" <<'EOF'
## Problem

Doc-only change.

### Files to change

- `docs/site/troubleshooting.md`

## Context

References `bin/registry.mjs` for background.
EOF

unset MOCK_GH_COMMENTS
MOCK_GH_BODY="$BODY_FTC" assert_output \
  "### Files to change heading scoped correctly, ## Context path ignored" \
  "body-fallback" "docs/site/troubleshooting.md" 2385 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 5: FORGE:INVESTIGATOR comment present -> primary path used,
# scoped to its own "### Affected Files" section. Paths in "### Evidence"
# and "### Root Cause" sections of the SAME comment must be ignored. The
# raw issue body (which may itself contain misleading context paths) must
# never be consulted when an INVESTIGATOR comment exists.
# --------------------------------------------------------------------------- #
INVESTIGATOR_COMMENT="$TMP_FIXTURES/investigator_comment.txt"
cat > "$INVESTIGATOR_COMMENT" <<'EOF'
<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: CONFIRMED

### Root Cause
Traced through `bin/engine/reconcile.mjs` before landing on the real cause.

### Affected Files
1. `bin/engine/state.mjs`
2. `bin/engine/projector.mjs`

### Evidence
See `bin/engine/invariants.mjs` for the assertion that fails.

<!-- INVESTIGATION:COMPLETE -->
EOF

BODY_SHOULD_BE_IGNORED="$TMP_FIXTURES/body_should_be_ignored.txt"
cat > "$BODY_SHOULD_BE_IGNORED" <<'EOF'
## Context

Totally different file: `bin/unrelated.mjs`
EOF

MOCK_GH_COMMENTS="$INVESTIGATOR_COMMENT" MOCK_GH_BODY="$BODY_SHOULD_BE_IGNORED" assert_output \
  "INVESTIGATOR comment present: primary path scoped to its own ### Affected Files, Root Cause/Evidence ignored, raw body never consulted" \
  "affected-files-section" "bin/engine/projector.mjs,bin/engine/state.mjs" 2386 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 6: no INVESTIGATOR comment AND no deliverables-shaped heading in
# the body at all (not even "## Context") -> PROVENANCE=none.
# --------------------------------------------------------------------------- #
BODY_NO_HEADINGS="$TMP_FIXTURES/body_no_headings.txt"
cat > "$BODY_NO_HEADINGS" <<'EOF'
Just some prose mentioning `bin/foo.mjs` with no headings at all.
EOF

unset MOCK_GH_COMMENTS
MOCK_GH_BODY="$BODY_NO_HEADINGS" assert_output \
  "no INVESTIGATOR comment, no deliverables heading at all -> PROVENANCE=none" \
  "none" "" 2387 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 7 (forge#2503 regression fixture): positive-path pre-joined
# single-token -R form, e.g. "-R owner/repo" as ONE argv element instead of
# two separate tokens. The script's usage comment and its `-R\ *` case arm
# both document this form as supported, but until this fixture the only
# assertion touching that arm was the malformed-value negative case in
# Scenario 8 below — the success branch (REPO="$_rval"; shift) had zero
# positive-path coverage. Reuses the BODY_SCOPED fixture from Scenario 2;
# only the argv form differs.
# --------------------------------------------------------------------------- #
unset MOCK_GH_COMMENTS
MOCK_GH_BODY="$BODY_SCOPED" assert_output \
  "pre-joined single-token -R form (\"-R test/repo\" as one argv element): body-fallback scoped to ## Affected Files" \
  "body-fallback" "bin/engine.mjs,bin/engine/phases.mjs" 2390 "-R test/repo"

# --------------------------------------------------------------------------- #
# Scenario 8: usage errors.
# --------------------------------------------------------------------------- #
assert_exit "missing issue number -> exit 2" 2 -R test/repo
assert_exit "missing value for -R -> exit 2" 2 2388 -R
assert_exit "malformed -R value (no slash, pre-joined token) -> exit 2" 2 2389 "-R notaslash"

# --------------------------------------------------------------------------- #
# Scenario 9 (forge#2504 regression fixture): primary `gh api` call fails
# outright (simulated network error / rate limit) and there is no usable
# fallback body either. Must yield PROVENANCE=error, NOT the pre-fix
# behavior of silently falling through to PROVENANCE=none as if this were
# a confirmed-empty result.
# --------------------------------------------------------------------------- #
unset MOCK_GH_COMMENTS MOCK_GH_BODY MOCK_GH_BODY_FAIL
MOCK_GH_COMMENTS_FAIL=1 assert_output \
  "forge#2504: primary gh api call fails, no usable fallback -> PROVENANCE=error, not none" \
  "error" "" 2504 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 10 (forge#2504 regression fixture): no FORGE:INVESTIGATOR comment
# (primary path legitimately empty, not failed) but the fallback `gh issue
# view` call fails outright. Must yield PROVENANCE=error, NOT none.
# --------------------------------------------------------------------------- #
unset MOCK_GH_COMMENTS MOCK_GH_COMMENTS_FAIL
MOCK_GH_BODY_FAIL=1 assert_output \
  "forge#2504: no INVESTIGATOR comment (legitimately empty) + fallback gh issue view fails -> PROVENANCE=error, not none" \
  "error" "" 2505 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 11 (forge#2504 regression fixture): primary `gh api` call fails,
# but the fallback `gh issue view` call succeeds and yields real files. A
# gh failure must never suppress or overwrite data actually recovered by a
# subsequent successful call — this must still report body-fallback, not
# error. Reuses the BODY_SCOPED fixture from Scenario 2.
# --------------------------------------------------------------------------- #
unset MOCK_GH_BODY_FAIL
MOCK_GH_COMMENTS_FAIL=1 MOCK_GH_BODY="$BODY_SCOPED" assert_output \
  "forge#2504: primary gh api call fails but fallback succeeds with real files -> body-fallback, not error" \
  "body-fallback" "bin/engine.mjs,bin/engine/phases.mjs" 2506 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 12 (forge#2848): FORGE:CONTRACT comment present with a real
# "### Deliverables" table -> PROVENANCE=contract-deliverables. Paths named in
# the contract's OTHER sections ("### Proposed Approach", "### Out of Scope")
# must be ignored — same heading-scoping guarantee the investigator path has.
# --------------------------------------------------------------------------- #
CONTRACT_FULL="$TMP_FIXTURES/contract_full.txt"
cat > "$CONTRACT_FULL" <<'EOF'
<!-- FORGE:CONTRACT -->
## Builder Contract

**Task type**: Bug Fix

### Proposed Approach

Mirrors the approach already taken in `bin/approach-only-context.mjs`.

### Deliverables

| File | Change | Why |
|------|--------|-----|
| `scripts/real-target.sh` | rewrite the parser | the actual defect |
| `bin/real-target.mjs` | update the caller | keeps the pair in sync |

### Out of Scope

Anything under `bin/out-of-scope-file.mjs`.
EOF

unset MOCK_GH_COMMENTS MOCK_GH_BODY MOCK_GH_COMMENTS_FAIL MOCK_GH_BODY_FAIL
MOCK_GH_CONTRACT="$CONTRACT_FULL" assert_output \
  "forge#2848: FORGE:CONTRACT ### Deliverables -> contract-deliverables, ignores Approach/Out-of-Scope paths" \
  "contract-deliverables" "bin/real-target.mjs,scripts/real-target.sh" 2848 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 13 (forge#2848 ORDERING rule): both a FORGE:CONTRACT and a
# FORGE:INVESTIGATOR comment exist, and they name DIFFERENT files. The contract
# must win — a deliverables table states intent to change, while an Affected
# Files list may name files that are merely relevant. This is the assertion that
# pins the provenance precedence order; without it the two sources could silently
# swap with no test failure.
# --------------------------------------------------------------------------- #
INV_DIFFERENT="$TMP_FIXTURES/inv_different.txt"
cat > "$INV_DIFFERENT" <<'EOF'
<!-- FORGE:INVESTIGATOR -->
## Investigation Report

### Affected Files

1. `scripts/investigator-guess.sh` — suspected
2. `bin/investigator-guess.mjs` — suspected
EOF

unset MOCK_GH_BODY MOCK_GH_COMMENTS_FAIL MOCK_GH_BODY_FAIL
MOCK_GH_CONTRACT="$CONTRACT_FULL" MOCK_GH_COMMENTS="$INV_DIFFERENT" assert_output \
  "forge#2848 ordering: contract beats investigator when both exist and disagree" \
  "contract-deliverables" "bin/real-target.mjs,scripts/real-target.sh" 2849 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 14 (forge#2848 FALL-THROUGH rule — load-bearing): a FORGE:CONTRACT
# exists but yields ZERO paths. It must fall through to the INVESTIGATOR path,
# NOT blackhole to PROVENANCE=none. Blackholing here would fire Layer 4's
# conservative serialization for exactly the mid-batch issues this change exists
# to un-serialize (the bug being fixed, inverted — see the forge#2848 risk table).
# Two zero-yield shapes are covered: no "### Deliverables" heading at all, and a
# Deliverables section that names no recognized file path.
# --------------------------------------------------------------------------- #
CONTRACT_NO_DELIV="$TMP_FIXTURES/contract_no_deliv.txt"
cat > "$CONTRACT_NO_DELIV" <<'EOF'
<!-- FORGE:CONTRACT -->
## Builder Contract

### Proposed Approach

Prose only, mentioning `bin/should-not-be-extracted.mjs` as context.

### Out of Scope

Everything else.
EOF

unset MOCK_GH_BODY MOCK_GH_COMMENTS_FAIL MOCK_GH_BODY_FAIL
MOCK_GH_CONTRACT="$CONTRACT_NO_DELIV" MOCK_GH_COMMENTS="$INV_DIFFERENT" assert_output \
  "forge#2848 fall-through: contract with no ### Deliverables section -> falls through to affected-files-section" \
  "affected-files-section" "bin/investigator-guess.mjs,scripts/investigator-guess.sh" 2850 -R test/repo

CONTRACT_EMPTY_DELIV="$TMP_FIXTURES/contract_empty_deliv.txt"
cat > "$CONTRACT_EMPTY_DELIV" <<'EOF'
<!-- FORGE:CONTRACT -->
## Builder Contract

### Deliverables

| File | Change | Why |
|------|--------|-----|
| (documentation-only, no code paths) | n/a | n/a |

### Out of Scope

Everything else.
EOF

unset MOCK_GH_BODY MOCK_GH_COMMENTS_FAIL MOCK_GH_BODY_FAIL
MOCK_GH_CONTRACT="$CONTRACT_EMPTY_DELIV" MOCK_GH_COMMENTS="$INV_DIFFERENT" assert_output \
  "forge#2848 fall-through: contract Deliverables naming no recognized path -> falls through to affected-files-section" \
  "affected-files-section" "bin/investigator-guess.mjs,scripts/investigator-guess.sh" 2851 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 15 (forge#2848 x forge#2504): the CONTRACT fetch specifically fails
# while every other source is legitimately empty. Must yield PROVENANCE=error,
# not none — the new call site doubles the gh failure surface, so its own
# GH_CALL_FAILED wiring needs its own assertion rather than riding on the
# investigator call's coverage.
# --------------------------------------------------------------------------- #
unset MOCK_GH_CONTRACT MOCK_GH_COMMENTS MOCK_GH_BODY MOCK_GH_COMMENTS_FAIL MOCK_GH_BODY_FAIL
MOCK_GH_CONTRACT_FAIL=1 assert_output \
  "forge#2848: contract gh api call fails, no other usable source -> PROVENANCE=error, not none" \
  "error" "" 2852 -R test/repo

# --------------------------------------------------------------------------- #
# Scenario 16 (forge#2848 x forge#2504): the CONTRACT fetch fails but the
# investigator path succeeds with real files. A gh failure must never suppress
# or overwrite data actually recovered by a subsequent successful call — same
# invariant Scenario 11 asserts for the primary/fallback pair.
# --------------------------------------------------------------------------- #
unset MOCK_GH_CONTRACT MOCK_GH_BODY MOCK_GH_COMMENTS_FAIL MOCK_GH_BODY_FAIL
MOCK_GH_CONTRACT_FAIL=1 MOCK_GH_COMMENTS="$INV_DIFFERENT" assert_output \
  "forge#2848: contract fetch fails but investigator succeeds with real files -> affected-files-section, not error" \
  "affected-files-section" "bin/investigator-guess.mjs,scripts/investigator-guess.sh" 2853 -R test/repo

unset MOCK_GH_CONTRACT_FAIL

# --------------------------------------------------------------------------- #
# Line-reference suffixes (field test, orchestrate #3149 / stress batch): review
# findings cite paths as `file:line`, `file:a-b,c` or `file:~n`. Those must be
# extracted with the suffix stripped, and the same file cited twice deduplicated.
# --------------------------------------------------------------------------- #
BODY_LINESUFFIX="$TMP_FIXTURES/body-linesuffix.md"
cat > "$BODY_LINESUFFIX" <<'EOF'
## Problem

Gate trusts agent-chosen band.

## Affected Files

1. `scripts/verify-phase-trail.sh:211` — band not cross-checked
2. `scripts/verify-phase-trail.sh:104-114,162` — pagination
3. `commands/orchestrate/phase-4-execution.md:~1685` — completion check
4. `commands/work-on/build/validate.md:433` — QG PASS not SHA-bound

## Source Branch Context

**Code branch**: `staging`
EOF
unset MOCK_GH_COMMENTS
MOCK_GH_BODY="$BODY_LINESUFFIX" assert_output \
  "line-reference suffixes are stripped and deduplicated" \
  "body-fallback" "commands/orchestrate/phase-4-execution.md,commands/work-on/build/validate.md,scripts/verify-phase-trail.sh" 2390 -R test/repo

# --------------------------------------------------------------------------- #
# Summary
# --------------------------------------------------------------------------- #
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
