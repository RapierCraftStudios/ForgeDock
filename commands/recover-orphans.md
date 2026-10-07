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

**Claim before re-entering the pipeline** (forge#3158): the `review-pr` first-refusal resume and `create-pr` re-enter `/work-on` inline. A repeated or concurrent sweep, or a live `/orchestrate` agent, could otherwise run the pipeline twice on one issue. Every inline `/work-on` resume MUST go through `claim_orphan` first, then `claim_keepalive_begin`, then the `Skill(...)` tool call, then `claim_keepalive_end` (see the sequence below). A sweep is not an orchestrator, so it takes an issue-scoped `FORGE:RECOVERY_CLAIM` marker (visible to other sweeps) and defers to any live orchestrator signal (a fresh `FORGE:HEARTBEAT`, which `/work-on --under-orchestration` posts at every phase entry). The claim is honored in the other direction too (forge#3172): `/work-on` Phase 0A.4 and `/orchestrate` Phase 4 dispatch consult the shared `scripts/recovery-claim-live.sh` and defer to a live claim, so the inline resume passes `--recovery-sweep ${SWEEP_ID}` to exempt its own claim.

**Claim refresh and explicit release** (forge#3171, forge#3212): liveness is judged from the claim comment's `updated_at`, and an inline resume posts no `FORGE:HEARTBEAT` (that is gated on `--under-orchestration`, which sweeps do not pass). So the claim is kept alive by editing it: `refresh_orphan` PATCHes the claim body, keeping the `**Sweep: id**` line and appending a changing `Refreshed: <UTC>` line, so `updated_at` always advances. `Skill(...)` is an agent tool call, not a bash command, and shell state does not persist across Bash tool calls, so the lifecycle is an explicit agent sequence, never a bash subshell: (1) `claim_orphan "$NUM"` (Bash call); (2) `claim_keepalive_begin "$NUM"` (Bash call: starts a best-effort background refresh every `RECOVERY_CLAIM_TTL_MIN / 3` minutes and refreshes once immediately); (3) the `Skill(skill="{FORGE_SKILL_PREFIX}work-on", args="${NUM} --recovery-sweep ${SWEEP_ID}")` tool call; (4) `claim_keepalive_end "$NUM"` (Bash call) ALWAYS, including when the Skill call fails or returns BLOCKED. Each Bash call must start with the literal `SWEEP_ID='<value>'` (the id the first call echoed; never let it be re-minted) and then re-define the helpers; the helpers re-derive the claim comment id from the comment list by `Sweep: ${SWEEP_ID}` (`claim_rehydrate`) rather than trusting shell variables, and the keepalive is stopped through a pidfile. `claim_keepalive_end` stops the keepalive first and is idempotent (it never posts the release marker twice). Refresh is best-effort and release is an explicit agent step: if either is lost the claim degrades to the plain `RECOVERY_CLAIM_TTL_MIN` expiry. The background keepalive is best-effort: this spec relies on it surviving the Bash call that started it (a `( ... ) & disown` loop does in the Claude Code harness); on a runtime that reaps it, a work-on run longer than the TTL can lose its claim. The loop is bounded (`RECOVERY_KEEPALIVE_MAX_MIN` deadline, and it exits as soon as the claim is released or no longer found), so an aborted agent cannot keep a claim alive forever. One claim per issue per sweep is assumed. DRY_RUN makes every one of these helpers a no-op.

```bash
RECOVERY_CLAIM_TTL_MIN="${RECOVERY_CLAIM_TTL_MIN:-30}"   # a claim or heartbeat older than this is treated as dead
# SWEEP_ID is minted ONCE per sweep. The first Bash call that defines it echoes the value; the agent then starts every
# later Bash call with the literal `SWEEP_ID='<value>'` BEFORE re-defining the helpers, so this default never re-mints.
SWEEP_ID="${SWEEP_ID:-sweep-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
RECOVERY_KEEPALIVE_MAX_MIN="${RECOVERY_KEEPALIVE_MAX_MIN:-240}"   # hard lifetime bound for the background keepalive

# claim_orphan <issue> — returns 0 if this sweep now holds the claim, 1 if it must skip (reason in CLAIM_SKIP_REASON).
# Fails closed: an unreadable comment list (initial read or race-check re-read) is treated as "held by someone else".
# Both reads run under pipefail in a subshell: the pipeline status would otherwise be jq's, and a gh failure
# (rate limit, 403) would yield "[]" with exit 0, indistinguishable from "no live holder".
claim_orphan() {
  local num="$1" now cutoff comments live resp
  [ "$DRY_RUN" = "true" ] && return 0   # dry-run: no claim comment is posted (callers already skip dry-run resumes)
  unset CLAIM_HELD_NUM CLAIM_COMMENT_ID CLAIM_BODY   # never carry a previous issue's claim state into this one
  now=$(date -u +%s); cutoff=$(( now - RECOVERY_CLAIM_TTL_MIN * 60 ))
  comments=$(set -o pipefail; gh api --paginate "repos/${GH_REPO}/issues/${num}/comments" 2>/dev/null \
    | jq -s 'add // []') || { CLAIM_SKIP_REASON="could not read comments to check for a live holder"; return 1; }

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

  # Post via the API so the comment id is known: refresh_orphan needs it. The Sweep line must stay line 2.
  CLAIM_BODY="<!-- FORGE:RECOVERY_CLAIM -->
**Sweep: ${SWEEP_ID}**
Holder: /recover-orphans — resuming /work-on #${num}. Other sweeps and dispatchers: do not re-enter this issue until the matching release marker is posted."
  resp=$(gh api -X POST "repos/${GH_REPO}/issues/${num}/comments" -f body="$CLAIM_BODY" --jq '.id' 2>/dev/null) \
    && [ -n "$resp" ] || { CLAIM_SKIP_REASON="could not post FORGE:RECOVERY_CLAIM"; return 1; }
  CLAIM_COMMENT_ID="$resp"; CLAIM_HELD_NUM="$num"   # set before the race check so release_orphan covers the race-lost paths

  # Race check: re-read; the earliest unreleased claim wins. Losing means another sweep claimed first.
  local first
  first=$(set -o pipefail; gh api --paginate "repos/${GH_REPO}/issues/${num}/comments" 2>/dev/null | jq -rs --argjson cutoff "$cutoff" '
    add // [] | ([.[] | select(.body | contains("FORGE:RECOVERY_CLAIM_RELEASED")) | .body | capture("Sweep: (?<id>[^ \n]+)").id]) as $rel
    | [.[] | select(.body | contains("<!-- FORGE:RECOVERY_CLAIM -->"))
           | select((.updated_at | fromdateiso8601) >= $cutoff)
           | select((.body | capture("Sweep: (?<id>[^ \n]+)").id) as $sid | ($rel | index($sid)) == null)]
    | first | .body // ""' | sed -n 's/^\*\*Sweep: \(.*\)\*\*$/\1/p') \
    || { release_orphan "$num"; CLAIM_SKIP_REASON="could not re-read comments to confirm the claim race"; return 1; }
  if [ "$first" != "$SWEEP_ID" ]; then
    release_orphan "$num"
    CLAIM_SKIP_REASON="lost claim race to ${first:-unknown}"
    return 1
  fi
  return 0
}

# claim_rehydrate <issue> — shell variables do not survive across Bash tool calls, so re-derive the held claim from the
# comment list: the latest FORGE:RECOVERY_CLAIM comment naming this SWEEP_ID with no matching RELEASED marker.
# Returns 0 with CLAIM_HELD_NUM / CLAIM_COMMENT_ID / CLAIM_BODY set, 1 if this sweep holds no unreleased claim.
claim_rehydrate() {
  local num="$1" found me
  if [ "${CLAIM_HELD_NUM:-}" = "$num" ] && [ -n "${CLAIM_COMMENT_ID:-}" ] && [ -n "${CLAIM_BODY:-}" ]; then return 0; fi
  # Only comments authored by the authenticated login count (any commenter can post a fake claim or RELEASED marker;
  # same class as #3168). A read error returns 2 (distinct from "not held" = 1) so release can retry instead of skipping.
  me=$(gh api user --jq '.login' 2>/dev/null) && [ -n "$me" ] || return 2
  found=$(set -o pipefail; gh api --paginate "repos/${GH_REPO}/issues/${num}/comments" 2>/dev/null \
    | jq -s --arg sid "$SWEEP_ID" --arg me "$me" '
        add // [] | map(select(.user.login == $me)) | . as $mine
        | ([$mine[] | select(.body | contains("FORGE:RECOVERY_CLAIM_RELEASED"))
                         | select(.body | contains("Sweep: " + $sid))] | length) as $rel
        | if $rel > 0 then empty else
            [$mine[] | select(.body | contains("<!-- FORGE:RECOVERY_CLAIM -->"))
                 | select(.body | contains("**Sweep: " + $sid + "**"))] | first // empty
            | {id: .id, body: (.body | split("\n") | map(select(startswith("Refreshed: ") | not)) | join("\n"))}
          end') || return 2
  [ -n "$found" ] || return 1
  CLAIM_COMMENT_ID=$(echo "$found" | jq -r '.id'); CLAIM_BODY=$(echo "$found" | jq -r '.body'); CLAIM_HELD_NUM="$num"
  [ -n "$CLAIM_COMMENT_ID" ] && [ "$CLAIM_COMMENT_ID" != "null" ] || { unset CLAIM_HELD_NUM CLAIM_COMMENT_ID CLAIM_BODY; return 1; }
}

# refresh_orphan <issue> — best-effort: edit the claim comment so its updated_at advances. The body must change
# every time (an identical-body edit may not bump updated_at). Never carries FORGE:HEARTBEAT or the RELEASED marker.
refresh_orphan() {
  [ "$DRY_RUN" = "true" ] && return 0
  claim_rehydrate "$1"; local rc=$?
  [ "$rc" -eq 1 ] && return 1   # claim released or gone: callers (the keepalive loop) stop. A read error (rc 2) is retried next tick.
  [ "$rc" -eq 0 ] || return 0
  gh api -X PATCH "repos/${GH_REPO}/issues/comments/${CLAIM_COMMENT_ID}" \
    -f body="${CLAIM_BODY}
Refreshed: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null 2>&1 || true
}

# Keepalive pidfile: the background loop and stop run in different Bash tool calls, so the pid lives on disk.
# The directory is private (0700, owned by us, never a symlink) so a pidfile cannot be pre-planted on a shared /tmp.
claim_keepalive_pidfile() {
  local d="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/forge-claim-keepalive-$(id -u)"
  mkdir -p -m 700 "$d" 2>/dev/null
  if [ -L "$d" ] || [ ! -d "$d" ] || [ ! -O "$d" ]; then return 1; fi
  echo "${d}/${SWEEP_ID}-$1.pid"
}

# start_claim_keepalive <issue> — non-blocking background refresh every TTL/3 (strictly under the TTL). Best-effort:
# the process may not outlive the Bash call that started it, so the agent also refreshes at phase boundaries.
start_claim_keepalive() {
  [ "$DRY_RUN" = "true" ] && return 0
  stop_claim_keepalive "$1"
  local num="$1" interval=$(( RECOVERY_CLAIM_TTL_MIN * 60 / 3 )) pidfile deadline
  [ "$interval" -ge 1 ] || interval=1
  pidfile=$(claim_keepalive_pidfile "$num") || return 1
  [ -L "$pidfile" ] && return 1
  deadline=$(( $(date -u +%s) + RECOVERY_KEEPALIVE_MAX_MIN * 60 ))
  # Bounded loop: stops at the deadline, or as soon as the claim is released/gone. The cached claim state is dropped on
  # every tick so a RELEASED marker is actually seen (otherwise the cache would keep refreshing a released claim).
  ( while sleep "$interval" && [ "$(date -u +%s)" -lt "$deadline" ]; do
      unset CLAIM_HELD_NUM CLAIM_COMMENT_ID CLAIM_BODY
      refresh_orphan "$num" || break
    done ) >/dev/null 2>&1 &
  echo $! > "$pidfile"
  disown 2>/dev/null || true
}

# stop_claim_keepalive <issue> — safe from a different Bash call than the one that started the loop; idempotent.
stop_claim_keepalive() {
  local pidfile pid; pidfile=$(claim_keepalive_pidfile "$1") || return 0
  [ -f "$pidfile" ] && [ ! -L "$pidfile" ] || return 0
  pid=$(cat "$pidfile" 2>/dev/null)
  # Only a plain integer > 1 is ever signalled (0 / 1 / negatives would hit the whole process group or init).
  if printf '%s' "$pid" | grep -qE '^[0-9]+$' && [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null; then
    pkill -P "$pid" 2>/dev/null || true   # the pending sleep
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

# release_orphan <issue> — stops the keepalive first; idempotent (the release marker is posted at most once per claim).
release_orphan() {
  [ "$DRY_RUN" = "true" ] && return 0
  stop_claim_keepalive "$1"
  local rc=2 try
  for try in 1 2 3; do
    unset CLAIM_HELD_NUM CLAIM_COMMENT_ID CLAIM_BODY
    claim_rehydrate "$1"; rc=$?
    [ "$rc" -ne 2 ] && break
    sleep $(( try * 2 ))
  done
  if [ "$rc" -eq 0 ]; then
    gh issue comment "$1" ${GH_FLAG} --body "<!-- FORGE:RECOVERY_CLAIM_RELEASED -->
**Sweep: ${SWEEP_ID}**
Released by /recover-orphans." >/dev/null 2>&1 || true
  fi
  unset CLAIM_HELD_NUM CLAIM_COMMENT_ID CLAIM_BODY
}

# claim_keepalive_begin <issue> — Bash step run AFTER claim_orphan succeeded and BEFORE the agent's Skill(...) tool call.
# Starts the keepalive and refreshes once immediately. Skill(...) is an agent tool call and must never be placed
# inside a bash function or subshell.
claim_keepalive_begin() {
  [ "$DRY_RUN" = "true" ] && return 0
  claim_rehydrate "$1" || { CLAIM_SKIP_REASON="could not re-derive the claim to start its keepalive"; return 1; }
  start_claim_keepalive "$1" || { CLAIM_SKIP_REASON="could not start the claim keepalive"; return 1; }
  refresh_orphan "$1"
  return 0
}

# claim_keepalive_end <issue> — Bash step the agent runs AFTER the Skill(...) tool call, ALWAYS, also when the Skill call
# failed or returned BLOCKED. Stops the keepalive and releases the claim; idempotent, so a repeat call is harmless.
claim_keepalive_end() {
  release_orphan "$1"
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
        # CI gate (MANDATORY before any autonomous merge): merge only when every check on the PR is
        # green. Field test: PRs merged to staging with checks pending or red (#3165), because branch
        # protection required none and an auto-merge waits only for *required* checks.
        CI_GATE_SCRIPT=""
        _l="$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null || true)"; _l="${_l%/commands/work-on.md}"
        for _c in '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGEDOCK_HOME:-}" "${FORGE_HOME:-}" "$_l"; do
          case "$_c" in /*) [ -z "$CI_GATE_SCRIPT" ] && [ -f "$_c/scripts/wait-ci-green.sh" ] && CI_GATE_SCRIPT="$_c/scripts/wait-ci-green.sh" ;; esac
        done
        if [ -n "$CI_GATE_SCRIPT" ]; then CI_GATE_OUT=$(bash "$CI_GATE_SCRIPT" "$PR_NUM" ${GH_FLAG}); CI_GATE_RC=$?
        else CI_GATE_OUT="CI_GATE: ERROR — scripts/wait-ci-green.sh not resolvable (fail closed)"; CI_GATE_RC=2; fi
        echo "$CI_GATE_OUT"
        GATED_HEAD=$(printf '%s\n' "$CI_GATE_OUT" | sed -n 's/^CI_GATE_HEAD: //p' | head -1)
        # rc 3 = CI still running: re-run this block (up to 3 more times) before treating it as a failure.
        if [ "$CI_GATE_RC" -eq 0 ]; then
          MERGE_RESULT=$(gh pr merge "$PR_NUM" ${GH_FLAG} --merge --auto --match-head-commit "$GATED_HEAD" 2>&1)
          MERGE_EXIT=$?
        else
          MERGE_RESULT="not merged: CI gate rc=${CI_GATE_RC}"; MERGE_EXIT=1
          CI_MSG="⛔ /recover-orphans did not merge PR #${PR_NUM}: CI is not green.
\`\`\`
${CI_GATE_OUT}
\`\`\`"
          gh issue comment "$NUM" ${GH_FLAG} --body "$CI_MSG" 2>/dev/null || true # allowlist:check-command-side-effects
          gh issue edit "$NUM" ${GH_FLAG} --add-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
        fi
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
        # gh api --jq takes one expression and no --arg, so the cutoff goes through a real jq pipe.
        if PRIOR_TRAIL_IDS=$(set -o pipefail; gh api --paginate "repos/${GH_REPO}/issues/${NUM}/comments" 2>/dev/null \
            | jq -r --arg cutoff "$PRIOR_TRAIL_CUTOFF" '.[] | select(.body | contains("FORGE:PHASE_TRAIL_FAILED"))
              | select(.created_at > $cutoff)
              | select(.user.type == "Bot" or (.author_association | IN("OWNER","MEMBER","COLLABORATOR"))) | .id'); then
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
            # and then re-enters review (work-on.md Phase 0B resume → work-on/review.md).
            # THREE SEPARATE AGENT STEPS, never one Bash call: (1) Bash: claim + keepalive begin; (2) the Skill tool
            # call; (3) Bash: keepalive end. Executing steps 1-3 inside a single Bash call releases the claim before
            # the Skill starts (the #3212 bug). Each Bash call starts with the literal SWEEP_ID='<value>' + helpers.
            if claim_orphan "$NUM" && claim_keepalive_begin "$NUM"; then      # STEP 1 (Bash call) — ends here
              Skill(skill="{FORGE_SKILL_PREFIX}work-on", args="${NUM} --recovery-sweep ${SWEEP_ID}")   # STEP 2 (agent tool call)
              claim_keepalive_end "$NUM"    # STEP 3 (Bash call) — ALWAYS, even if the Skill call failed or returned BLOCKED
              RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} refused (phase trail) — resumed /work-on to re-run missing phases |\n"
            else
              release_orphan "$NUM"   # idempotent: frees a claim posted before keepalive begin failed; no-op if never claimed
              RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} refused (phase trail) — /work-on resume skipped: ${CLAIM_SKIP_REASON} |\n"
            fi
          fi
        elif [ "$REVIEW_STATUS" = "BLOCKED" ] && echo "$REVIEW_BLOCKER" | grep -qE 'phase trail|auto-merge requires --issue'; then
          # REVIEW_BLOCKER = the `blocker:` field of the same REVIEW_RESULT block. The gate could not run (verifier
          # rc>=2 / unresolvable) or had no issue to verify (forge#3147). review-pr already added needs-human for the
          # rc>=2 case; add it here too so the diagnosis skip above stops re-sweeping this orphan.
          gh issue edit "$NUM" ${GH_FLAG} --add-label "needs-human" 2>/dev/null || true
          RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | review-pr | PR #${PR_NUM} blocked by the merge gate — needs-human added |\n"
        elif case "$REVIEW_STATUS" in COMPLETE|ALREADY_MERGED|BLOCKED) false ;; *) true ;; esac; then
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
        echo "  [DRY-RUN] Would: Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='$NUM --recovery-sweep $SWEEP_ID')"
        RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | create-pr | Would resume /work-on — branch $BRANCH has commits, no PR |\n"
      elif claim_orphan "$NUM" && claim_keepalive_begin "$NUM"; then      # STEP 1 (Bash call) — ends here
        # Same three separate agent steps as the review-pr site above: Bash begin, Skill tool call, Bash end.
        Skill(skill="{FORGE_SKILL_PREFIX}work-on", args="${NUM} --recovery-sweep ${SWEEP_ID}")   # STEP 2 (agent tool call)
        claim_keepalive_end "$NUM"    # STEP 3 (Bash call) — ALWAYS, even if the Skill call failed or returned BLOCKED
        RECOVERY_RESULTS="${RECOVERY_RESULTS}| #${NUM} | create-pr | Resumed /work-on — branch $BRANCH has commits, no PR |\n"
      else
        release_orphan "$NUM"   # idempotent: frees a claim posted before keepalive begin failed; no-op if never claimed
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
