#!/usr/bin/env bash
# review-acceptance-gate.sh — review-phase acceptance gate (work-on/review.md Phase R2.5, forge#3793).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: review-acceptance-gate.sh <issue> <gh_repo> "<gh_flag>" <worktree_path>     (DRY_RUN=1 skips gh writes)
# Evaluates the ACCEPTANCE_CHECK lines the build gate (B6.5) deferred: `phase=review` checks, plus untagged legacy
# command/behavior checks on a `gh pr` target. Uses its own FORGE:ACCEPTANCE_GATE_REVIEW marker, never the build
# gate's FORGE:ACCEPTANCE_GATE header or :PASSED/:FAILED/:BLOCKED sentinels (the engine reads those).
# Exit: 0 passed / no-op / already passed for this head, 1 a deferred check failed (issue gets needs-human).
set -uo pipefail

NUMBER="${1:?issue number}"; GH_REPO="${2:?repo}"; GH_FLAG="${3:-}"; WT="${4:-.}"
cd "$WT" || exit 2
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
# shellcheck disable=SC2086  # GH_FLAG is a pre-split "-R owner/repo" flag string
gh_i() { gh "$@" $GH_FLAG; }

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
COMMENTS=$(gh api "repos/$GH_REPO/issues/$NUMBER/comments" --paginate 2>/dev/null | jq -rs '[.[][]]' 2>/dev/null) || COMMENTS="[]"
LAST=$(printf '%s' "$COMMENTS" | jq -r '[.[] | select(.body | startswith("<!-- FORGE:ACCEPTANCE_GATE_REVIEW -->"))] | last | .body // ""')
if printf '%s' "$LAST" | grep -qF "<!-- FORGE:ACCEPTANCE_GATE_REVIEW:PASSED:${HEAD_SHA} -->"; then
  echo "Review acceptance gate already PASSED for ${HEAD_SHA}; skipping."; exit 0
fi

CHECKS=$(printf '%s' "$COMMENTS" | jq -r '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' | grep "^ACCEPTANCE_CHECK:")
GATE_PASS=true; FAILED=""; RAN=0; RESULTS=""
while IFS= read -r check_line; do
  [ -z "$check_line" ] && continue
  ID=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=\([^ ]*\) type=.*/\1/p')
  TYPE=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=\([^ ]*\) target=.*/\1/p')
  TARGET=$(printf '%s\n' "$check_line" | sed -nE 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target="(([^"\\]|\\.)*)".*/\1/p' | sed 's/\\"/"/g')
  [ -z "$TARGET" ] && TARGET=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=\([^ ]*\).*/\1/p')
  MATCHER=$(printf '%s\n' "$check_line" | sed -nE 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=("([^"\\]|\\.)*"|[^ ]*) matcher="(([^"\\]|\\.)*)".*/\3/p' | sed 's/\\"/"/g')
  [ -z "$MATCHER" ] && MATCHER=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=[^ ]* matcher=\([^ ]*\).*/\1/p')
  DESC=$(echo "$check_line" | sed -n 's/.*description=\(.*\)/\1/p')
  # phase= is anchored after matcher=, so text inside target/matcher/description cannot set it; anything else is build.
  PHASE=$(printf '%s\n' "$check_line" | sed -nE 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=("(([^"\\]|\\.)*)"|[^ ]*) matcher=("(([^"\\]|\\.)*)"|[^ ]*) phase=(build|review)( .*)?$/\7/p')
  [ "$PHASE" = "review" ] || PHASE=build
  case "$TYPE" in command|behavior) ;; *) [ "$PHASE" = "review" ] || continue ;; esac
  if [ "$PHASE" != "review" ]; then
    printf '%s\n' "$check_line" | grep -qE ' phase=(build|review)( |$)' && continue
    case "$TARGET" in *'gh pr'*) ;; *) continue ;; esac
  fi
  RESULT="PASS"; DETAIL=""
  case "$TYPE" in
    exists) [ -e "$TARGET" ] || { RESULT="FAIL"; DETAIL="path not found: $TARGET"; } ;;
    contains)
      grep -qE "$MATCHER" "$TARGET" 2>/dev/null || grep -qF -- "$MATCHER" "$TARGET" 2>/dev/null || { RESULT="FAIL"; DETAIL="'$MATCHER' not found in $TARGET"; } ;;
    command|behavior)
      if [ "$MATCHER" = "exit_0" ]; then
        eval "$TARGET" >/dev/null 2>&1 || { RESULT="FAIL"; DETAIL="command exited non-zero: $TARGET"; }
      else
        OUTPUT=$(eval "$TARGET" 2>&1)
        printf '%s\n' "$OUTPUT" | grep -qE "$MATCHER" || printf '%s\n' "$OUTPUT" | grep -qF -- "$MATCHER" \
          || { RESULT="FAIL"; DETAIL="output did not match '$MATCHER'. Got: $(printf '%s\n' "$OUTPUT" | head -3)"; }
      fi ;;
    *) RESULT="FAIL"; DETAIL="unknown check type: $TYPE" ;;
  esac
  RAN=$((RAN+1))
  RESULTS="${RESULTS}\n- **$ID** ($DESC): $RESULT"
  if [ "$RESULT" = "FAIL" ]; then GATE_PASS=false; FAILED="${FAILED}\n- **$ID** ($DESC): $DETAIL"; fi
done <<< "$CHECKS"

if [ "$RAN" -eq 0 ]; then
  echo "No deferred acceptance checks; R2.5 is a no-op."
elif [ "$GATE_PASS" = "true" ]; then
  run gh_i issue comment "$NUMBER" --body "<!-- FORGE:ACCEPTANCE_GATE_REVIEW -->
## Review Acceptance Gate: PASSED

Deferred (phase=review) acceptance checks verified against the PR:
$(echo -e "$RESULTS")

<!-- FORGE:ACCEPTANCE_GATE_REVIEW:PASSED:${HEAD_SHA} -->"
else
  run gh_i issue comment "$NUMBER" --body "<!-- FORGE:ACCEPTANCE_GATE_REVIEW -->
## Review Acceptance Gate: FAILED

The following deferred (phase=review) acceptance checks did not pass against the PR:

$(echo -e "$FAILED")

Merge is blocked. Fix the PR (for example its body) and re-run the review phase.

<!-- FORGE:ACCEPTANCE_GATE_REVIEW:FAILED -->"
  run gh_i issue edit "$NUMBER" --add-label "needs-human"
  printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number:\n  pr_url:\n  merged_to:\n  blocker: review acceptance gate failed (see FORGE:ACCEPTANCE_GATE_REVIEW comment)\n'
  exit 1
fi
