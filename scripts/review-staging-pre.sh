#!/usr/bin/env bash
# review-staging-pre.sh — deterministic pre-dispatch of the staging->main review (forge#4358): the Phase 0A bundle PR set,
# the 0A open review-finding gate and the 0B.1 bundle review scope, moved out of commands/review-pr-staging.md.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: review-staging-pre.sh bundle --repo R --default D --staging S --pr N --sd DIR
#        review-staging-pre.sh gate   --repo R --pr N --prs-file F
#        review-staging-pre.sh scope  --repo R --default D --staging S --pr N --prs-file F --sd DIR
#   bundle  fetches D and S, prints the bundle PR list and writes DIR/<N>_bundle-prs.txt (same file the spec persists).
#           Exit 1 when the fetch fails or the bundle PR set is empty (fail closed: never an empty bundle to gate).
#   gate    open review-finding gate: posts FORGE:GATE_FAILURE / FORGE:GATE_PASS on PR N (bodies unchanged from the spec).
#           Exit 0 = pass (or trusted override, last line "RESULT: PASS"), 1 = blocked. An empty --prs-file or any failed
#           gh read blocks (TYPE=gate-read-failure, never waived by an override): no GATE_PASS without real reads (forge#4470).
#   scope   0B.1: writes DIR/<N>_scope.env (printf %q, read by 7A), DIR/<N>_bundle-pr-files.txt and DIR/<N>_scope.json
#           {scope_mode, reviewed_pr_count, reviewed_commits, unreviewed_commits, unreviewed_files, cross_pr_files,
#           deploy_wiring_files, degraded_prs}; prints the one-line SCOPE_MODE summary. Per-PR reads run FORGE_SCOPE_PARALLELISM (default 8) at a time
#           and retry; a PR whose read still fails is degraded (its commits stay unreviewed) and the rest stay scoped. Global failures widen to full.
# Exit: 2 on a usage error.
#
# The `# BEGIN <name>` ... `# END <name>` blocks below are byte-identical copies of the spec's blocks ({GH_REPO} -> $GH_REPO);
# scripts/review-staging-pre.test.sh fails when they drift. Helpers (trusted-comments.sh, review-delta.sh) resolve through
# forge_resolve from trusted install roots only, never the working directory or the repo under review.
# Bash 3.2 portable except where the copied spec code already uses grep -P (0A Step 1).
set -u

CMD="${1:-}"; [ $# -gt 0 ] && shift
GH_REPO=""; DEFAULT_BRANCH=""; STAGING_BRANCH=""; PR_NUMBER=""; PRS_FILE=""; SD=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "review-staging-pre: $1 requires a value" >&2; exit 2; }
  case "$1" in
    --repo) GH_REPO="$2" ;;
    --default) DEFAULT_BRANCH="$2" ;;
    --staging) STAGING_BRANCH="$2" ;;
    --pr) PR_NUMBER="$2" ;;
    --prs-file) PRS_FILE="$2" ;;
    --sd) SD="$2" ;;
    *) echo "review-staging-pre: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift 2
done
case "$CMD" in bundle|gate|scope) ;; *) echo "review-staging-pre: unknown subcommand '${CMD}' (bundle|gate|scope)" >&2; exit 2 ;; esac
case "$PR_NUMBER" in ''|*[!0-9]*) echo "review-staging-pre: --pr must be numeric" >&2; exit 2 ;; esac
case "$GH_REPO" in *[!A-Za-z0-9._/-]*|*/*/*|/*|*/|'') echo "review-staging-pre: invalid --repo" >&2; exit 2 ;; */*) ;; *) echo "review-staging-pre: --repo must be owner/name" >&2; exit 2 ;; esac
if [ "$CMD" != gate ]; then
  for _b in "$DEFAULT_BRANCH" "$STAGING_BRANCH"; do
    case "$_b" in ''|-*|*[!A-Za-z0-9._/-]*) echo "review-staging-pre: --default/--staging must be branch names" >&2; exit 2 ;; esac
  done
  [ -n "$SD" ] || { echo "review-staging-pre: --sd is required" >&2; exit 2; }
  mkdir -p "$SD" || exit 2
  export FORGE_SCRATCHPAD="$SD"
fi
_SD="${SD:-${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}}"

# BEGIN gh-retry
# gh_retry [--search] CMD...: run CMD up to FORGE_GH_RETRY_ATTEMPTS (default 6) times with exponential backoff from
# FORGE_GH_RETRY_SLEEP seconds (default 2, capped at 16 per wait; --search triples the base for the 30 req/min search API).
# Prints stdout of the first success and returns 0; returns 1 once every attempt failed, so callers still fail closed/open as before (forge#4572).
gh_retry() {
  local mult=1 n=0 max="${FORGE_GH_RETRY_ATTEMPTS:-6}" base="${FORGE_GH_RETRY_SLEEP:-2}" w out
  [ "${1:-}" = --search ] && { mult=3; shift; }
  case "$max" in ''|*[!0-9]*|0) max=6 ;; esac
  case "$base" in ''|*[!0-9]*) base=2 ;; esac
  while :; do
    out=$("$@") && { printf '%s' "$out"; return 0; }
    n=$((n+1)); [ "$n" -ge "$max" ] && return 1
    w=$((base * mult * (1 << (n-1)))); [ "$w" -gt $((16*mult)) ] && w=$((16*mult))
    [ "$w" -gt 0 ] && sleep "$w"
  done
}
# END gh-retry
# One review-finding search fetch; fails (so gh_retry retries) on a gh error or non-array output.
fetch_findings() {
  local raw
  raw=$(gh issue list -R "$GH_REPO" --label "review-finding" --state open --search "PR #${1}" --limit 20 --json number,title,body 2>/dev/null) || return 1
  printf '%s' "$raw" | jq -e 'type == "array"' >/dev/null 2>&1 || return 1
  printf '%s' "$raw"
}
ALL_PR_NUMBERS=""
if [ "$CMD" != bundle ]; then
  [ -n "$PRS_FILE" ] || { echo "review-staging-pre: --prs-file is required" >&2; exit 2; }
  [ -r "$PRS_FILE" ] || { echo "review-staging-pre: --prs-file $PRS_FILE is not readable (run bundle first)" >&2; exit 2; }
  ALL_PR_NUMBERS=$(grep -E '^[0-9]+$' "$PRS_FILE")
fi

# --- trusted helper resolution (install roots only; never cwd) ---
# shellcheck source=/dev/null  # the resolver lib is found at runtime in the trusted install root
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; _SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" "${CLAUDE_PLUGIN_ROOT:-}" "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/* "$_SELF_ROOT"; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }

if [ "$CMD" = bundle ]; then
git fetch origin $DEFAULT_BRANCH $STAGING_BRANCH || { echo "review-staging-pre: git fetch origin $DEFAULT_BRANCH $STAGING_BRANCH failed: bundle PR set unknown (fail closed)" >&2; exit 1; }

# Step 1: Find all PR numbers in the staging→main bundle
# These are the PRs whose commits are included in staging but not yet in main
BUNDLE_PRS=$(git log origin/$DEFAULT_BRANCH..origin/$STAGING_BRANCH --oneline \
  | grep -oE '#[0-9]+' \
  | sort -u \
  | tr -d '#')

# Also extract PR numbers from merge commit subjects (most reliable)
MERGE_PRS=$(git log origin/$DEFAULT_BRANCH..origin/$STAGING_BRANCH --merges --oneline \
  | sed -n 's/.*pull request #\([0-9][0-9]*\).*/\1/p' \
  | sort -u)

# BEGIN bundle-pr-set
# Conventional commit subjects cite issues too ("fix(x): ... (#123)"), so a subject-only number is kept only when it is not a confirmed issue.
# Merge-subject numbers are PRs by construction; an unclassifiable number is kept (fail open: it may be a PR). forge#4127
# BEGIN bundle-pr-kind
# Prints "pr" or "issue" for issue number ${2} in repo ${1}; prints nothing and returns 1 when the read fails or is malformed.
bundle_pr_kind() { local k; k=$(gh_retry gh api "repos/${1}/issues/${2}" --jq 'if .pull_request then "pr" else "issue" end' 2>/dev/null) || return 1; case "$k" in pr|issue) printf '%s' "$k" ;; *) return 1 ;; esac; }
# END bundle-pr-kind
SUBJECT_PRS=""; SKIPPED_ISSUES=""
for n in $BUNDLE_PRS; do
  case " $(echo $MERGE_PRS) " in *" $n "*) continue ;; esac
  if [ "$(bundle_pr_kind "$GH_REPO" "$n")" = issue ]; then SKIPPED_ISSUES="$SKIPPED_ISSUES $n"; else SUBJECT_PRS="$SUBJECT_PRS $n"; fi
done
ALL_PR_NUMBERS=$(echo "$SUBJECT_PRS $MERGE_PRS" | tr ' ' '\n' | sort -u | grep -E '^[0-9]+$')
# END bundle-pr-set

echo "PRs in staging→main bundle: $(echo $ALL_PR_NUMBERS | tr '\n' ' ')"
[ -z "$SKIPPED_ISSUES" ] || echo "Issue numbers cited in commit subjects (not bundle PRs, skipped):$SKIPPED_ISSUES"
# Persist for the 0B.1 fence (a later Bash call is a fresh shell); keyed by the PR number resolved in Phase -1.
if [ -n "${PR_NUMBER:-}" ]; then
  _SD="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}"; mkdir -p "$_SD"
  printf '%s\n' "$ALL_PR_NUMBERS" > "$_SD/${PR_NUMBER}_bundle-prs.txt"
fi
[ -n "$ALL_PR_NUMBERS" ] || { echo "review-staging-pre: the staging→main bundle PR set is empty: nothing to gate (fail closed)" >&2; exit 1; }
exit 0
fi

if [ "$CMD" = gate ]; then

# Step 2: For each PR in the bundle, check for open review-finding issues and degraded panels
if [ -z "$ALL_PR_NUMBERS" ]; then
  echo "⛔ DEPLOY BLOCKED — the bundle PR list ($PRS_FILE) is empty: nothing was checked, so the gate cannot pass."
  echo "RESULT: BLOCK DEPLOY"
  exit 1
fi
BLOCKING_FINDINGS=""
DEGRADED_REVIEWS=""
READ_FAILURES=""
for pr_num in $ALL_PR_NUMBERS; do
  # Capture each gh read and test its own status (as the scope step does): a failed read is never "not degraded" / "no findings".
  IS_REVIEW_DEGRADED=$(gh_retry gh pr view "$pr_num" -R $GH_REPO --json labels \
    --jq '[.labels[].name] | any(. == "review-degraded")' 2>/dev/null) || IS_REVIEW_DEGRADED=unreadable
  case "$IS_REVIEW_DEGRADED" in true|false) ;; *) READ_FAILURES="$READ_FAILURES #${pr_num}(labels)" ;; esac
  if [ "$IS_REVIEW_DEGRADED" = "true" ]; then
    DEGRADED_REVIEWS="${DEGRADED_REVIEWS}
**PR #${pr_num}** has a \`review-degraded\` label and requires a full fresh-context re-review."
  fi

  # Search for open review-finding issues that reference this PR. The search is only a coarse
  # candidate fetch (full-text, tokenized: it also hits hidden markers and longer numbers), so
  # narrow it with the anchored FINDING_PR_FILTER: title suffix `PR #N)` or a `**Source**: PR #N` line.
  FINDING_PR_FILTER='[.[] | select((.title | endswith("PR #" + $n + ")")) or ((.body // "") | test("(^|\\n)\\*\\*Source\\*\\*: PR #" + $n + "([^0-9]|$)")))] | .[] | "  - #\(.number): \(.title)"'  # FINDING_PR_FILTER
  OPEN_FINDINGS=""
  if _RAW=$(gh_retry --search fetch_findings "$pr_num"); then
    OPEN_FINDINGS=$(printf '%s' "$_RAW" | jq -r --arg n "${pr_num}" "$FINDING_PR_FILTER" 2>/dev/null) || READ_FAILURES="$READ_FAILURES #${pr_num}(findings)"  # uses FINDING_PR_FILTER
  else
    READ_FAILURES="$READ_FAILURES #${pr_num}(findings)"
  fi

  if [ -n "$OPEN_FINDINGS" ]; then
    BLOCKING_FINDINGS="${BLOCKING_FINDINGS}
**PR #${pr_num}** has open review findings:
${OPEN_FINDINGS}"
  fi
done

# An unreadable review state is not a known finding either: block before any override is consulted (forge#4470).
if [ -n "$READ_FAILURES" ]; then
  echo "⛔ DEPLOY BLOCKED — could not read review state for bundle PR(s):${READ_FAILURES}"
  echo "Re-run the gate once GitHub reads succeed."
  echo "RESULT: BLOCK DEPLOY"
  if [ -n "$PR_NUMBER" ]; then
    gh pr comment "$PR_NUMBER" -R $GH_REPO --body "<!-- FORGE:GATE_FAILURE -->
## Deploy Gate: BLOCKED

**Gate**: open-review-finding (read failure)
**Unreadable**:${READ_FAILURES}

The degraded-label or open review-finding reads failed, so the gate cannot certify the bundle. Re-run the staging review once GitHub reads succeed.

<!-- FORGE:GATE_FAILURE:TYPE=gate-read-failure -->" 2>/dev/null || true
  fi
  exit 1
fi

# A degraded panel is a review-integrity failure, not a finding that an override may waive.
if [ -n "$DEGRADED_REVIEWS" ]; then
  echo "⛔ DEPLOY BLOCKED — An included PR has an incomplete isolated review panel."
  echo "$DEGRADED_REVIEWS"
  if [ -n "$PR_NUMBER" ]; then
    gh pr comment "$PR_NUMBER" -R $GH_REPO --body "<!-- FORGE:GATE_FAILURE -->
## Deploy Gate: BLOCKED

**Gate**: review-panel-integrity

### Degraded Review Panels

${DEGRADED_REVIEWS}

Re-run the complete review panel in a fresh session before deployment.

<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity -->" 2>/dev/null || true
  fi
  exit 1
fi

# Step 3: Block deploy if open findings exist (unless human override present)
if [ -n "$BLOCKING_FINDINGS" ]; then
  # Check for human override comment on the staging→main PR
  if [ -n "$PR_NUMBER" ]; then
    # Trusted authors only (scripts/trusted-comments.sh: OWNER/MEMBER/COLLABORATOR or a Bot), all comment pages,
    # marker anchored at the start of the body. Fail closed: unresolvable script or unreadable comments = no override (#3492).
    TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
    OVR_SCRIPT="$TRUSTED_SCRIPT"
    OVR_COMMENTS=$(gh api --paginate "repos/$GH_REPO/issues/${PR_NUMBER}/comments" 2>/dev/null) || OVR_COMMENTS=""
    if [ -n "$OVR_SCRIPT" ] && [ -n "$OVR_COMMENTS" ]; then
      OVERRIDE=$(printf '%s' "$OVR_COMMENTS" | bash "$OVR_SCRIPT" count '^OVERRIDE: shipping with open findings' 2>/dev/null || echo 0)
    else
      OVERRIDE=0
    fi
  else
    OVERRIDE=0
  fi

  if [ "${OVERRIDE:-0}" -eq 0 ]; then
    echo "⛔ DEPLOY BLOCKED — Open review-finding issues exist for PRs in this bundle."
    echo ""
    echo "$BLOCKING_FINDINGS"
    echo ""
    echo "Options:"
    echo "  1. Wait for the open findings to be fixed and merged to staging first."
    echo "  2. Post a comment on this PR starting with \"OVERRIDE: shipping with open findings — <reason>\" to bypass this gate."
    echo ""
    echo "This gate exists to prevent deploying commits with known unfixed review findings."
    echo "RESULT: BLOCK DEPLOY"

    # Post structured FORGE:GATE_FAILURE comment for pipeline-health tracking
    FINDING_COUNT=$(echo "$BLOCKING_FINDINGS" | grep -c '^\s*- #' || echo "unknown")
    GATE_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    if [ -n "$PR_NUMBER" ]; then
      gh pr comment "$PR_NUMBER" -R $GH_REPO --body "<!-- FORGE:GATE_FAILURE -->
## Deploy Gate: BLOCKED

**Gate**: open-review-finding
**Timestamp**: ${GATE_TIMESTAMP}
**Blocking findings**: ${FINDING_COUNT}

### Open Review-Finding Issues

${BLOCKING_FINDINGS}

### Resolution

Fix the open findings above and merge fixes to staging before retrying the staging→main deploy.
To override (ship known issues with documented reason), post a comment starting with:
\`OVERRIDE: shipping with open findings — <reason>\`

<!-- FORGE:GATE_FAILURE:TYPE=open-review-finding|FINDINGS=${FINDING_COUNT} -->" 2>/dev/null || true
    fi
    exit 1
  else
    echo "⚠️  Open review findings exist but human override detected — proceeding with deploy."
    echo "$BLOCKING_FINDINGS"
    echo "Override comment found on PR #${PR_NUMBER}. Continuing."
  fi
else
  echo "✅ Open review-finding gate: PASSED — no open findings for PRs in this bundle."
  # Post FORGE:GATE_PASS for symmetric observability — bypass is indistinguishable from clean pass without this
  if [ -n "$PR_NUMBER" ]; then
    gh pr comment "$PR_NUMBER" -R $GH_REPO --body "<!-- FORGE:GATE_PASS -->
## Deploy Gate: PASSED

**Gate**: open-review-finding check
**Result**: PASS — no open \`review-finding\` issues exist for PRs in this bundle.
**Bundle PRs**: ${ALL_PR_NUMBERS}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

<!-- FORGE:GATE_PASS:TYPE=open-review-finding -->" 2>/dev/null || true
  fi
fi
echo "RESULT: PASS"
exit 0
fi

# scope
SCOPE_MODE=full; REVIEWED_COMMITS=""; REVIEWED_MERGES=""; DEPLOY_WIRING_FILES=""; UNREVIEWED_COMMITS=""; UNREVIEWED_FILES=""; _LOG=""; CROSS_PR_FILES=""; REVIEWED_PR_COUNT=0
_PF="$_SD/${PR_NUMBER}_bundle-pr-files.txt"; : > "$_PF"
[ -n "${PR_NUMBER:-}" ] && [ -n "${GH_REPO:-}" ] || echo "SCOPE_MODE=full: scoping skipped (PR_NUMBER or GH_REPO empty after reload)"
[ -n "${ALL_PR_NUMBERS:-}" ] || echo "SCOPE_MODE=full: scoping skipped (ALL_PR_NUMBERS empty: Phase 0A did not persist a bundle list)"
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
[ -n "$TRUSTED_SCRIPT" ] || echo "SCOPE_MODE=full: scoping skipped (trusted-comments.sh not resolvable)"
REVIEW_DELTA_SCRIPT=$(forge_resolve review-delta.sh)
[ -n "$REVIEW_DELTA_SCRIPT" ] || echo "delta credit off: review-delta.sh not resolvable (stale-head PR commits stay UNREVIEWED)"
# BEGIN bundle-delta-credit
is_sha() { case "${1}" in *[!0-9a-f]*|"") return 1 ;; esac; [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]; }
# Partial credit for a PR whose head moved after its last complete review. Only the shared resolver (scripts/review-delta.sh) decides; nothing is re-derived here.
# Needs pr _HEAD _J _CM _SD GH_REPO TRUSTED_SCRIPT REVIEW_DELTA_SCRIPT in scope. Sets DELTA_COMMITS (space-separated PR commit oids already covered by a trusted complete panel) and DELTA_FULL (1 = whole PR covered by a trusted carried-forward base sync).
# Every failure (script unresolved, FULL, error, malformed output, force-push, untrusted or absent carried record, git read failure) leaves DELTA_COMMITS empty and DELTA_FULL=0: those commits stay UNREVIEWED.
bundle_delta_credit() {
  local base labels top cf out l1 kind arg from to oid rc n
  DELTA_COMMITS=""; DELTA_FULL=0
  [ -n "$REVIEW_DELTA_SCRIPT" ] || return 0
  base=$(printf '%s' "$_J" | jq -r '.baseRefName // empty') || return 0
  labels=$(printf '%s' "$_J" | jq -r '[.labels[].name] | join(",")') || return 0
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  [ -n "$base" ] && [ -n "$top" ] || return 0
  cf=$(mktemp "$_SD/delta-comments.XXXXXX") || return 0
  printf '%s' "$_CM" > "$cf" || { rm -f "$cf"; return 0; }
  out=$(bash "$REVIEW_DELTA_SCRIPT" --pr "$pr" --head "$_HEAD" --base "$base" --trusted-script "$TRUSTED_SCRIPT" --comments-file "$cf" --labels "$labels" --repo "$GH_REPO" --repo-path "$top" 2>/dev/null) || out=""
  rm -f "$cf"
  l1=$(printf '%s\n' "$out" | sed -n 1p)
  kind="${l1%% *}"; arg="${l1#* }"
  case "$kind" in
    DELTA)
      from="${arg%%..*}"; to="${arg##*..}"
      is_sha "$from" && [ "$to" = "$_HEAD" ] && [ "$from" != "$to" ] || return 0
      for oid in $(printf '%s' "$_J" | jq -r '.commits[].oid'); do
        git merge-base --is-ancestor "$oid" "$from" 2>/dev/null; rc=$?
        [ "$rc" -eq 0 ] && DELTA_COMMITS="$DELTA_COMMITS $oid"   # rc 1 (not covered) and rc >1 (error) both stay UNREVIEWED
      done ;;
    BASE_SYNC_ONLY)
      is_sha "$arg" && [ "$arg" != "$_HEAD" ] || return 0
      # A marker alone never counts: a TRUSTED FORGE:REVIEW-CARRIED record for this head must name the same reviewed sha (shape owned by review-pr.md carry_verified_from).
      n=$(printf '%s' "$_CM" | bash "$TRUSTED_SCRIPT" count "\\A(?=[\\s\\S]*\\nReviewed-SHA: ${_HEAD}\\r?(\\n|$))(?=[\\s\\S]*\\nCarried-From-SHA: ${arg}\\r?(\\n|$))<!-- FORGE:REVIEW-CARRIED -->" 2>/dev/null) || return 0
      case "$n" in ''|*[!0-9]*) return 0 ;; esac
      [ "$n" -ge 1 ] && DELTA_FULL=1 ;;
  esac
  return 0
}
# END bundle-delta-credit
# BEGIN bundle-pr-kind
# Prints "pr" or "issue" for issue number ${2} in repo ${1}; prints nothing and returns 1 when the read fails or is malformed.
bundle_pr_kind() { local k; k=$(gh_retry gh api "repos/${1}/issues/${2}" --jq 'if .pull_request then "pr" else "issue" end' 2>/dev/null) || return 1; case "$k" in pr|issue) printf '%s' "$k" ;; *) return 1 ;; esac; }
# END bundle-pr-kind
# BEGIN bundle-scope-loop
_WHY=""; DEGRADED_PRS=""
# scope_one_pr PR DIR: every read for one bundle PR, run in its own subshell. Writes DIR/status ("ok", "issue" or "degraded <why>") and, for ok,
# DIR/pf (the "<pr> <file>" lines), DIR/reviewed (0|1), DIR/commits, DIR/merges. A failed read is retried (gh_retry) and then degrades THIS PR only:
# it is credited no commits, so they stay UNREVIEWED and are reviewed (widening, never narrowing); it never changes the bundle's scope mode (#4960).
scope_one_pr() {
  pr="$1"; _D="$2"
  _degrade() { printf 'degraded %s\n' "$1" > "$_D/status"; }
  # A number 0A could not classify may be an issue (subjects cite issues): a confirmed issue is skipped (forge#4127).
  _J=$(gh_retry gh pr view "$pr" -R $GH_REPO --json headRefOid,mergeCommit,commits,state,baseRefName,labels 2>/dev/null) || {
    if [ "$(bundle_pr_kind "$GH_REPO" "$pr")" = issue ]; then echo issue > "$_D/status"; else _degrade "gh pr view failed and #$pr is not a confirmed issue"; fi
    return 0; }
  _HEAD=$(printf '%s' "$_J" | jq -r '.headRefOid') || { _degrade "unreadable pr view output"; return 0; }
  # a malformed head id would make the sha match accept any comment (fail open): this PR gets no credit
  case "$_HEAD" in *[!0-9a-f]*|"") _degrade "malformed head id"; return 0 ;; esac
  [ "${#_HEAD}" -eq 40 ] || [ "${#_HEAD}" -eq 64 ] || { _degrade "malformed head id"; return 0; }
  _HEAD7=$(printf '%s' "$_HEAD" | cut -c1-7)
  # Capture each gh read into a variable FIRST and test its own exit status: in a pipeline `||` only sees the last stage (no pipefail),
  # so a failed gh read piped into another command would silently look like "no comments" / "no files".
  _CM=$(gh_retry gh api --paginate "repos/$GH_REPO/issues/$pr/comments" 2>/dev/null) || { _degrade "comments read failed"; return 0; }
  _FILES=$(gh_retry gh pr diff "$pr" -R $GH_REPO --name-only 2>/dev/null) || { _degrade "file list read failed"; return 0; }
  # Reviewed = trusted FORGE:REVIEW_ROUTE (a real review mode) whose sha is the PR's FINAL head, plus at least one review-agent comment
  # carrying the full-length `Reviewed-SHA: <head>` line and a findings block (same predicate as review-pr.md Phase 5; a 7-char substring or a comment with no findings block never counts), and no degraded/blocked review marker. A PR pushed to after its review has a stale sha: the exact-head gate gives it no credit, and only the delta branch below (shared resolver `scripts/review-delta.sh`) may credit the commits an earlier trusted complete panel covered or a trusted `FORGE:REVIEW-CARRIED` base sync carried; everything else stays UNREVIEWED.
  _ROUTE=$(printf '%s' "$_CM" | bash "$TRUSTED_SCRIPT" count "^<!-- FORGE:REVIEW_ROUTE mode=(?!spec-evolution-blocked)[^ ]+ spec=review-pr.md sha=${_HEAD7} -->") || { _degrade "marker count failed"; return 0; }
  _AGENT=$(printf '%s' "$_CM" | bash "$TRUSTED_SCRIPT" count "^(?=[\\s\\S]*<!-- REVIEW-FINDINGS-START -->[\\s\\S]*<!-- REVIEW-FINDINGS-END -->)<!-- FORGE:REVIEW-AGENT:[a-z-]+ -->[\\s\\S]*(^|\\n)Reviewed-SHA: ${_HEAD}(\\r?\\n|$)") || { _degrade "marker count failed"; return 0; }
  _DEGRADED=$(printf '%s' "$_CM" | bash "$TRUSTED_SCRIPT" count "^<!-- FORGE:(REVIEW_DEGRADED|REVIEW_BLOCKED)") || { _degrade "marker count failed"; return 0; }
  case "$_ROUTE$_AGENT$_DEGRADED" in ''|*[!0-9]*) _degrade "malformed marker count"; return 0 ;; esac
  _NC=$(printf '%s' "$_J" | jq '.commits|length') || { _degrade "unreadable commit list"; return 0; }
  _ALLC=$(printf '%s' "$_J" | jq -r '[.commits[].oid, .mergeCommit.oid // empty] | join(" ")') || { _degrade "unreadable commit list"; return 0; }
  _MERGEC=$(printf '%s' "$_J" | jq -r '.mergeCommit.oid // empty') || { _degrade "unreadable commit list"; return 0; }
  _REV=0; _COMMITS=""; _MERGES=""
  if [ "$_ROUTE" -ge 1 ] && [ "$_AGENT" -ge 1 ] && [ "$_DEGRADED" -eq 0 ] && [ "$_NC" -lt 100 ]; then
    _REV=1; _COMMITS="$_ALLC"; _MERGES="$_MERGEC"
  elif [ "$_DEGRADED" -eq 0 ] && [ "$_NC" -lt 100 ]; then
    # Stale head: the exact-head gate failed, so ask the shared resolver how much of the PR an earlier trusted complete panel covered. Additive only: it can move commits out of UNREVIEWED, never into it.
    bundle_delta_credit
    if [ "$DELTA_FULL" -eq 1 ]; then _REV=1; _COMMITS="$_ALLC"; _MERGES="$_MERGEC"
    elif [ -n "$DELTA_COMMITS" ]; then _COMMITS="$DELTA_COMMITS"   # the PR's merge commit is not credited: it contains the post-review commits
    fi
  fi
  printf '%s\n' "$_REV" > "$_D/reviewed"; printf '%s' "$_COMMITS" > "$_D/commits"; printf '%s' "$_MERGES" > "$_D/merges"
  printf '%s\n' "$_FILES" | sort -u | sed "s|^|$pr |" > "$_D/pf"
  echo ok > "$_D/status"
}
if [ -n "$TRUSTED_SCRIPT" ] && [ -n "${ALL_PR_NUMBERS:-}" ] && [ -n "${PR_NUMBER:-}" ] && [ -n "${GH_REPO:-}" ]; then
  SCOPE_MODE=scoped
  _W=$(mktemp -d "$_SD/scope-work.XXXXXX") || { SCOPE_MODE=full; _WHY="cannot create a scratch dir under $_SD"; }
  if [ "$SCOPE_MODE" = scoped ]; then
    _P="${FORGE_SCOPE_PARALLELISM:-8}"; case "$_P" in ''|*[!0-9]*|0) _P=8 ;; esac
    _TOT=$(echo $ALL_PR_NUMBERS | wc -w | tr -d ' '); _N=0; _ACTIVE=0; _NEXT=25
    echo "0B.1: reading $_TOT bundle PR(s), $_P at a time" >&2
    for pr in $ALL_PR_NUMBERS; do
      mkdir -p "$_W/$pr"
      ( scope_one_pr "$pr" "$_W/$pr" ) &
      _ACTIVE=$((_ACTIVE+1)); _N=$((_N+1))
      if [ "$_ACTIVE" -ge "$_P" ]; then wait; _ACTIVE=0; fi
      if [ "$_N" -ge "$_NEXT" ]; then echo "0B.1: $_N/$_TOT PR(s) dispatched" >&2; _NEXT=$((_NEXT+25)); fi
    done
    wait
    echo "0B.1: all $_TOT PR read(s) done; merging" >&2
    for pr in $ALL_PR_NUMBERS; do
      _S=$(cat "$_W/$pr/status" 2>/dev/null) || _S=""   # a subshell that died leaves no status: degrade this PR
      case "$_S" in
        ok)
          REVIEWED_PR_COUNT=$((REVIEWED_PR_COUNT + $(cat "$_W/$pr/reviewed")))
          REVIEWED_COMMITS="$REVIEWED_COMMITS $(cat "$_W/$pr/commits")"
          REVIEWED_MERGES="$REVIEWED_MERGES $(cat "$_W/$pr/merges")"
          cat "$_W/$pr/pf" >> "$_PF" ;;
        issue) echo "0B.1: #$pr is an issue, not a bundle PR: skipped" ;;
        *) _WHY="${_S#degraded }"; [ -n "$_S" ] || _WHY="scope read of #$pr produced no result"
           DEGRADED_PRS="$DEGRADED_PRS $pr"
           echo "0B.1: scope degraded for PR #$pr ($_WHY): its commits stay UNREVIEWED; scope stays scoped for the rest" ;;
      esac
    done
    rm -rf "$_W"
  fi
  [ "$SCOPE_MODE" = scoped ] || echo "SCOPE_MODE=full: scoping fell open (${_WHY:-a scope read failed})"
fi
# END bundle-scope-loop
if [ "$SCOPE_MODE" = "scoped" ]; then
  # Cross-PR interactions: files touched by 2+ bundle PRs.
  CROSS_PR_FILES=$(cut -d' ' -f2- "$_PF" | sort | uniq -d)
  # Unreviewed commits: on staging, not in main, and not a commit of any reviewed PR (direct pushes, fast-lane fixes, post-review pushes).
  # Merge commits are included: a merge that is not a reviewed PR's own merge commit may carry conflict-resolution content nobody reviewed.
  _LOG=$(git log origin/$DEFAULT_BRANCH..origin/$STAGING_BRANCH --format=%H) || SCOPE_MODE=full
fi
if [ "$SCOPE_MODE" = "scoped" ]; then
  for c in $_LOG; do
    case " $REVIEWED_COMMITS " in *" $c "*) continue ;; esac
    UNREVIEWED_COMMITS="$UNREVIEWED_COMMITS $c"
  done
  # Files of every unreviewed commit (--cc limits a merge commit to its conflict-resolution content), so 7B can test file membership.
  # Each git read is captured and its own status tested (a failure here must widen scope, never narrow it).
  UNREVIEWED_FILES=""
  for c in $UNREVIEWED_COMMITS; do
    _DT=$(git diff-tree --no-commit-id --name-only -r "$c") || { SCOPE_MODE=full; break; }
    _DC=$(git diff-tree --no-commit-id --name-only -r --cc "$c") || { SCOPE_MODE=full; break; }
    UNREVIEWED_FILES="$UNREVIEWED_FILES"$'\n'"$_DT"$'\n'"$_DC"
  done
  # A reviewed PR's own merge commit may carry conflict-resolution content its review never saw: count its --cc files as unreviewed too.
  for c in $REVIEWED_MERGES; do
    _DC=$(git diff-tree --no-commit-id --name-only -r --cc "$c") || { SCOPE_MODE=full; break; }
    UNREVIEWED_FILES="$UNREVIEWED_FILES"$'\n'"$_DC"
  done
  UNREVIEWED_FILES=$(printf '%s\n' "$UNREVIEWED_FILES" | sed '/^$/d' | sort -u)
fi
# Deploy/runtime readiness files are always in scope: migrations, env, workflows, compose/infra, dependency manifests.
_DW=$(git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH --name-only) || { SCOPE_MODE=full; _DW=""; }
DEPLOY_WIRING_FILES=$(printf '%s\n' "$_DW" | grep -E '(^|/)(migrations?/|\.github/workflows/|infra/|deploy/|docker-compose[^/]*\.ya?ml$|\.env[^/]*$|Dockerfile[^/]*$|package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|requirements[^/]*\.txt$|pyproject\.toml$|poetry\.lock$|go\.(mod|sum)$|Cargo\.(toml|lock)$)' || true)
# Persist the results for 7A (a later Bash call is a fresh shell). %q keeps multi-line file lists intact.
printf 'SCOPE_MODE=%q\nCROSS_PR_FILES=%q\nUNREVIEWED_FILES=%q\nDEPLOY_WIRING_FILES=%q\n' "$SCOPE_MODE" "${CROSS_PR_FILES:-}" "${UNREVIEWED_FILES:-}" "${DEPLOY_WIRING_FILES:-}" > "$_SD/${PR_NUMBER}_scope.env"
echo "SCOPE_MODE=$SCOPE_MODE reviewed_prs=$REVIEWED_PR_COUNT unreviewed_commits=$(echo $UNREVIEWED_COMMITS | wc -w) unreviewed_files=$(echo "$UNREVIEWED_FILES" | grep -c .) cross_pr_files=$(echo "$CROSS_PR_FILES" | grep -c .)"
# JSON twin of scope.env for the CLI: commit lists are space separated, file lists newline separated.
_jw() { printf '%s\n' "${1:-}" | tr ' ' '\n' | sed '/^$/d' | jq -R . | jq -s .; }
_jn() { printf '%s\n' "${1:-}" | sed '/^$/d' | jq -R . | jq -s .; }
jq -n --arg mode "$SCOPE_MODE" --argjson n "${REVIEWED_PR_COUNT:-0}" \
  --argjson rc "$(_jw "$REVIEWED_COMMITS")" --argjson uc "$(_jw "$UNREVIEWED_COMMITS")" \
  --argjson uf "$(_jn "${UNREVIEWED_FILES:-}")" --argjson cf "$(_jn "${CROSS_PR_FILES:-}")" --argjson dw "$(_jn "${DEPLOY_WIRING_FILES:-}")" --argjson dp "$(_jw "$DEGRADED_PRS" | jq -c "map(tonumber)")" \
  '{scope_mode: $mode, reviewed_pr_count: $n, reviewed_commits: $rc, unreviewed_commits: $uc, unreviewed_files: $uf, cross_pr_files: $cf, deploy_wiring_files: $dw, degraded_prs: $dp}' \
  > "$_SD/${PR_NUMBER}_scope.json" || { echo "review-staging-pre: could not write ${PR_NUMBER}_scope.json" >&2; exit 1; }
exit 0
