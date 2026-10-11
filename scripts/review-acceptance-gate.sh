#!/usr/bin/env bash
# review-acceptance-gate.sh — review-phase acceptance gate (work-on/review.md Phase R2.5, forge#3793).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: review-acceptance-gate.sh <issue> <gh_repo> "<gh_flag>" <worktree_path>     (DRY_RUN=1 skips gh writes)
# Evaluates the ACCEPTANCE_CHECK lines the build gate (B6.5) deferred: `phase=review` checks, plus command/behavior
# checks on a `gh pr` target (B6.5's legacy deferral ignores any phase= tag, so a tagged phase=build one is selected too). Uses its own FORGE:ACCEPTANCE_GATE_REVIEW marker, never the build
# gate's FORGE:ACCEPTANCE_GATE header or :PASSED/:FAILED/:BLOCKED sentinels (the engine reads those).
# Malformed checks (forge#3694 parity with B6.5: 4+ backslash run, `bash -n` parse failure, grep usage error) are skipped and listed,
# never a FAIL and never needs-human. With zero verified checks and some malformed, a non-blocking notice is posted (no PASSED marker).
# Exit: 0 passed / no-op / notice / already passed for this head, 1 a deferred check failed (issue gets needs-human).
set -uo pipefail

NUMBER="${1:?issue number}"; GH_REPO="${2:?repo}"; GH_FLAG="${3:-}"; WT="${4:-.}"
cd "$WT" || exit 2
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
# shellcheck disable=SC2086  # GH_FLAG is a pre-split "-R owner/repo" flag string
gh_i() { gh "$@" $GH_FLAG; }

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
# Trust (forge#3813): the spec lines are executed as check targets and the PASSED marker skips the gate, so both are read only
# from comments scripts/trusted-comments.sh accepts. The helper is resolved from ForgeDock's own install (forge_resolve), never
# the working directory; an unresolvable helper or unreadable comments fail closed (nothing executed, gate does not pass).
block() {
  echo "Review acceptance gate: $1 (fail closed)" >&2
  printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number:\n  pr_url:\n  merged_to:\n  blocker: review acceptance gate cannot trust issue comments (%s)\n' "$1"
  exit 1
}
_RESOLVE_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/forge-resolve.sh"
type forge_resolve >/dev/null 2>&1 || { [ -f "$_RESOLVE_LIB" ] && . "$_RESOLVE_LIB"; }
type forge_resolve >/dev/null 2>&1 || block "forge_resolve unavailable"
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
[ -n "$TRUSTED_SCRIPT" ] || block "trusted-comments.sh unresolvable"
COMMENTS=$(gh api "repos/$GH_REPO/issues/$NUMBER/comments" --paginate 2>/dev/null) || block "comments unreadable"
[ -n "$COMMENTS" ] || block "comments unreadable"
TRUSTED_GATE=$(printf '%s' "$COMMENTS" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:ACCEPTANCE_GATE_REVIEW -->') || block "trust filter failed"
TRUSTED_INV=$(printf '%s' "$COMMENTS" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:INVESTIGATOR -->') || block "trust filter failed"
LAST=$(printf '%s\n' "$TRUSTED_GATE" | tail -n 1 | jq -r '. // ""' 2>/dev/null) || LAST=""
if printf '%s' "$LAST" | grep -qF "<!-- FORGE:ACCEPTANCE_GATE_REVIEW:PASSED:${HEAD_SHA} -->"; then
  echo "Review acceptance gate already PASSED for ${HEAD_SHA}; skipping."; exit 0
fi

CHECKS=$(printf '%s\n' "$TRUSTED_INV" | jq -r '.' 2>/dev/null | grep "^ACCEPTANCE_CHECK:")
GREP_CLS=$(forge_resolve classify-grep-exit.sh) # unresolved = grep exit>=2 stays a real FAIL (fail closed, forge#3802)
GATE_PASS=true; FAILED=""; VERIFIED_COUNT=0; MALFORMED_CHECKS=""; RESULTS=""
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
    case "$TARGET" in *'gh pr'*) ;; *) continue ;; esac
  fi
  # malformed-check (forge#3694): static screen only parses (bash -n), never executes.
  MALFORMED=""
  { [ "$TYPE" = "command" ] || [ "$TYPE" = "behavior" ]; } && { case "$TARGET" in *'\\\\'*) MALFORMED="run of 4+ backslashes (over-escaped target)";; esac; [ -n "$MALFORMED" ] || bash -n -c "$TARGET" 2>/dev/null || MALFORMED="shell syntax error (unbalanced quotes)"; }
  { [ "$TYPE" = "command" ] || [ "$TYPE" = "behavior" ]; } && [ -z "$MALFORMED" ] && case "$(printf '%s' "$TARGET" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" in none) MALFORMED='target "none" is not a command (a manual criterion must be type=skipped)';; esac
  if [ -n "$MALFORMED" ]; then MALFORMED_CHECKS="${MALFORMED_CHECKS}\n- **$ID** ($DESC): $MALFORMED"; continue; fi
  RESULT="PASS"; DETAIL=""
  case "$TYPE" in
    exists) [ -e "$TARGET" ] || { RESULT="FAIL"; DETAIL="path not found: $TARGET"; } ;;
    contains)
      grep -qE "$MATCHER" "$TARGET" 2>/dev/null || grep -qF -- "$MATCHER" "$TARGET" 2>/dev/null || { RESULT="FAIL"; DETAIL="'$MATCHER' not found in $TARGET"; } ;;
    command|behavior)
      if [ "$MATCHER" = "exit_0" ]; then
        ERR=$(eval "$TARGET" 2>&1 >/dev/null); RC=$?
        # grep exit >= 2 is a usage error, not a verdict; only a positively identified usage error (classify-grep-exit.sh) is malformed; a missing operand stays a real FAIL even with stderr suppressed.
        [ "$RC" -ge 2 ] && MALFORMED=$(bash "$GREP_CLS" "$RC" "$ERR" "$TARGET" 2>/dev/null)
        [ "$RC" -eq 127 ] && [ -z "$MALFORMED" ] && printf '%s' "$ERR" | grep -qF 'command not found' && MALFORMED="command not found (rc 127): the target is not an executable command"
        [ "$RC" -eq 0 ] || [ -n "$MALFORMED" ] || { RESULT="FAIL"; DETAIL="command exited non-zero: $TARGET"; }
      else
        ERRF=$(mktemp); OUTPUT=$(eval "$TARGET" 2>"$ERRF"); RC=$?; ERR=$(cat "$ERRF"); rm -f "$ERRF"; [ -z "$ERR" ] || OUTPUT="${OUTPUT}${OUTPUT:+$'\n'}${ERR}" # classify on stderr only, match on both
        [ "$RC" -ge 2 ] && MALFORMED=$(bash "$GREP_CLS" "$RC" "$ERR" "$TARGET" 2>/dev/null)
        [ "$RC" -eq 127 ] && [ -z "$MALFORMED" ] && printf '%s' "$ERR" | grep -qF 'command not found' && MALFORMED="command not found (rc 127): the target is not an executable command"
        if [ -n "$MALFORMED" ]; then :
        else
          printf '%s\n' "$OUTPUT" | grep -qE "$MATCHER" || printf '%s\n' "$OUTPUT" | grep -qF -- "$MATCHER" \
            || { RESULT="FAIL"; DETAIL="output did not match '$MATCHER'. Got: $(printf '%s\n' "$OUTPUT" | head -3)"; }
        fi
      fi ;;
    *) RESULT="FAIL"; DETAIL="unknown check type: $TYPE" ;;
  esac
  if [ -n "$MALFORMED" ]; then MALFORMED_CHECKS="${MALFORMED_CHECKS}\n- **$ID** ($DESC): $MALFORMED"; continue; fi
  VERIFIED_COUNT=$((VERIFIED_COUNT+1))
  RESULTS="${RESULTS}\n- **$ID** ($DESC): $RESULT"
  if [ "$RESULT" = "FAIL" ]; then GATE_PASS=false; FAILED="${FAILED}\n- **$ID** ($DESC): $DETAIL"; fi
done <<< "$CHECKS"

MALFORMED_SECTION=""
[ -n "$MALFORMED_CHECKS" ] && MALFORMED_SECTION=$(printf '\n**malformed-check (not counted as failures; regenerate the acceptance spec by re-running investigate)**:%b\n' "$MALFORMED_CHECKS")

if [ "$VERIFIED_COUNT" -eq 0 ] && [ -z "$MALFORMED_CHECKS" ]; then
  echo "No deferred acceptance checks; R2.5 is a no-op."
elif [ "$VERIFIED_COUNT" -eq 0 ]; then
  # Review has no repair path, so unlike B6.5 this does not fail: notice only, no PASSED marker (a repaired spec is re-evaluated).
  run gh_i issue comment "$NUMBER" --body "<!-- FORGE:ACCEPTANCE_GATE_REVIEW -->
## Review Acceptance Gate: SKIPPED (malformed checks)

Every deferred (phase=review) acceptance check was malformed, so none could be verified. This is not a failure and does not block merge.
$MALFORMED_SECTION"
  echo "Review acceptance gate: all deferred checks malformed; non-blocking notice posted."
elif [ "$GATE_PASS" = "true" ]; then
  run gh_i issue comment "$NUMBER" --body "<!-- FORGE:ACCEPTANCE_GATE_REVIEW -->
## Review Acceptance Gate: PASSED

Deferred (phase=review) acceptance checks verified against the PR:
$(echo -e "$RESULTS")
$MALFORMED_SECTION

<!-- FORGE:ACCEPTANCE_GATE_REVIEW:PASSED:${HEAD_SHA} -->"
else
  run gh_i issue comment "$NUMBER" --body "<!-- FORGE:ACCEPTANCE_GATE_REVIEW -->
## Review Acceptance Gate: FAILED

The following deferred (phase=review) acceptance checks did not pass against the PR:

$(echo -e "$FAILED")
$MALFORMED_SECTION

Merge is blocked. Fix the PR (for example its body) and re-run the review phase.

<!-- FORGE:ACCEPTANCE_GATE_REVIEW:FAILED -->"
  run gh_i issue edit "$NUMBER" --add-label "needs-human"
  printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number:\n  pr_url:\n  merged_to:\n  blocker: review acceptance gate failed (see FORGE:ACCEPTANCE_GATE_REVIEW comment)\n'
  exit 1
fi
