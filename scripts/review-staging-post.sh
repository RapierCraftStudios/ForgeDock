#!/usr/bin/env bash
# review-staging-post.sh — deterministic post-dispatch checks of the staging->main review (forge#4359): the incomplete-panel guard,
# Phase 6.75 agent delivery verification and the Phase 6.5 test-gate verdict handling, moved out of commands/review-pr-staging.md.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: review-staging-post.sh delivery  --repo R --pr N --sd DIR [--head SHA]
#        review-staging-post.sh test-gate --repo R --pr N --sd DIR --output FILE --prs-file F
#                                         [--default BRANCH] [--config forge.yaml] [--posture blocking|advisory] [--override-phrase TEXT]
#   delivery   counts trusted, current-head FORGE:REVIEW-AGENT comments (findings block required) for every domain listed in
#              DIR/<N>_launched_review_agents. A shortfall labels the PR review-degraded + needs-human and posts
#              FORGE:GATE_FAILURE:TYPE=review-panel-integrity; an empty/unreadable list or a missing domain is a delivery failure.
#              Exit 0 = every launched reviewer delivered, 1 = not.
#   test-gate  reads the saved /test-gate output FILE (the last FORGE:TEST_GATE:RESULT= marker; an absent marker stays empty and
#              fails closed as BLOCK, never SKIP), applies the trusted override, the posture and the FORGE:GATE_PASS /
#              FORGE:GATE_FAILURE test-gate comments, and persists DIR/<N>_test_gate_verdict and _reason.
#              Exit 0 = continue, 1 = RESULT: BLOCK DEPLOY.
# Exit: 2 on a usage error.
#
# The `# BEGIN <name>` ... `# END <name>` blocks below are the spec's former fences, copied without their forge_resolve locator
# stubs (this script resolves helpers once, below). Helpers (trusted-comments.sh) resolve through forge_resolve from trusted
# install roots only, never the working directory or the repo under review.
set -u

CMD="${1:-}"; [ $# -gt 0 ] && shift
GH_REPO=""; PR_NUMBER=""; SD=""; HEAD_ARG=""; OUTPUT_FILE=""; PRS_FILE=""; CONFIG_ARG=""; POSTURE_ARG=""; PHRASE_ARG=""; DEFAULT_BRANCH="main"
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "review-staging-post: $1 requires a value" >&2; exit 2; }
  case "$1" in
    --repo) GH_REPO="$2" ;;
    --pr) PR_NUMBER="$2" ;;
    --sd) SD="$2" ;;
    --head) HEAD_ARG="$2" ;;
    --output) OUTPUT_FILE="$2" ;;
    --prs-file) PRS_FILE="$2" ;;
    --config) CONFIG_ARG="$2" ;;
    --posture) POSTURE_ARG="$2" ;;
    --override-phrase) PHRASE_ARG="$2" ;;
    --default) DEFAULT_BRANCH="$2" ;;
    *) echo "review-staging-post: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift 2
done
case "$CMD" in delivery|test-gate) ;; *) echo "review-staging-post: unknown subcommand '${CMD}' (delivery|test-gate)" >&2; exit 2 ;; esac
case "$PR_NUMBER" in ''|*[!0-9]*) echo "review-staging-post: --pr must be numeric" >&2; exit 2 ;; esac
case "$GH_REPO" in *[!A-Za-z0-9._/-]*|*/*/*|/*|*/|'') echo "review-staging-post: invalid --repo" >&2; exit 2 ;; */*) ;; *) echo "review-staging-post: --repo must be owner/name" >&2; exit 2 ;; esac
[ -n "$SD" ] || { echo "review-staging-post: --sd is required" >&2; exit 2; }
mkdir -p "$SD" || exit 2
export FORGE_SCRATCHPAD="$SD"
_SD="$SD"
# A malformed --head is dropped: the blocks re-resolve it and refuse on empty (fail closed).
REVIEW_SHA_FULL="$HEAD_ARG"
case "$REVIEW_SHA_FULL" in *[!0-9a-f]*|"") REVIEW_SHA_FULL="" ;; *) [ "${#REVIEW_SHA_FULL}" -eq 40 ] || [ "${#REVIEW_SHA_FULL}" -eq 64 ] || REVIEW_SHA_FULL="" ;; esac
unset LAUNCHED_REVIEW_AGENTS SELECTED_AGENT_COUNT TEST_GATE_VERDICT TEST_GATE_REASON

# --- trusted helper resolution (install roots only; never cwd) ---
# shellcheck source=/dev/null  # the resolver lib is found at runtime in the trusted install root
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; _SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" "${CLAUDE_PLUGIN_ROOT:-}" "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/* "$_SELF_ROOT"; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }

if [ "$CMD" = delivery ]; then
echo "=== Incomplete-panel guard and Phase 6.75: verify agent delivery ==="
# BEGIN panel-guard
# Each Bash call is a fresh shell: re-resolve the full head SHA if it is not set, and refuse when it is not a commit id
# (an empty SHA would make the Reviewed-SHA match accept any head).
[ -n "${REVIEW_SHA_FULL:-}" ] || REVIEW_SHA_FULL=$(gh pr view "$PR_NUMBER" -R "$GH_REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
case "$REVIEW_SHA_FULL" in *[!0-9a-f]*|"") REVIEW_SHA_FULL="" ;; *) [ "${#REVIEW_SHA_FULL}" -eq 40 ] || [ "${#REVIEW_SHA_FULL}" -eq 64 ] || REVIEW_SHA_FULL="" ;; esac
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
ACTUAL_AGENT_COUNT=0
if [ -n "$REVIEW_SHA_FULL" ] && [ -n "$TRUSTED_SCRIPT" ]; then
  # Only TRUSTED, current-head reviewer comments count, over every page of comments. Unique domains, so a duplicate does not inflate the count.
  ACTUAL_AGENT_COUNT=$(gh api --paginate "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null \
    | bash "$TRUSTED_SCRIPT" bodies "^<!-- FORGE:REVIEW-AGENT:[a-z0-9-]+ -->[\\s\\S]*(^|\\n)Reviewed-SHA:[ ]${REVIEW_SHA_FULL}(\\r?\\n|$)" 2>/dev/null \
    | jq -r 'scan("^<!-- FORGE:REVIEW-AGENT:([a-z0-9-]+) -->") | .[0]' 2>/dev/null | sort -u | grep -c . || echo 0)
fi
case "$ACTUAL_AGENT_COUNT" in ''|*[!0-9]*) ACTUAL_AGENT_COUNT=0 ;; esac   # fail closed: unreadable or untrusted counts as not posted
# Fresh shell: SELECTED_AGENT_COUNT is not carried over. Reload it from the PR-keyed launched-agent file, then fail closed when it is empty, non-integer or zero (a staging review always selects at least one reviewer).
[ -n "${SELECTED_AGENT_COUNT:-}" ] || { [ -n "${PR_NUMBER:-}" ] && [ -r "$_SD/${PR_NUMBER}_launched_review_agents" ] && SELECTED_AGENT_COUNT=$(grep -E '^[a-z0-9-]+$' "$_SD/${PR_NUMBER}_launched_review_agents" | sort -u | grep -c .); }
SELECTED_COUNT_INVALID=false
case "${SELECTED_AGENT_COUNT:-}" in ''|*[!0-9]*|0) SELECTED_COUNT_INVALID=true; SELECTED_AGENT_COUNT=0 ;; esac
if [ "${DISPATCH_FAILED:-}" = "true" ] || [ "$SELECTED_COUNT_INVALID" = "true" ] || [ "$ACTUAL_AGENT_COUNT" -lt "$SELECTED_AGENT_COUNT" ]; then
  gh label create "review-degraded" --color "E4E669" --description "PR review panel was incomplete; re-review required before deployment. Managed by ForgeDock." --force -R "$GH_REPO" 2>/dev/null || true
  gh pr edit "$PR_NUMBER" -R "$GH_REPO" --add-label "review-degraded" --add-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
  gh pr comment "$PR_NUMBER" -R "$GH_REPO" --body "<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity -->
## Deploy Review Blocked: Incomplete Isolated Review Panel

**Selected isolated reviewers**: ${SELECTED_AGENT_COUNT}
**Completed isolated reviewers**: ${ACTUAL_AGENT_COUNT}

Re-run the full staging review in a fresh session before deployment."
  exit 1
fi
# END panel-guard
# BEGIN delivery-check
# Reload the launched-agent list persisted at dispatch (validated: lowercase marker domains only).
[ -n "${LAUNCHED_REVIEW_AGENTS:-}" ] || { [ -r "$_SD/${PR_NUMBER}_launched_review_agents" ] && LAUNCHED_REVIEW_AGENTS=$(grep -E '^[a-z0-9-]+$' "$_SD/${PR_NUMBER}_launched_review_agents" | sort -u | tr '\n' ' '); }
# Fail closed: a staging review always launches at least the Phase 2 material-change agent, so an empty list means lost state or skipped bookkeeping, never "nothing to verify".
if [ -z "${PR_NUMBER:-}" ] || [ -z "${LAUNCHED_REVIEW_AGENTS:-}" ]; then
  echo "REVIEW DELIVERY FAILURE: launched-agent list is empty or unreadable (PR_NUMBER='${PR_NUMBER:-}')"
  echo "Recover the launched reviewer domains from the PR's FORGE:REVIEW-AGENT comments, re-append them to the launched-agent file, and rerun."
  exit 1
fi
MISSING_AGENT_COMMENTS=""
# Each Bash call is a fresh shell: re-resolve the full head SHA if it is not set, and refuse when it is not a commit id
# (an empty SHA would make the Reviewed-SHA match accept any head).
[ -n "${REVIEW_SHA_FULL:-}" ] || REVIEW_SHA_FULL=$(gh pr view "$PR_NUMBER" -R "$GH_REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
case "$REVIEW_SHA_FULL" in *[!0-9a-f]*|"") REVIEW_SHA_FULL="" ;; *) [ "${#REVIEW_SHA_FULL}" -eq 40 ] || [ "${#REVIEW_SHA_FULL}" -eq 64 ] || REVIEW_SHA_FULL="" ;; esac
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
for AGENT_DOMAIN in $LAUNCHED_REVIEW_AGENTS; do
  AGENT_COMMENT_COUNT=0
  if [ -n "$REVIEW_SHA_FULL" ] && [ -n "$TRUSTED_SCRIPT" ]; then
    AGENT_COMMENT_COUNT=$(gh api --paginate "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null \
      | bash "$TRUSTED_SCRIPT" count "^(?=[\\s\\S]*<!-- REVIEW-FINDINGS-START -->[\\s\\S]*<!-- REVIEW-FINDINGS-END -->)<!-- FORGE:REVIEW-AGENT:${AGENT_DOMAIN} -->[\\s\\S]*(^|\\n)Reviewed-SHA:[ ]${REVIEW_SHA_FULL}(\\r?\\n|$)" 2>/dev/null || echo 0)
  fi
  case "$AGENT_COMMENT_COUNT" in ''|*[!0-9]*) AGENT_COMMENT_COUNT=0 ;; esac   # fail closed: counts as missing
  if [ "${AGENT_COMMENT_COUNT:-0}" -lt 1 ]; then
    MISSING_AGENT_COMMENTS="${MISSING_AGENT_COMMENTS} ${AGENT_DOMAIN}"
  fi
done

if [ -n "$MISSING_AGENT_COMMENTS" ]; then
  echo "REVIEW DELIVERY FAILURE: missing findings comment(s) for:${MISSING_AGENT_COMMENTS}"
  echo "A comment without a REVIEW-FINDINGS-START block counts as missing. Re-dispatch the missing agent once with the note: structured findings block required. A second miss is a degraded panel. Recover each agent's returned verdict, findings, and durable body path before rerunning review."
  exit 1
fi
# END delivery-check
echo "DELIVERY: OK (${ACTUAL_AGENT_COUNT}/${SELECTED_AGENT_COUNT} launched reviewers posted a findings block for head ${REVIEW_SHA_FULL})"
exit 0
fi

# test-gate
case "$POSTURE_ARG" in ''|blocking|advisory) ;; *) echo "review-staging-post: --posture must be blocking or advisory" >&2; exit 2 ;; esac
[ -n "$PRS_FILE" ] || { echo "review-staging-post: --prs-file is required" >&2; exit 2; }
[ -r "$PRS_FILE" ] || { echo "review-staging-post: --prs-file $PRS_FILE is not readable (run the pre-dispatch first)" >&2; exit 2; }
[ -n "$OUTPUT_FILE" ] || { echo "review-staging-post: --output is required (the saved /test-gate output)" >&2; exit 2; }
ALL_PR_NUMBERS=$(grep -E '^[0-9]+$' "$PRS_FILE")
CONFIG_FILE="${CONFIG_ARG:-${FORGE_CONFIG:-forge.yaml}}"
GH_FLAG="-R $GH_REPO"
GATE_POSTURE="$POSTURE_ARG"
[ -n "$GATE_POSTURE" ] || GATE_POSTURE=$(yq '.verification.test_gate.posture // "blocking"' "$CONFIG_FILE" 2>/dev/null || echo "blocking")
case "$GATE_POSTURE" in advisory) ;; *) GATE_POSTURE=blocking ;; esac   # unreadable or unknown is the blocking default
OVERRIDE_PHRASE="$PHRASE_ARG"
[ -n "$OVERRIDE_PHRASE" ] || OVERRIDE_PHRASE=$(yq '.verification.test_gate.override_phrase // "OVERRIDE: shipping with test failures —"' "$CONFIG_FILE" 2>/dev/null || echo "OVERRIDE: shipping with test failures —")
[ -n "$OVERRIDE_PHRASE" ] || OVERRIDE_PHRASE="OVERRIDE: shipping with test failures —"
echo "=== Phase 6.5: Runtime Test Gate ==="
echo "Bundle PRs: $(echo $ALL_PR_NUMBERS | tr '\n' ' ')"
echo "Posture: ${GATE_POSTURE}"
# Reset any stale gate result from a prior run (files are PR-keyed)
rm -f "${_SD:?}/${PR_NUMBER:?}_test_gate_verdict" "${_SD:?}/${PR_NUMBER:?}_test_gate_reason"
TEST_GATE_VERDICT="SKIP"
TEST_GATE_REASON="Phase 6.5 not yet run"
GATE_OUTPUT=""
if [ -r "$OUTPUT_FILE" ]; then GATE_OUTPUT=$(cat "$OUTPUT_FILE"); else echo "WARNING: /test-gate output $OUTPUT_FILE unreadable: treated as a missing result"; fi
# BEGIN test-gate-extract
# Extract machine-readable verdict from Skill output. An absent/invalid marker stays EMPTY (never coerced to SKIP):
# the verdict-handling fence treats an empty verdict as missing/invalid and fails closed under blocking posture.
TEST_GATE_VERDICT=$(echo "$GATE_OUTPUT" | grep -oE 'FORGE:TEST_GATE:RESULT=(BLOCK|PASS|SKIP)' | sed 's/^FORGE:TEST_GATE:RESULT=//' | tail -1)
[ -n "$TEST_GATE_VERDICT" ] || TEST_GATE_REASON="gate result missing/invalid (no FORGE:TEST_GATE:RESULT marker in /test-gate output)"
# END test-gate-extract
echo "Test-gate verdict: ${TEST_GATE_VERDICT}"
printf '%s\n' "$TEST_GATE_VERDICT" > "$_SD/${PR_NUMBER}_test_gate_verdict"; printf '%s\n' "$TEST_GATE_REASON" > "$_SD/${PR_NUMBER}_test_gate_reason"
# BEGIN test-gate-verdict
# Reload the Phase 6.5 gate result persisted by its producer (validated: only a known verdict reaches a gate decision).
[ -n "${TEST_GATE_VERDICT:-}" ] || { [ -r "$_SD/${PR_NUMBER}_test_gate_verdict" ] && TEST_GATE_VERDICT=$(sed -n -E '1{/^(BLOCK|PASS|SKIP)$/p;q}' "$_SD/${PR_NUMBER}_test_gate_verdict"); }
[ -n "${TEST_GATE_REASON:-}" ] || { [ -r "$_SD/${PR_NUMBER}_test_gate_reason" ] && TEST_GATE_REASON=$(sed -n 1p "$_SD/${PR_NUMBER}_test_gate_reason" | tr -d '\r\000-\037' | cut -c1-400); }
# Fail closed: a missing, empty, or unrecognised verdict is never a SKIP. Normalize it to BLOCK so the BLOCK arm applies
# the override check, advisory/blocking posture, and exit 1; GATE_VERDICT_INVALID makes the reasons say missing/invalid.
GATE_VERDICT_INVALID=0
case "${TEST_GATE_VERDICT:-}" in
  BLOCK|PASS|SKIP) ;;
  *)
    GATE_VERDICT_INVALID=1
    if [ -r "$_SD/${PR_NUMBER}_test_gate_verdict" ]; then _GV_WHY="persisted verdict file present but empty/invalid"; else _GV_WHY="persisted verdict file missing"; fi
    echo "⚠️  Test gate: gate result missing/invalid (${_GV_WHY}) — treating as BLOCK, not SKIP."
    TEST_GATE_VERDICT="BLOCK"
    ;;
esac
case "$TEST_GATE_VERDICT" in

  SKIP)
    echo "ℹ️  Test gate: SKIP — no executable changes or tests not configured."
    echo "   This gap will appear in the Phase 8 summary. No deploy impact."
    TEST_GATE_REASON="SKIP — no runtime tests ran (docs-only bundle, no integration tests configured, or manual-only criteria)"
    ;;

  PASS)
    echo "✅ Test gate: PASS — all test clusters passed. Deploy may proceed."
    TEST_GATE_REASON="PASS — all automated test clusters passed"
    # Post FORGE:GATE_PASS for symmetric observability
    if [ -n "$PR_NUMBER" ]; then
      gh pr comment "$PR_NUMBER" ${GH_FLAG} --body "<!-- FORGE:GATE_PASS -->
## Deploy Gate: PASSED

**Gate**: test-gate (runtime acceptance criteria)
**Result**: PASS — all test clusters passed. Deploy may proceed.
**Bundle PRs**: ${ALL_PR_NUMBERS}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

<!-- FORGE:GATE_PASS:TYPE=test-gate|BUNDLE=$(echo $ALL_PR_NUMBERS | tr '\n' ' ' | xargs) -->" 2>/dev/null || true
    fi
    ;;

  BLOCK)
    # Check for override comment on the staging→main PR (mirrors Phase 0A pattern)
    if [ -n "$PR_NUMBER" ]; then
      # Trusted authors only, all comment pages, anchored; fail closed (no override) if the script or comments are
      # unreadable (#3492). OVERRIDE_PHRASE comes from forge.yaml, so regex-escape it before using it as a pattern.
      TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
      TG_SCRIPT="$TRUSTED_SCRIPT"
      TG_COMMENTS=$(gh api --paginate "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null) || TG_COMMENTS=""
      TG_OVERRIDE=0; OVERRIDE_REASON="(reason not captured)"
      if [ -n "$TG_SCRIPT" ] && [ -n "$TG_COMMENTS" ]; then
        TG_RE="^$(printf '%s' "$OVERRIDE_PHRASE" | sed 's/[][\\.^$*+?(){}|\/]/\\&/g')"
        TG_OVERRIDE=$(printf '%s' "$TG_COMMENTS" | bash "$TG_SCRIPT" count "$TG_RE" 2>/dev/null || echo 0)
        [ "${TG_OVERRIDE:-0}" -gt 0 ] && OVERRIDE_REASON=$(printf '%s' "$TG_COMMENTS" | bash "$TG_SCRIPT" bodies "$TG_RE" 2>/dev/null | tail -1 | jq -r '.' 2>/dev/null || echo "(reason not captured)")
      fi
    else
      TG_OVERRIDE=0
    fi

    if [ "${TG_OVERRIDE:-0}" -gt 0 ]; then
      echo "⚠️  Test gate: BLOCK — but override comment detected on PR #${PR_NUMBER}."
      echo "   Override: ${OVERRIDE_REASON}"
      echo "   Proceeding with deploy. Override is logged in Phase 8 summary."
      TEST_GATE_VERDICT="PASS"
      TEST_GATE_REASON="BLOCK downgraded to PASS by override: ${OVERRIDE_REASON}"
      [ "$GATE_VERDICT_INVALID" = 1 ] && TEST_GATE_REASON="BLOCK (gate result missing/invalid) downgraded to PASS by override: ${OVERRIDE_REASON}"

    elif [ "$GATE_POSTURE" = "advisory" ]; then
      echo "⚠️  Test gate: BLOCK (advisory posture) — runtime failures detected but deploy is NOT prevented."
      echo "   Switch verification.test_gate.posture to 'blocking' in forge.yaml to enforce this gate."
      TEST_GATE_REASON="BLOCK (advisory) — runtime failures detected; deploy allowed by advisory posture"
      [ "$GATE_VERDICT_INVALID" = 1 ] && TEST_GATE_REASON="BLOCK (advisory) — gate result missing/invalid; deploy allowed by advisory posture"

    else
      # blocking posture (default) — STOP
      echo "⛔ DEPLOY BLOCKED — /test-gate returned BLOCK verdict."
      [ "$GATE_VERDICT_INVALID" = 1 ] && echo "   (gate result missing/invalid — failing closed; re-run /test-gate or post the override comment)"
      echo ""
      echo "Runtime failures were detected in the staging→${DEFAULT_BRANCH} bundle."
      echo "The failures were batch-introduced (not pre-existing on ${DEFAULT_BRANCH} baseline)."
      echo ""
      echo "Options:"
      echo "  1. Fix the failing tests and merge fixes to staging before retrying the deploy."
      echo "  2. Post a comment on this PR starting with \"${OVERRIDE_PHRASE} <reason>\" to bypass this gate."
      echo "  3. Set verification.test_gate.posture: advisory in forge.yaml to downgrade to a warning."
      echo ""
      echo "RESULT: BLOCK DEPLOY"

      # Post structured FORGE:GATE_FAILURE comment for pipeline-health tracking
      GATE_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      if [ -n "$PR_NUMBER" ]; then
        gh pr comment "$PR_NUMBER" ${GH_FLAG} --body "<!-- FORGE:GATE_FAILURE -->
## Deploy Gate: BLOCKED

**Gate**: test-gate
**Timestamp**: ${GATE_TIMESTAMP}
**Bundle PRs**: $(echo $ALL_PR_NUMBERS | tr '\n' ' ')
**Posture**: ${GATE_POSTURE}

### What Happened

\`/test-gate\` detected runtime failures in the staging→\`${DEFAULT_BRANCH}\` bundle that were NOT present on the \`${DEFAULT_BRANCH}\` baseline. These are batch-introduced regressions. (If the gate result was missing/invalid, no verdict could be read and the gate failed closed; re-run \`/test-gate\`.)

\`/test-gate\` has filed \`test-failure\` issues for each failing cluster — check the issue tracker for details.

### Resolution

1. Fix the failing tests and merge fixes to staging.
2. Retry the staging→\`${DEFAULT_BRANCH}\` deploy.

To override (ship known failures with documented reason), post a comment containing:
\`${OVERRIDE_PHRASE} <reason>\`

<!-- FORGE:GATE_FAILURE:TYPE=test-gate|BUNDLE=$(echo $ALL_PR_NUMBERS | tr '\n' ' ' | xargs) -->" 2>/dev/null || true
      fi
      _GV_REASON="BLOCK (blocking posture, no override)"; [ "$GATE_VERDICT_INVALID" = 1 ] && _GV_REASON="BLOCK (gate result missing/invalid; blocking posture, no override)"
      printf '%s\n' "$TEST_GATE_VERDICT" > "$_SD/${PR_NUMBER}_test_gate_verdict"; printf '%s\n' "$_GV_REASON" > "$_SD/${PR_NUMBER}_test_gate_reason"
      exit 1
    fi
    ;;

  *)
    # Unreachable (normalized above); fail closed regardless — never SKIP.
    echo "⛔ Test gate: gate result missing/invalid ('${TEST_GATE_VERDICT}') — failing closed."
    printf '%s\n' "BLOCK" > "$_SD/${PR_NUMBER}_test_gate_verdict"; printf '%s\n' "BLOCK (gate result missing/invalid)" > "$_SD/${PR_NUMBER}_test_gate_reason"
    exit 1
    ;;

esac
# Persist the gate result: every Bash call is a fresh shell, and the verdict-handling fence and Phase 8 read it back (validated on reload).
printf '%s\n' "$TEST_GATE_VERDICT" > "$_SD/${PR_NUMBER}_test_gate_verdict"; printf '%s\n' "$TEST_GATE_REASON" > "$_SD/${PR_NUMBER}_test_gate_reason"
# END test-gate-verdict
exit 0
