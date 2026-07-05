#!/usr/bin/env bash
# scripts/flaky-quarantine.sh
# Classify a failing test as flaky, pre-broken, or real (PR-caused).
#
# Usage:
#   bash scripts/flaky-quarantine.sh \
#     --test "<test-id-or-command>" \
#     --base <base-branch>          \
#     [--worktree <path>]           \
#     [--repo <owner/repo>]         \
#     [--issue <pr-issue-number>]   \
#     [--retries <N>]               \
#     [--manifest <path>]
#
# Classification:
#   PRE_BROKEN  — test fails on base branch (broken before this PR)
#   FLAKY       — test fails on PR branch then passes on at least one retry
#   REAL        — test fails deterministically on PR branch, passes on base branch
#
# Output (to stdout, one line):
#   CLASSIFICATION: PRE_BROKEN|FLAKY|REAL
#   QUARANTINE_ENTRY: <json-line appended to manifest when PRE_BROKEN or FLAKY>
#
# Exit codes:
#   0 — classification complete (any outcome)
#   1 — usage error or test command missing
#
# Manifest format (JSONL, one entry per line):
#   {"test":"<id>","classification":"<PRE_BROKEN|FLAKY>","base":"<branch>",
#    "pr_branch":"<branch>","issue":"<num>","repo":"<owner/repo>",
#    "first_seen":"<ISO-8601>","runs_pr":<n>,"failures_pr":<n>,"runs_base":<n>,"failures_base":<n>}
#
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
RETRIES=3
MANIFEST="${FORGEDOCK_QUARANTINE_MANIFEST:-${WORKTREE_PATH:-.}/.forgedock/quarantine.jsonl}"
BASE_BRANCH=""
TEST_CMD=""
WORKTREE="${WORKTREE_PATH:-.}"
REPO=""
ISSUE_NUM=""

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test)      TEST_CMD="$2";    shift 2 ;;
    --base)      BASE_BRANCH="$2"; shift 2 ;;
    --worktree)  WORKTREE="$2";    shift 2 ;;
    --repo)      REPO="$2";        shift 2 ;;
    --issue)     ISSUE_NUM="$2";   shift 2 ;;
    --retries)   RETRIES="$2";     shift 2 ;;
    --manifest)  MANIFEST="$2";    shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$TEST_CMD" ]; then
  echo "Usage: $0 --test <test-id-or-command> --base <base-branch> [options]" >&2
  exit 1
fi
if [ -z "$BASE_BRANCH" ]; then
  echo "Error: --base <base-branch> is required" >&2
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
run_test() {
  # Run the test command in WORKTREE; return exit code only.
  local exit_code=0
  (cd "$WORKTREE" && eval "$TEST_CMD" >/dev/null 2>&1) || exit_code=$?
  echo "$exit_code"
}

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ"
}

# ── Step 1: Run test N times on the PR branch ─────────────────────────────────
PR_BRANCH=$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "Classifying test on PR branch '${PR_BRANCH}' (${RETRIES} run(s))..."

RUNS_PR=0
FAILURES_PR=0
for i in $(seq 1 "$RETRIES"); do
  RUNS_PR=$((RUNS_PR + 1))
  CODE=$(run_test)
  if [ "$CODE" -ne 0 ]; then
    FAILURES_PR=$((FAILURES_PR + 1))
    echo "  PR run $i: FAIL (exit $CODE)"
  else
    echo "  PR run $i: PASS"
  fi
done

# ── Step 2: Run test on base branch ──────────────────────────────────────────
echo "Running test on base branch '${BASE_BRANCH}'..."
BASE_REF="origin/${BASE_BRANCH}"

RUNS_BASE=0
FAILURES_BASE=0

# Create a temporary worktree for the base branch so we do not disturb HEAD.
TMP_WORKTREE=""
cleanup() {
  if [ -n "$TMP_WORKTREE" ] && [ -d "$TMP_WORKTREE" ]; then
    git -C "$WORKTREE" worktree remove --force "$TMP_WORKTREE" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if git -C "$WORKTREE" ls-remote --exit-code origin "$BASE_BRANCH" >/dev/null 2>&1; then
  TMP_WORKTREE=$(mktemp -d)
  # Remove the empty dir first — git worktree add requires a non-existent or empty dir.
  rmdir "$TMP_WORKTREE"
  if git -C "$WORKTREE" worktree add --detach "$TMP_WORKTREE" "$BASE_REF" >/dev/null 2>&1; then
    RUNS_BASE=1
    BASE_EXIT=0
    (cd "$TMP_WORKTREE" && eval "$TEST_CMD" >/dev/null 2>&1) || BASE_EXIT=$?
    if [ "$BASE_EXIT" -ne 0 ]; then
      FAILURES_BASE=1
      echo "  Base run 1: FAIL (exit $BASE_EXIT)"
    else
      echo "  Base run 1: PASS"
    fi
  else
    echo "WARNING: could not create worktree for base branch — skipping base run" >&2
  fi
else
  echo "WARNING: base branch '${BASE_BRANCH}' not found on remote — skipping base run" >&2
fi

# ── Step 3: Classify ──────────────────────────────────────────────────────────
CLASSIFICATION=""

if [ "$RUNS_BASE" -gt 0 ] && [ "$FAILURES_BASE" -gt 0 ]; then
  # Fails on base → pre-broken regardless of PR behaviour
  CLASSIFICATION="PRE_BROKEN"
elif [ "$FAILURES_PR" -gt 0 ] && [ "$FAILURES_PR" -lt "$RUNS_PR" ]; then
  # Intermittent on PR → flaky
  CLASSIFICATION="FLAKY"
elif [ "$FAILURES_PR" -eq "$RUNS_PR" ] && [ "$RUNS_PR" -gt 0 ]; then
  if [ "$RUNS_BASE" -gt 0 ] && [ "$FAILURES_BASE" -eq 0 ]; then
    # Deterministic on PR, passes on base → real regression
    CLASSIFICATION="REAL"
  elif [ "$RUNS_BASE" -eq 0 ]; then
    # No base data — treat as potentially real but flag uncertainty
    CLASSIFICATION="REAL"
    echo "NOTE: base branch not available — REAL classification is unconfirmed" >&2
  else
    CLASSIFICATION="REAL"
  fi
else
  # Passes on all PR runs — test is not currently failing
  CLASSIFICATION="PASS"
fi

echo ""
echo "CLASSIFICATION: ${CLASSIFICATION}"

# ── Step 4: Write quarantine manifest entry ───────────────────────────────────
if [ "$CLASSIFICATION" = "PRE_BROKEN" ] || [ "$CLASSIFICATION" = "FLAKY" ]; then
  MANIFEST_DIR=$(dirname "$MANIFEST")
  mkdir -p "$MANIFEST_DIR"

  TIMESTAMP=$(iso_now)
  # Escape double-quotes in TEST_CMD for JSON safety
  TEST_JSON=$(echo "$TEST_CMD" | sed 's/\\/\\\\/g; s/"/\\"/g')

  ENTRY="{\"test\":\"${TEST_JSON}\",\"classification\":\"${CLASSIFICATION}\",\"base\":\"${BASE_BRANCH}\",\"pr_branch\":\"${PR_BRANCH}\",\"issue\":\"${ISSUE_NUM}\",\"repo\":\"${REPO}\",\"first_seen\":\"${TIMESTAMP}\",\"runs_pr\":${RUNS_PR},\"failures_pr\":${FAILURES_PR},\"runs_base\":${RUNS_BASE},\"failures_base\":${FAILURES_BASE}}"

  # Append only if this exact test+classification is not already in the manifest.
  ALREADY_PRESENT=false
  if [ -f "$MANIFEST" ]; then
    grep -qF "\"${TEST_JSON}\"" "$MANIFEST" && ALREADY_PRESENT=true
  fi

  if [ "$ALREADY_PRESENT" = "false" ]; then
    echo "$ENTRY" >> "$MANIFEST"
    echo "QUARANTINE_ENTRY: ${ENTRY}"
    echo "Wrote quarantine entry to ${MANIFEST}"
  else
    echo "QUARANTINE_ENTRY: already recorded in ${MANIFEST} — skipping duplicate"
  fi

  # ── Step 5: File a GitHub issue for newly quarantined tests ──────────────────
  if [ -n "$REPO" ] && command -v gh >/dev/null 2>&1 && [ "$ALREADY_PRESENT" = "false" ]; then
    LABEL_ARGS=""
    if [ "$CLASSIFICATION" = "PRE_BROKEN" ]; then
      LABEL_ARGS="--label bug --label priority:P2"
    else
      LABEL_ARGS="--label bug --label priority:P3"
    fi

    ISSUE_BODY="## Quarantined test: \`${TEST_JSON}\`

**Classification**: ${CLASSIFICATION}
**PR branch**: \`${PR_BRANCH}\`
**Base branch**: \`${BASE_BRANCH}\`
**PR / Issue**: ${ISSUE_NUM:-n/a}
**Detected**: ${TIMESTAMP}

### Run summary

| Branch | Runs | Failures |
|--------|------|----------|
| PR (\`${PR_BRANCH}\`) | ${RUNS_PR} | ${FAILURES_PR} |
| Base (\`${BASE_BRANCH}\`) | ${RUNS_BASE} | ${FAILURES_BASE} |

### Next steps

- Investigate root cause of test instability
- Fix or remove the test once confirmed pre-broken or consistently flaky
- Update quarantine manifest once resolved: \`${MANIFEST}\`

<!-- FORGE:QUARANTINE test=\"${TEST_JSON}\" classification=\"${CLASSIFICATION}\" -->"

    TITLE_PREFIX=""
    case "$CLASSIFICATION" in
      PRE_BROKEN) TITLE_PREFIX="pre-broken" ;;
      FLAKY)      TITLE_PREFIX="flaky" ;;
    esac

    gh issue create \
      --repo "$REPO" \
      --title "test(quarantine): ${TITLE_PREFIX} — ${TEST_JSON}" \
      --body "$ISSUE_BODY" \
      $LABEL_ARGS \
      2>/dev/null || echo "WARNING: could not create quarantine issue (gh error — manual filing required)" >&2
  fi
fi
