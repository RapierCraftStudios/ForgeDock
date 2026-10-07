---
description: Scan for pipeline-orphaned issues stuck in intermediate workflow states and recover them — diagnose each orphan's actual GitHub state, apply recovery actions, clean up worktrees
argument-hint: "[--dry-run | --since <hours> | --issue <number>]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /recover-orphans — Pipeline Orphan Recovery

> **Skill names**: `{FORGE_SKILL_PREFIX}` is `forgedock:` (plugin install) or empty (`install.sh`), resolved once per run by `commands/work-on.md` § Skill Name Resolution. If the skill is not found under either name, STOP and report "skill not found" — never run the phase inline.

**Input**: $ARGUMENTS

Scan ALL open issues with intermediate workflow labels for orphaned state — issues where the agent died mid-pipeline (context expired, rate-limited, crashed) and no active agent is continuing. Diagnose each orphan's actual GitHub state and apply the appropriate recovery action.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet". Fallback: `model: "opus"` if rate-limited.
**NEVER use plan mode (EnterPlanMode).**
**NEVER use the Agent tool** — recover-orphans re-enters the pipeline via `Skill(skill="{FORGE_SKILL_PREFIX}work-on", ...)` and `Skill(skill="{FORGE_SKILL_PREFIX}review-pr", ...)` only.

<!-- FORGE:SPEC_LOADED — recover-orphans.md loaded and active. Agent is bound by this spec. -->

---

## Config Resolution

Read `forge.yaml` at the project root before running any commands:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
WORKTREE_BASE=$(yq '.paths.worktree_base' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")
```

If `forge.yaml` is missing: stop and tell the user to run `npx forgedock init` to generate it.

---

## Argument Parsing

```bash
DRY_RUN=false
SINCE_HOURS=""
TARGET_ISSUE=""

# Parse flags
for arg in $ARGUMENTS; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --since)      : ;;  # value follows
    --issue)      : ;;  # value follows
  esac
done

# Parse --since <hours> and --issue <number> (value follows flag)
PREV=""
for arg in $ARGUMENTS; do
  if [ "$PREV" = "--since" ]; then
    SINCE_HOURS="$arg"
  elif [ "$PREV" = "--issue" ]; then
    TARGET_ISSUE="$arg"
  fi
  PREV="$arg"
done

echo "=== /recover-orphans: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "DRY_RUN=$DRY_RUN | SINCE_HOURS=${SINCE_HOURS:-all} | TARGET_ISSUE=${TARGET_ISSUE:-all}"
```

| Flag | Effect |
|------|--------|
| (none) | Scan all intermediate-state open issues |
| `--dry-run` | Report-only — print what would be done, no mutations |
| `--since <hours>` | Only scan issues not updated in the last N hours (default: all) |
| `--issue <number>` | Recover a single specific issue |

---

## Phase 1: Find Orphans

**Note**: `gh issue list --label` uses AND semantics when multiple labels are given. To find issues with ANY intermediate workflow label, query each label separately and merge results.

```bash
# Compute stale cutoff if --since was provided
CUTOFF=""
if [ -n "$SINCE_HOURS" ]; then
  CUTOFF=$(python3 -c "
from datetime import datetime, timedelta, timezone
h = int('$SINCE_HOURS')
print((datetime.now(timezone.utc) - timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%SZ'))
" 2>/dev/null || echo "")
fi

if [ -n "$TARGET_ISSUE" ]; then
  # Single-issue mode
  ORPHAN_LIST="$TARGET_ISSUE"
  echo "Single-issue mode: targeting #$TARGET_ISSUE"
else
  # Fleet scan: query each workflow label separately, merge, deduplicate
  ORPHAN_JSON=$(
    for LABEL in "workflow:investigating" "workflow:ready-to-build" "workflow:building" "workflow:in-review"; do
      gh issue list ${GH_FLAG} \
        --state open \
        --label "$LABEL" \
        --limit 100 \
        --json number,title,labels,updatedAt
    done | jq -s '
      flatten |
      unique_by(.number) |
      sort_by(.updatedAt) | reverse |
      .[]
    ')

  # Apply --since filter if specified
  if [ -n "$CUTOFF" ]; then
    ORPHAN_JSON=$(echo "$ORPHAN_JSON" | jq -s --arg cutoff "$CUTOFF" '
      [.[] | select(.updatedAt < $cutoff)] | .[]
    ')
  fi

  ORPHAN_LIST=$(echo "$ORPHAN_JSON" | jq -r '.number' | sort -un)
fi

ORPHAN_COUNT=$(echo "$ORPHAN_LIST" | grep -c '[0-9]' 2>/dev/null || echo 0)
echo "Orphan candidates found: $ORPHAN_COUNT"
```

If `ORPHAN_COUNT` is 0: print `No orphaned issues found — pipeline is clean.` and STOP.

---

## Phase 2: Diagnose Each Orphan

For each issue number in `ORPHAN_LIST`, run the full diagnostic and determine the recovery action.

```bash
# Diagnosis result arrays (accumulated for Phase 3 and Phase 5 report)
declare -A DIAG_ACTION      # issue_num -> action name
declare -A DIAG_REASON      # issue_num -> human-readable reason
declare -A DIAG_PR_NUM      # issue_num -> associated PR number (if any)
declare -A DIAG_BRANCH      # issue_num -> associated branch (if any)

for NUM in $ORPHAN_LIST; do
  echo ""
  echo "--- Diagnosing #$NUM ---"

  # Read current issue state
  ISSUE=$(gh issue view "$NUM" ${GH_FLAG} \
    --json number,title,labels,state,updatedAt,body 2>/dev/null)
  if [ -z "$ISSUE" ]; then
    echo "#$NUM: Could not fetch — skipping"
    continue
  fi

  ISSUE_STATE=$(echo "$ISSUE" | jq -r '.state')
  ISSUE_TITLE=$(echo "$ISSUE" | jq -r '.title')
  ISSUE_LABELS=$(echo "$ISSUE" | jq -r '[.labels[].name] | join(", ")')
  WORKFLOW_LABEL=$(echo "$ISSUE" | jq -r '[.labels[].name | select(startswith("workflow:"))] | first // "none"')

  echo "#$NUM: $ISSUE_TITLE"
  echo "  State: $ISSUE_STATE | Labels: $ISSUE_LABELS"

  # Skip if already in terminal state (race condition: label changed since query)
  if [ "$ISSUE_STATE" = "CLOSED" ]; then
    DIAG_ACTION[$NUM]="skip"
    DIAG_REASON[$NUM]="Issue already closed"
    continue
  fi
  if echo "$ISSUE_LABELS" | grep -qE "workflow:merged|workflow:invalid"; then
    DIAG_ACTION[$NUM]="skip"
    DIAG_REASON[$NUM]="Already in terminal state: $ISSUE_LABELS"
    continue
  fi
  # Check for merged PR referencing this issue
  MERGED_PR=$(gh pr list ${GH_FLAG} \
    --state merged \
    --search "Closes #$NUM" \
    --json number \
    --jq '.[0].number' 2>/dev/null)

  if [ -z "$MERGED_PR" ]; then
    # Also check body/title for issue reference pattern
    MERGED_PR=$(gh pr list ${GH_FLAG} \
      --state merged \
      --search "#$NUM" \
      --limit 20 \
      --json number,body \
      --jq ".[] | select(.body | test(\"Closes #${NUM}|closes #${NUM}|Fix #${NUM}|fix #${NUM}\")) | .number" \
      2>/dev/null | head -1)
  fi

  if [ -n "$MERGED_PR" ]; then
    DIAG_ACTION[$NUM]="label-cleanup"
    DIAG_REASON[$NUM]="PR #$MERGED_PR already merged — update labels and close issue"
    DIAG_PR_NUM[$NUM]="$MERGED_PR"
    echo "  Diagnosis: LABEL-CLEANUP (PR #$MERGED_PR already merged)"
    continue
  fi

  # forge#3148: checked after the merged-PR label cleanup above, so a merged orphan is still closed out.
  # An escalated orphan is waiting on a human — re-running a recovery action every sweep
  # (e.g. re-invoking /review-pr against an unrepaired phase trail) only repeats the same refusal.
  if echo ", $ISSUE_LABELS," | grep -q ", needs-human,"; then
    DIAG_ACTION[$NUM]="skip"
    DIAG_REASON[$NUM]="Escalated (needs-human) — waiting on a human"
    continue
  fi

  # Check for an open PR on any branch associated with this issue
  # Strategy: look for branches with the issue number in the name
  ISSUE_BRANCH=$(git ls-remote --heads origin 2>/dev/null | grep "/$NUM" | sed 's|.*refs/heads/||' | head -1)
  if [ -z "$ISSUE_BRANCH" ]; then
    # Also check recent PR list for a PR referencing this issue
    OPEN_PR_JSON=$(gh pr list ${GH_FLAG} \
      --state open \
      --search "#$NUM" \
      --limit 20 \
      --json number,headRefName,reviewDecision,statusCheckRollup \
      2>/dev/null)
    OPEN_PR_NUM=$(echo "$OPEN_PR_JSON" | jq -r ".[] | select(.body | test(\"#${NUM}\")) | .number" 2>/dev/null | head -1)
  else
    OPEN_PR_JSON=$(gh pr list ${GH_FLAG} \
      --state open \
      --head "$ISSUE_BRANCH" \
      --json number,headRefName,reviewDecision,statusCheckRollup \
      2>/dev/null)
    OPEN_PR_NUM=$(echo "$OPEN_PR_JSON" | jq -r '.[0].number' 2>/dev/null)
  fi

  # If open PR found, diagnose PR state
  if [ -n "$OPEN_PR_NUM" ]; then
    DIAG_BRANCH[$NUM]="${ISSUE_BRANCH:-unknown}"
    DIAG_PR_NUM[$NUM]="$OPEN_PR_NUM"

    # Read PR details
    PR_DETAIL=$(gh pr view "$OPEN_PR_NUM" ${GH_FLAG} \
      --json number,headRefName,reviewDecision,statusCheckRollup,state 2>/dev/null)
    PR_REVIEW=$(echo "$PR_DETAIL" | jq -r '.reviewDecision // "REVIEW_REQUIRED"')
    PR_CI=$(echo "$PR_DETAIL" | jq -r '
      if (.statusCheckRollup == null or (.statusCheckRollup | length) == 0) then "UNKNOWN"
      elif ([.statusCheckRollup[] | select(.conclusion == "FAILURE" or .conclusion == "ERROR")] | length) > 0 then "FAILED"
      elif ([.statusCheckRollup[] | select(.status == "IN_PROGRESS" or .status == "QUEUED" or .status == "PENDING")] | length) > 0 then "PENDING"
      elif ([.statusCheckRollup[] | select(.conclusion == "SUCCESS")] | length) > 0 then "SUCCESS"
      else "UNKNOWN"
      end')
    BRANCH_NAME=$(echo "$PR_DETAIL" | jq -r '.headRefName // ""')
    DIAG_BRANCH[$NUM]="$BRANCH_NAME"

    echo "  PR #$OPEN_PR_NUM found — reviewDecision=$PR_REVIEW | CI=$PR_CI"

    if [ "$PR_REVIEW" = "APPROVED" ] && [ "$PR_CI" = "SUCCESS" ]; then
      DIAG_ACTION[$NUM]="merge-pr"
      DIAG_REASON[$NUM]="PR #$OPEN_PR_NUM approved + CI green — merge and close"
      echo "  Diagnosis: MERGE-PR (approved + CI green)"
    elif [ "$PR_CI" = "FAILED" ]; then
      DIAG_ACTION[$NUM]="escalate-ci"
      DIAG_REASON[$NUM]="PR #$OPEN_PR_NUM has CI failures — manual intervention needed"
      echo "  Diagnosis: ESCALATE-CI (CI failed, needs /fix-ci or manual fix)"
    elif [ "$PR_REVIEW" = "CHANGES_REQUESTED" ]; then
      DIAG_ACTION[$NUM]="escalate-changes"
      DIAG_REASON[$NUM]="PR #$OPEN_PR_NUM has requested changes — needs human review of findings"
      echo "  Diagnosis: ESCALATE-CHANGES (reviewer requested changes)"
    else
      DIAG_ACTION[$NUM]="review-pr"
      DIAG_REASON[$NUM]="PR #$OPEN_PR_NUM exists but not reviewed — invoke /review-pr"
      echo "  Diagnosis: REVIEW-PR (open PR awaiting review)"
    fi
    continue
  fi

  # No open or merged PR — check if a branch exists with commits
  BRANCH_EXISTS=false
  BRANCH_NAME=""
  if [ -n "$ISSUE_BRANCH" ]; then
    BRANCH_EXISTS=true
    BRANCH_NAME="$ISSUE_BRANCH"
  else
    # Try common naming patterns
    for PATTERN in "fix/.*${NUM}" "feat/.*${NUM}" "refactor/.*${NUM}"; do
      FOUND=$(git ls-remote --heads origin 2>/dev/null | grep -oE "fix/[^ ]*${NUM}[^ ]*|feat/[^ ]*${NUM}[^ ]*|refactor/[^ ]*${NUM}[^ ]*" | head -1)
      if [ -n "$FOUND" ]; then
        BRANCH_EXISTS=true
        BRANCH_NAME="$FOUND"
        break
      fi
    done
  fi

  if [ "$BRANCH_EXISTS" = "true" ] && [ -n "$BRANCH_NAME" ]; then
    DIAG_BRANCH[$NUM]="$BRANCH_NAME"
    # Check if branch has commits beyond the base
    BRANCH_COMMITS=$(git log "origin/${STAGING_BRANCH}..origin/${BRANCH_NAME}" --oneline 2>/dev/null | wc -l | tr -d ' ')
    if [ "${BRANCH_COMMITS:-0}" -gt 0 ]; then
      DIAG_ACTION[$NUM]="create-pr"
      DIAG_REASON[$NUM]="Branch $BRANCH_NAME has $BRANCH_COMMITS commits but no PR — resume /work-on to create PR"
      echo "  Diagnosis: CREATE-PR (branch has commits, no PR)"
    else
      DIAG_ACTION[$NUM]="reset-labels"
      DIAG_REASON[$NUM]="Branch $BRANCH_NAME exists but has no commits beyond base — reset labels to unworked"
      echo "  Diagnosis: RESET-LABELS (empty branch)"
    fi
  else
    # No branch, no PR — pure label orphan
    DIAG_ACTION[$NUM]="reset-labels"
    DIAG_REASON[$NUM]="No branch or PR found — reset workflow labels so issue is unworked"
    echo "  Diagnosis: RESET-LABELS (no branch, no PR)"
  fi

done
```

---

## Phase 3: Apply Recovery

For each diagnosed issue, apply the recovery action. All mutating actions are skipped when `DRY_RUN=true`.

**Claim before re-entering the pipeline** (forge#3158): the `review-pr` first-refusal resume and `create-pr` re-enter `/work-on` inline. A repeated or concurrent sweep, or a live `/orchestrate` agent, could otherwise run the pipeline twice on one issue. Every inline `/work-on` resume MUST go through `claim_orphan` first and call `release_orphan` afterwards. A sweep is not an orchestrator, so it takes an issue-scoped `FORGE:RECOVERY_CLAIM` marker (visible to other sweeps) and defers to any live orchestrator signal (a fresh `FORGE:HEARTBEAT`, which `/work-on --under-orchestration` posts at every phase entry).

```bash
RECOVERY_CLAIM_TTL_MIN="${RECOVERY_CLAIM_TTL_MIN:-30}"   # a claim or heartbeat older than this is treated as dead
SWEEP_ID="sweep-$(date -u +%Y%m%dT%H%M%SZ)-$$"

# claim_orphan <issue> — returns 0 if this sweep now holds the claim, 1 if it must skip (reason in CLAIM_SKIP_REASON).
# Fails closed: an unreadable comment list is treated as "held by someone else".
claim_orphan() {
  local num="$1" now cutoff comments live
  [ "$DRY_RUN" = "true" ] && return 0   # dry-run: no claim comment is posted (callers already skip dry-run resumes)
  now=$(date -u +%s); cutoff=$(( now - RECOVERY_CLAIM_TTL_MIN * 60 ))
  comments=$(gh api --paginate "repos/${GH_REPO}/issues/${num}/comments" 2>/dev/null \
    | jq -s 'add // []') || { CLAIM_SKIP_REASON="could not read comments to check for a live holder"; return 1; }
  [ -n "$comments" ] || { CLAIM_SKIP_REASON="could not read comments to check for a live holder"; return 1; }

  # Live orchestrator signal: a recent heartbeat from /work-on --under-orchestration, or a recent claim of any sweep.
  # A claim is "released" only by a later RELEASED marker naming its sweep id.
  live=$(echo "$comments" | jq --argjson cutoff "$cutoff" '
    ([.[] | select(.body | contains("FORGE:RECOVERY_CLAIM_RELEASED")) | .body | capture("Sweep: (?<id>[^ \n]+)").id]) as $rel
    | [ .[] | select(
          ((.body | contains("FORGE:HEARTBEAT")) or (.body | contains("<!-- FORGE:RECOVERY_CLAIM -->")))
          and ((.body | contains("FORGE:RECOVERY_CLAIM_RELEASED")) | not)
          and ((.updated_at | fromdateiso8601) >= $cutoff)
          and ((.body | capture("Sweep: (?<id>[^ \n]+)")? // {id:""}).id as $sid | ($rel | index($sid)) == null)
        ) ] | length') || live=1
  if [ "${live:-1}" -gt 0 ]; then
    CLAIM_SKIP_REASON="live holder (heartbeat or unreleased recovery claim within ${RECOVERY_CLAIM_TTL_MIN}m)"
    return 1
  fi

  gh issue comment "$num" ${GH_FLAG} --body "<!-- FORGE:RECOVERY_CLAIM -->
**Sweep: ${SWEEP_ID}**
Holder: /recover-orphans — resuming /work-on #${num}. Other sweeps and dispatchers: do not re-enter this issue until the matching release marker is posted." >/dev/null 2>&1 \
    || { CLAIM_SKIP_REASON="could not post FORGE:RECOVERY_CLAIM"; return 1; }

  # Race check: re-read; the earliest unreleased claim wins. Losing means another sweep claimed first.
  local first
  first=$(gh api --paginate "repos/${GH_REPO}/issues/${num}/comments" 2>/dev/null | jq -rs --argjson cutoff "$cutoff" '
    add // [] | ([.[] | select(.body | contains("FORGE:RECOVERY_CLAIM_RELEASED")) | .body | capture("Sweep: (?<id>[^ \n]+)").id]) as $rel
    | [.[] | select(.body | contains("<!-- FORGE:RECOVERY_CLAIM -->"))
           | select((.updated_at | fromdateiso8601) >= $cutoff)
           | select((.body | capture("Sweep: (?<id>[^ \n]+)").id) as $sid | ($rel | index($sid)) == null)]
    | first | .body // ""' | sed -n 's/^\*\*Sweep: \(.*\)\*\*$/\1/p')
  if [ "$first" != "$SWEEP_ID" ]; then
    release_orphan "$num"
    CLAIM_SKIP_REASON="lost claim race to ${first:-unknown}"
    return 1
  fi
  return 0
}

release_orphan() {
  [ "$DRY_RUN" = "true" ] && return 0
  gh issue comment "$1" ${GH_FLAG} --body "<!-- FORGE:RECOVERY_CLAIM_RELEASED -->
**Sweep: ${SWEEP_ID}**
Released by /recover-orphans." >/dev/null 2>&1 || true
}
```

```bash
RECOVERY_RESULTS=""

for NUM in $ORPHAN_LIST; do
  ACTION="${DIAG_ACTION[$NUM]:-skip}"
  REASON="${DIAG_REASON[$NUM]:-unknown}"
  PR_NUM="${DIAG_PR_NUM[$NUM]:-}"
  BRANCH="${DIAG_BRANCH[$NUM]:-}"

  echo ""
  echo "--- Recovering #$NUM (action: $ACTION) ---"
  echo "  Reason: $REASON"

  case "$ACTION" in

    skip)
      echo "  Skipped: $REASON"
      RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | skip | ${REASON} |\n"
      ;;

    label-cleanup)
      # PR already merged — update labels and close issue
      echo "  Applying label-cleanup: marking workflow:merged and closing issue"
      if [ "$DRY_RUN" = "true" ]; then
        echo "  [DRY-RUN] Would: gh issue edit $NUM --add-label workflow:merged --remove-label intermediate"
        echo "  [DRY-RUN] Would: gh issue close $NUM with merged comment"
      else
        gh issue edit "$NUM" ${GH_FLAG} \
          --add-label "workflow:merged" \
          --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:awaiting-merge,workflow:invalid,workflow:decomposed" \
          2>/dev/null || true
        gh issue close "$NUM" ${GH_FLAG} \
          --comment "Closed by /recover-orphans: PR #${PR_NUM} was already merged. Labels corrected." \
          2>/dev/null || true
        echo "  Done: #$NUM closed with workflow:merged"
      fi
      RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | label-cleanup | PR #${PR_NUM} merged — closed issue |\n"
      ;;

    merge-pr)
      # Open PR is approved + CI green — merge it
      echo "  Applying merge-pr: merging PR #$PR_NUM"
      if [ "$DRY_RUN" = "true" ]; then
        echo "  [DRY-RUN] Would: gh pr merge $PR_NUM --merge --auto"
      else
        MERGE_RESULT=$(gh pr merge "$PR_NUM" ${GH_FLAG} --merge --auto 2>&1)
        MERGE_EXIT=$?
        echo "  Merge result (exit $MERGE_EXIT): $MERGE_RESULT"
        if [ $MERGE_EXIT -eq 0 ]; then
          # Close the issue explicitly (Closes # only auto-closes on default branch)
          gh issue close "$NUM" ${GH_FLAG} \
            --comment "Closed by /recover-orphans: PR #${PR_NUM} merged." \
            2>/dev/null || true
          gh issue edit "$NUM" ${GH_FLAG} \
            --add-label "workflow:merged" \
            --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:awaiting-merge,workflow:invalid,workflow:decomposed" \
            2>/dev/null || true
        fi
      fi
      RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | merge-pr | PR #${PR_NUM} merged |\n"
      ;;

    review-pr)
      # Open PR awaiting review — invoke /review-pr
      echo "  Applying review-pr: invoking /review-pr on PR #$PR_NUM"
      if [ "$DRY_RUN" = "true" ]; then
        echo "  [DRY-RUN] Would: Skill(skill='{FORGE_SKILL_PREFIX}review-pr', args='$PR_NUM --auto-merge --issue $NUM --gh-flag $GH_FLAG')"
      else
        # forge#3148: count trail refusals that predate this sweep, so a refusal from an earlier sweep escalates
        # instead of re-reviewing the same unrepaired trail every run.
        # forge#3159: count only TRUSTED comments (pipeline bot, or OWNER/MEMBER/COLLABORATOR) newer than the latest
        # repair (the most recent needs-human unlabel event), so a stranger's comment or a refusal a human already
        # repaired never forces an escalation. Epoch fallback on a failed lookup counts more, i.e. fails toward escalation.
        # --paginate: the comments endpoint returns 30 per page, oldest first. An unreadable count fails toward escalation.
        PRIOR_TRAIL_CUTOFF=$(gh api --paginate "repos/${GH_REPO}/issues/${NUM}/events" \
            --jq '.[] | select(.event == "unlabeled" and .label.name == "needs-human") | .created_at' 2>/dev/null \
            | sort | tail -1)
        PRIOR_TRAIL_CUTOFF="${PRIOR_TRAIL_CUTOFF:-1970-01-01T00:00:00Z}"
        if PRIOR_TRAIL_IDS=$(gh api --paginate "repos/${GH_REPO}/issues/${NUM}/comments" \
            --jq --arg cutoff "$PRIOR_TRAIL_CUTOFF" '.[] | select(.body | contains("FORGE:PHASE_TRAIL_FAILED"))
              | select(.created_at > $cutoff)
              | select(.user.type == "Bot" or (.author_association | IN("OWNER","MEMBER","COLLABORATOR"))) | .id' 2>/dev/null); then
          PRIOR_TRAIL_FAILS=$(printf '%s\n' "$PRIOR_TRAIL_IDS" | grep -c '[0-9]')
        else
          PRIOR_TRAIL_FAILS=1
        fi
        REVIEW_STATUS=""; REVIEW_BLOCKER=""   # reset per orphan so a previous orphan's result never leaks into this one
        Skill(skill="{FORGE_SKILL_PREFIX}review-pr", args="${PR_NUM} --auto-merge --issue ${NUM} --gh-flag ${GH_FLAG}")
        # REVIEW_STATUS = the `status:` field of the REVIEW_RESULT block the Skill call returned.
        if [ "$REVIEW_STATUS" = "PHASE_TRAIL_FAILED" ]; then
          # Phase 8 refused the merge: the issue's phase trail is incomplete (review-pr posted the
          # MISSING lines as FORGE:PHASE_TRAIL_FAILED). Do NOT set workflow:in-review — that only re-queues
          # the same refusal for the next sweep. Never hand-post the missing markers.
          if [ "${PRIOR_TRAIL_FAILS:-0}" -gt 0 ]; then
            gh issue edit "$NUM" ${GH_FLAG} --add-label "needs-human" 2>/dev/null || true
            gh issue comment "$NUM" ${GH_FLAG} --body "<!-- FORGE:ORPHAN_RECOVERED -->
## Orphan Recovery — Escalated

**Action**: \`/review-pr\` refused to merge PR #${PR_NUM} again because the phase trail is incomplete, and an earlier refusal was not repaired.
**Recovered by**: /recover-orphans

See the latest FORGE:PHASE_TRAIL_FAILED comment for the missing phases. Re-run each one via its Skill (or \`/work-on ${NUM}\`), then remove \`needs-human\`." 2>/dev/null || true
            RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} refused (phase trail) again — needs-human added |\n"
          else
            # First refusal: resume /work-on, whose resume preflight re-runs each missing phase via Skill(...)
            # and then re-enters review (work-on.md Phase 0B, Phase 5D).
            if claim_orphan "$NUM"; then
              Skill(skill="{FORGE_SKILL_PREFIX}work-on", args="${NUM}")
              release_orphan "$NUM"
              RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} refused (phase trail) — resumed /work-on to re-run missing phases |\n"
            else
              RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} refused (phase trail) — /work-on resume skipped: ${CLAIM_SKIP_REASON} |\n"
            fi
          fi
        elif [ "$REVIEW_STATUS" = "BLOCKED" ] && echo "$REVIEW_BLOCKER" | grep -qE 'phase trail|auto-merge requires --issue'; then
          # REVIEW_BLOCKER = the `blocker:` field of the same REVIEW_RESULT block. The gate could not run (verifier
          # rc>=2 / unresolvable) or had no issue to verify (forge#3147). review-pr already added needs-human for the
          # rc>=2 case; add it here too so the diagnosis skip above stops re-sweeping this orphan.
          gh issue edit "$NUM" ${GH_FLAG} --add-label "needs-human" 2>/dev/null || true
          RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} blocked by the merge gate — needs-human added |\n"
        elif [ -z "$REVIEW_STATUS" ] || ! echo "$REVIEW_STATUS" | grep -qE '^(COMPLETE|ALREADY_MERGED|BLOCKED)$'; then
          # forge#3159: an empty or unrecognized status means the review result could not be read. Do not report
          # "submitted for review" or re-queue it; escalate to a human.
          gh issue edit "$NUM" ${GH_FLAG} --add-label "needs-human" 2>/dev/null || true
          RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} unrecognized review status '${REVIEW_STATUS}' — needs-human added |\n"
        else
          # After review: update label
          gh issue edit "$NUM" ${GH_FLAG} --add-label "workflow:in-review" \
            --remove-label "workflow:building,workflow:awaiting-merge" 2>/dev/null || true
          RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} submitted for review |\n"
        fi
      fi
      [ "$DRY_RUN" = "true" ] && RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} would be submitted for review |\n"
      ;;

    create-pr)
      # Branch has commits but no PR — resume /work-on to create PR
      echo "  Applying create-pr: resuming /work-on to advance from build to PR creation"
      if [ "$DRY_RUN" = "true" ]; then
        echo "  [DRY-RUN] Would: Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='$NUM')"
        RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | create-pr | Would resume /work-on — branch $BRANCH has commits, no PR |\n"
      elif claim_orphan "$NUM"; then
        Skill(skill="{FORGE_SKILL_PREFIX}work-on", args="${NUM}")
        release_orphan "$NUM"
        RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | create-pr | Resumed /work-on — branch $BRANCH has commits, no PR |\n"
      else
        RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | create-pr | /work-on resume skipped: ${CLAIM_SKIP_REASON} |\n"
      fi
      ;;

    reset-labels)
      # No branch, no PR, or empty branch — reset to unworked state
      echo "  Applying reset-labels: removing intermediate workflow labels"
      if [ "$DRY_RUN" = "true" ]; then
        echo "  [DRY-RUN] Would: remove workflow:investigating, workflow:ready-to-build, workflow:building, workflow:in-review"
      else
        gh issue edit "$NUM" ${GH_FLAG} \
          --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:awaiting-merge" \
          2>/dev/null || true
        gh issue comment "$NUM" ${GH_FLAG} \
          --body "<!-- FORGE:ORPHAN_RECOVERED -->
## Orphan Recovery Applied

**Action**: Label reset — no branch or PR found (or branch had no commits).
**Recovered at**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Recovered by**: /recover-orphans

Issue returned to unworked state. Run \`/work-on ${NUM}\` to restart the pipeline." \
          2>/dev/null || true
        echo "  Done: #$NUM labels reset to unworked"
      fi
      RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | reset-labels | No progress found — labels cleared |\n"
      ;;

    escalate-ci)
      # CI failed on open PR — add needs-human
      echo "  Escalating: PR #$PR_NUM has CI failures — adding needs-human label"
      if [ "$DRY_RUN" = "true" ]; then
        echo "  [DRY-RUN] Would: gh issue edit $NUM --add-label needs-human; gh issue comment with CI failure info"
      else
        gh issue edit "$NUM" ${GH_FLAG} --add-label "needs-human" 2>/dev/null || true
        gh issue comment "$NUM" ${GH_FLAG} \
          --body "<!-- FORGE:ORPHAN_ESCALATED -->
## Orphan Recovery: Escalated (CI Failure)

**PR**: #${PR_NUM}
**Reason**: CI checks failed on the open PR. Automated recovery cannot proceed past a CI failure.
**Escalated at**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

**Next steps**:
1. Review CI failures: \`gh pr view ${PR_NUM} --web\`
2. Fix failing checks, then run \`/work-on ${NUM}\` to resume
3. Or run \`/fix-ci ${NUM}\` if that command is available" \
          2>/dev/null || true
      fi
      RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | escalate-ci | PR #${PR_NUM} CI failed — needs-human added |\n"
      ;;

    escalate-changes)
      # Reviewer requested changes — add needs-human
      echo "  Escalating: PR #$PR_NUM has requested changes — needs human review"
      if [ "$DRY_RUN" = "true" ]; then
        echo "  [DRY-RUN] Would: gh issue edit $NUM --add-label needs-human"
      else
        gh issue edit "$NUM" ${GH_FLAG} --add-label "needs-human" 2>/dev/null || true
        gh issue comment "$NUM" ${GH_FLAG} \
          --body "<!-- FORGE:ORPHAN_ESCALATED -->
## Orphan Recovery: Escalated (Changes Requested)

**PR**: #${PR_NUM}
**Reason**: A reviewer has requested changes on PR #${PR_NUM}. Human review of the requested changes is required.
**Escalated at**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

**Next steps**:
1. Review requested changes: \`gh pr view ${PR_NUM} --web\`
2. Address the feedback, then remove \`needs-human\` label to allow pipeline to continue" \
          2>/dev/null || true
      fi
      RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | escalate-changes | PR #${PR_NUM} reviewer requested changes |\n"
      ;;

  esac
done
```

---

## Phase 4: Worktree Cleanup

Prune orphaned worktrees — those with no corresponding open PR. Follows the same safe pattern as `/cleanup branches`.

```bash
echo ""
echo "=== Phase 4: Worktree Cleanup ==="

if [ -z "$WORKTREE_BASE" ] || [ ! -d "$WORKTREE_BASE" ]; then
  echo "WORKTREE_BASE not configured or directory not found — skipping worktree cleanup"
else
  cd "$REPO_PATH" 2>/dev/null || true

  WORKTREE_REMOVED=0
  WORKTREE_KEPT=0

  while IFS= read -r WT_PATH; do
    # Skip the main worktree (repo root)
    [ "$WT_PATH" = "$REPO_PATH" ] && continue
    # Only manage worktrees under WORKTREE_BASE
    case "$WT_PATH" in
      "$WORKTREE_BASE"*) : ;;
      *) continue ;;
    esac

    BRANCH=$(git -C "$WT_PATH" branch --show-current 2>/dev/null || echo "")
    if [ -z "$BRANCH" ]; then
      echo "  SKIP: $WT_PATH — detached HEAD, leaving as-is"
      WORKTREE_KEPT=$((WORKTREE_KEPT + 1))
      continue
    fi

    # Check if branch has an open PR
    OPEN_PR_COUNT=$(gh pr list ${GH_FLAG} --head "$BRANCH" --state open --json number --jq 'length' 2>/dev/null || echo "0")

    # Check if branch has a merged PR
    MERGED_PR=$(gh pr list ${GH_FLAG} --head "$BRANCH" --state merged --json number --jq '.[0].number' 2>/dev/null || echo "")

    if [ "${OPEN_PR_COUNT:-0}" -gt 0 ]; then
      echo "  KEEP: $WT_PATH (branch: $BRANCH) — has open PR"
      WORKTREE_KEPT=$((WORKTREE_KEPT + 1))
    elif [ -n "$MERGED_PR" ]; then
      echo "  STALE: $WT_PATH (branch: $BRANCH) — PR #$MERGED_PR merged"
      if [ "$DRY_RUN" = "true" ]; then
        echo "  [DRY-RUN] Would: git worktree remove $WT_PATH --force"
        echo "  [DRY-RUN] Would: git branch -D $BRANCH"
      else
        git worktree remove "$WT_PATH" --force 2>/dev/null || true
        git branch -D "$BRANCH" 2>/dev/null || true
        echo "  Removed worktree: $WT_PATH (PR #$MERGED_PR was merged)"
        WORKTREE_REMOVED=$((WORKTREE_REMOVED + 1))
      fi
    else
      echo "  UNKNOWN: $WT_PATH (branch: $BRANCH) — no PR found, leaving as-is"
      WORKTREE_KEPT=$((WORKTREE_KEPT + 1))
    fi
  done < <(git worktree list --porcelain 2>/dev/null | grep "^worktree " | sed 's/^worktree //')

  echo "Worktree cleanup: removed=$WORKTREE_REMOVED kept=$WORKTREE_KEPT"
fi
```

---

## Phase 5: Report

Print a structured recovery report.

```bash
echo ""
echo "========================================"
echo "  /recover-orphans — Recovery Report"
echo "========================================"
echo ""
echo "Scan timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Dry-run: $DRY_RUN"
echo "Orphans scanned: $ORPHAN_COUNT"
echo ""
echo "## Recovery Actions"
echo ""
echo "| Issue | Action | Outcome |"
echo "|-------|--------|---------|"
printf '%b' "$RECOVERY_RESULTS"
echo ""
echo "## Worktrees"
echo "See Phase 4 output above for worktree-specific actions."
echo ""
echo "## Next Steps"
echo ""
echo "For issues with action 'reset-labels':"
echo "  Run /work-on <issue-number> to restart the pipeline from the beginning."
echo ""
echo "For issues with action 'escalate-ci' or 'escalate-changes':"
echo "  Address the manual intervention required, then remove the needs-human label."
echo ""
echo "For issues with action 'create-pr':"
echo "  /work-on has been re-invoked — monitor the issue for workflow:in-review label."
echo ""

if [ "$DRY_RUN" = "true" ]; then
  echo "DRY-RUN MODE: No changes were made. Remove --dry-run to apply recovery actions."
fi
```
