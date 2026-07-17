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
#   gh api repos/<repo>/issues/<num>/comments --jq '...'   -> cat $MOCK_GH_COMMENTS (if set+exists, else empty)
#   gh issue view <num> -R <repo> --json body --jq '...'   -> cat $MOCK_GH_BODY (if set+exists, else empty)
# Any other invocation is a test setup error.
# --------------------------------------------------------------------------- #
cat > "$TMP_BIN/gh" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "api" ]]; then
  if [[ -n "${MOCK_GH_COMMENTS:-}" && -f "${MOCK_GH_COMMENTS:-}" ]]; then
    cat "$MOCK_GH_COMMENTS"
  fi
  exit 0
fi
if [[ "$1" == "issue" && "$2" == "view" ]]; then
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
assert_output() {
  local desc="$1" expected_prov="$2" expected_files="$3"
  shift 3
  OUT=$("$EXTRACT" "$@" 2>&1)
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
# Summary
# --------------------------------------------------------------------------- #
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
