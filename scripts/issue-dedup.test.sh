#!/usr/bin/env bash
# issue-dedup.test.sh — Unit-style tests for scripts/issue-dedup.sh's --exclude flag
#
# No network/GitHub API access required: `gh` is replaced with a mock that
# returns fixture candidate lists via the MOCK_GH_CANDIDATES env var, mimicking
# the "\(.number)\t\(.title)" projection issue-dedup.sh expects from
# `gh issue list --json number,title --jq '...'`.
#
# Usage: bash scripts/issue-dedup.test.sh
# Exit code: 0 if all assertions pass, 1 if any fail.
#
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEDUP="$SCRIPT_DIR/issue-dedup.sh"

TMP_BIN=$(mktemp -d)
TMP_FIXTURES=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_BIN" "$TMP_FIXTURES"
}
trap cleanup EXIT

# --------------------------------------------------------------------------- #
# Mock `gh` — intercepts `gh issue list ...` and prints the fixture file named
# by $MOCK_GH_CANDIDATES (tab-separated "number\ttitle" lines), ignoring all
# other flags/subcommands issue-dedup.sh passes through. Any other `gh`
# invocation is treated as an unexpected test setup error.
# --------------------------------------------------------------------------- #
cat > "$TMP_BIN/gh" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "issue" && "$2" == "list" ]]; then
  if [[ -n "${MOCK_GH_CANDIDATES:-}" && -f "${MOCK_GH_CANDIDATES:-}" ]]; then
    cat "$MOCK_GH_CANDIDATES"
  fi
  exit 0
fi
echo "issue-dedup.test.sh: unexpected gh mock invocation: $*" >&2
exit 1
MOCK
chmod +x "$TMP_BIN/gh"

export PATH="$TMP_BIN:$PATH"

PASS=0
FAIL=0

# assert_exit <description> <expected_exit> <dedup args...>
assert_exit() {
  local desc="$1" expected="$2"
  shift 2
  set +e
  OUT=$("$DEDUP" "$@" 2>&1)
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

PROPOSED_TITLE="fix(batch): duplicate detection review findings"

# --------------------------------------------------------------------------- #
# Scenario A: candidate set contains ONLY the batch's own declared members.
# Both titles are engineered to share >=3 normalized tokens (length >= 4) with
# the proposed title: "duplicate", "detection", "review"/"findings".
# --------------------------------------------------------------------------- #
MEMBERS_ONLY="$TMP_FIXTURES/members_only.tsv"
cat > "$MEMBERS_ONLY" <<'EOF'
2422	fix: duplicate detection review token overlap
2424	fix: duplicate detection findings batching logic
EOF

MOCK_GH_CANDIDATES="$MEMBERS_ONLY" assert_exit \
  "baseline (no --exclude): batch title collides with its own members -> exit 1" \
  1 "$PROPOSED_TITLE" -R test/repo

MOCK_GH_CANDIDATES="$MEMBERS_ONLY" assert_exit \
  "--exclude '2422,2424': batch title excludes its own members -> exit 0" \
  0 "$PROPOSED_TITLE" -R test/repo --exclude "2422,2424"

MOCK_GH_CANDIDATES="$MEMBERS_ONLY" assert_exit \
  "--exclude=2422,2424 (pre-joined form) -> exit 0" \
  0 "$PROPOSED_TITLE" -R test/repo --exclude=2422,2424

# --------------------------------------------------------------------------- #
# Scenario B: candidate set has the declared members PLUS an unrelated
# non-member issue (#2600) that also collides on token overlap. Excluding the
# members must NOT suppress the non-member match — protection is preserved.
# --------------------------------------------------------------------------- #
MEMBERS_PLUS_NONMEMBER="$TMP_FIXTURES/members_plus_nonmember.tsv"
cat > "$MEMBERS_PLUS_NONMEMBER" <<'EOF'
2422	fix: duplicate detection review token overlap
2424	fix: duplicate detection findings batching logic
2600	fix: duplicate detection review triage
EOF

MOCK_GH_CANDIDATES="$MEMBERS_PLUS_NONMEMBER" assert_exit \
  "--exclude '2422,2424' with a real non-member duplicate present -> still exit 1" \
  1 "$PROPOSED_TITLE" -R test/repo --exclude "2422,2424"

# --------------------------------------------------------------------------- #
# Scenario C: exclusion list has no bearing when there is no candidate overlap
# at all — sanity check that --exclude doesn't accidentally suppress dedup.
# --------------------------------------------------------------------------- #
NO_OVERLAP="$TMP_FIXTURES/no_overlap.tsv"
cat > "$NO_OVERLAP" <<'EOF'
9001	feat: totally unrelated subsystem work
EOF

MOCK_GH_CANDIDATES="$NO_OVERLAP" assert_exit \
  "no overlap at all, --exclude present but irrelevant -> exit 0" \
  0 "$PROPOSED_TITLE" -R test/repo --exclude "2422,2424"

# --------------------------------------------------------------------------- #
# Scenario D: malformed / non-numeric exclusion tokens are silently dropped,
# not a usage error.
# --------------------------------------------------------------------------- #
MOCK_GH_CANDIDATES="$MEMBERS_ONLY" assert_exit \
  "malformed --exclude tokens (non-numeric) are dropped, real numeric ones still apply -> exit 0" \
  0 "$PROPOSED_TITLE" -R test/repo --exclude "2422, 2424, abc, "

# --------------------------------------------------------------------------- #
# Scenario E: --exclude combined with existing -R parsing (two-token and
# pre-joined forms) does not regress prior -R argument-parsing fixes (#1530,
# #1625).
# --------------------------------------------------------------------------- #
MOCK_GH_CANDIDATES="$MEMBERS_ONLY" assert_exit \
  "--exclude alongside pre-joined -R token -> exit 0" \
  0 "$PROPOSED_TITLE" "-R test/repo" --exclude "2422,2424"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
