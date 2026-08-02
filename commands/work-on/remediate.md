---
description: Remediate subcommand — checkout a needs-human PR, fix review findings, re-review, and re-gate with a FORGE:REMEDIATION paper trail
argument-hint: "[PR number] [--issue N] [--repo GH_REPO] [--gh-flag GH_FLAG] [--base PR_BASE]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/remediate — Remediation Subcommand

**Input**: $ARGUMENTS

**Invoked by**:
- `work-on.md` Phase 0A, standalone: `/work-on <pr> --remediate` (see forge#1813).
- `commands/orchestrate/phase-4-execution.md` item 6.4, auto-dispatched against a `needs-human`-gated predecessor's own open PR.

**Output**: Checkout the PR's existing branch → classify the block reason (fixable vs. policy escalation) → apply fixes → quality-gate → commit/push → re-invoke `/review-pr --auto-merge` → compute the #1809 Q1 auto-land bar → merge-if-verified or hold at `workflow:awaiting-merge` → emit a `FORGE:REMEDIATION` paper trail. Return result to caller.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

**Scope note**: This mode owns exactly one gap — re-driving a `needs-human` PR's own remediation. It does NOT implement the `needs-human` sub-label taxonomy (#1815's scope) and it does NOT edit `review-pr.md`'s Phase 8 guard (forge#1810) — that guard's existing safe-default (`workflow:awaiting-merge` on any clean re-review of a previously-escalated PR) is reused as-is; this file only adds a bar-check *after* that guard has already fired.

**Engine coverage** (forge#2379, #2889): this subcommand's `command` name (`work-on/remediate`) and completion marker (`FORGE:REMEDIATION:COMPLETE`, including the `**Re-gate outcome**` field Phase M8 posts below) are registered in the headless engine's phase table — `RESERVED_TYPES.REMEDIATION` in `packages/protocol/src/types.js`, `remediate` in `packages/protocol/src/phases.js`'s `PHASE_IDS`/`PHASE_MARKERS`, and a matching `remediate` entry in `bin/engine/phases.mjs`'s `PHASES` array. A blocked review is committed with `terminalReason: "needs-human"`, then the engine continues directly into remediation; the divergence guard permits this specific handoff while keeping all other `needs-human` states paused.

---

## Inputs

Parse from $ARGUMENTS:
- `{PR_NUMBER}` — PR number to remediate (required, first positional arg). This is the `needs-human`-gated PR itself, NOT the linked issue number.
- `--issue {ISSUE_NUMBER}` — linked issue number (optional). If absent, resolved in Phase M0 from the PR body's `Closes #N` reference.
- `--repo {GH_REPO}` — GitHub repo (resolved from `forge.yaml → project` if omitted)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag
- `--base {PR_BASE}` — PR target branch (optional; resolved from the PR's `baseRefName` if omitted)
- `DRY_RUN=true` — read-only eligibility report. It permits GitHub and Git reads only: no comments, labels, claim cleanup/creation/renewal, checkout/reset/rebase, edits, staging, commit, push, finding closure, review dispatch, merge, or close dispatch.

`DRY_RUN` is a command-wide governance boundary, not a per-snippet hint. Phase M0 performs the required reads, prints the prospective cycle, then returns `REMEDIATE_RESULT: status: BLOCKED`, `re_gate_outcome: N/A`, blocker `dry-run report only`. No later phase may execute in that invocation.

---

## Phase M0: Load State & Guard Rails (MANDATORY)

Re-read current state before doing anything:

```bash
PR_STATE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state,headRefName,headRefOid,baseRefName,body,mergeable,mergeStateStatus,url)
PR_OPEN_STATE=$(echo "$PR_STATE" | jq -r '.state')
HEAD_BRANCH=$(echo "$PR_STATE" | jq -r '.headRefName')
REVIEWED_HEAD_SHA=$(echo "$PR_STATE" | jq -r '.headRefOid // empty' | tr '[:upper:]' '[:lower:]')
PR_BASE="${PR_BASE:-$(echo "$PR_STATE" | jq -r '.baseRefName')}"
PR_BODY=$(echo "$PR_STATE" | jq -r '.body')
```

**PR state guard**:
- `PR_OPEN_STATE = MERGED` → EXIT `REMEDIATE_RESULT: status: ALREADY_DONE` (nothing to remediate — already landed).
- `PR_OPEN_STATE = CLOSED` (not merged) → EXIT `REMEDIATE_RESULT: status: BLOCKED`, blocker: "PR #{PR_NUMBER} is closed, not merged — nothing to remediate."

**Resolve the linked issue** (`--issue` flag takes precedence; else parse from the PR body — anchored, matching the `"Closes #N" in:body` precedent from forge#1634/#1646, never a bare-number scan):

```bash
ISSUE_NUMBER="${ISSUE_NUMBER:-$(echo "$PR_BODY" | grep -oP '(?i)\bCloses #\K\d+' | head -1)}"
if [ -z "$ISSUE_NUMBER" ]; then
  echo "BLOCKED: cannot resolve linked issue — pass --issue explicitly"
  # EXIT REMEDIATE_RESULT: status: BLOCKED, blocker: "cannot resolve linked issue — pass --issue explicitly"
fi
```

**Load the linked issue and validate it is a genuine remediation target**:

```bash
ISSUE_STATE=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels,state,body,milestone)
ISSUE_LABELS=$(echo "$ISSUE_STATE" | jq -r '[.labels[].name] | join(",")')
```

- If `needs-human` is NOT among `ISSUE_LABELS` → EXIT `REMEDIATE_RESULT: status: BLOCKED`, blocker: "issue #{ISSUE_NUMBER} is not `needs-human` — remediation mode only targets `needs-human`-gated PRs; use the normal `/work-on {ISSUE_NUMBER}` resume path instead." This keeps blast radius scoped to exactly the gap this mode fills — it is not a general-purpose re-review trigger.

**Bounded cycle identity and resume check** — Phases M0–M7 are the body of a convergence loop with a finite cycle cap, `MAX_REMEDIATION_CYCLES=3`. A cycle is scoped to the distinct reviewed HEAD and confirmed blocker finding set, not to the PR for all time. The paper trail lives on **both** the PR (primary) and linked issue (mirror).

Derive the current cycle key from the lowercased full reviewed HEAD SHA plus the sorted, unique set of open confirmed HIGH/CRITICAL review-finding issue numbers. Do not use titles, short SHAs, comment order, or prose summaries as identity. A GitHub read failure is distinct from an empty finding set and fails closed:

```bash
MAX_REMEDIATION_CYCLES=3
[ -n "$REVIEWED_HEAD_SHA" ] || {
  echo "BLOCKED: cannot resolve the PR's full reviewed HEAD SHA"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}

set +e
PR_BLOCKER_JSON=$(gh issue list {GH_FLAG} --state open --label "review-finding" --limit 100 \
  --json number,title,body \
  --jq "[.[] | select(.body | test(\"(?m)^\\\\*\\\\*Source\\\\*\\\\*:[[:space:]]*PR #{PR_NUMBER}([[:space:]]+—.*)?[[:space:]]*$\")) | select(.body | test(\"(?m)^\\\\*\\\\*Confidence\\\\*\\\\*:[[:space:]]*CONFIRMED[[:space:]]*$\")) | select(.body | test(\"(?m)^\\\\*\\\\*Severity\\\\*\\\\*:[[:space:]]*(HIGH|CRITICAL)[[:space:]]*$\"))]" 2>/dev/null)
PR_BLOCKER_EXIT=$?
set -e
if [ "$PR_BLOCKER_EXIT" -ne 0 ] || ! echo "$PR_BLOCKER_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "BLOCKED: cannot read the current confirmed blocker finding set; refusing to claim a remediation cycle"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
fi
BLOCKER_FINDING_SET=$(echo "$PR_BLOCKER_JSON" | jq -r 'map(.number) | unique | sort | map(tostring) | join(",")')
CYCLE_KEY="${REVIEWED_HEAD_SHA}:${BLOCKER_FINDING_SET:-none}"

set +e
PR_REMEDIATION_COMMENT_PAGES=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments --paginate --slurp 2>/dev/null)
PR_COMMENTS_EXIT=$?
set -e
PR_REMEDIATION_COMMENTS=$(echo "$PR_REMEDIATION_COMMENT_PAGES" | jq '
  def trusted: (.user.type == "Bot") or (.author_association | IN("OWNER","MEMBER","COLLABORATOR"));
  (add // []) | map(select(trusted))' 2>/dev/null || echo 'null')
if [ "$PR_COMMENTS_EXIT" -ne 0 ] || ! echo "$PR_REMEDIATION_COMMENTS" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "BLOCKED: cannot read remediation receipts; refusing to infer cycle eligibility"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
fi

COMPLETED_CYCLE_KEYS=$(echo "$PR_REMEDIATION_COMMENTS" | jq -r \
  '[.[] | select(.body | (contains("**Cycle attempted**: false") | not)) | select(.body | (contains("FORGE:REMEDIATION:COMPLETE") or contains("**Cycle state**: COMPLETE-CONTINUE"))) | .body | capture("\\*\\*Cycle key\\*\\*: `(?<key>[^`]+)`")?.key] | map(select(. != null)) | unique | .[]')
CYCLES_COMPLETED=$(printf '%s\n' "$COMPLETED_CYCLE_KEYS" | grep -c . || true)
REMEDIATION_CYCLE=$((CYCLES_COMPLETED + 1))
ATTEMPTED_CYCLE_KEYS=$(printf '%s\n' "$COMPLETED_CYCLE_KEYS" | grep -v '^$' | awk '!seen[$0]++')
SAME_CYCLE_COMPLETE=$(echo "$PR_REMEDIATION_COMMENTS" | jq --arg key "$CYCLE_KEY" \
  '[.[] | select((.body | (contains("FORGE:REMEDIATION:COMPLETE") or contains("**Cycle state**: COMPLETE-CONTINUE"))) and (.body | contains("**Cycle key**: `" + $key + "`")))] | length')
LEGACY_TERMINAL_COMPLETE=$(echo "$PR_REMEDIATION_COMMENTS" | jq \
  '[.[] | select(.body | contains("FORGE:REMEDIATION:COMPLETE")) | select(.body | (contains("**Cycle key**:") | not)) | select(.body | test("Re-gate outcome\\*\\*:[[:space:]]*(AUTO-LANDED|HELD-AWAITING-MERGE|UNFIXABLE)"; "i"))] | length')
```

- `SAME_CYCLE_COMPLETE > 0` → EXIT `REMEDIATE_RESULT: status: ALREADY_DONE`. Only the same cycle key is suppressed.
- `LEGACY_TERMINAL_COMPLETE > 0` → EXIT `REMEDIATE_RESULT: status: ALREADY_DONE`. This compatibility guard applies only to a legacy clean/unfixable terminal outcome; a legacy `RE-ESCALATED` receipt does not suppress a distinct current HEAD/finding set.
- `CYCLES_COMPLETED >= MAX_REMEDIATION_CYCLES` with a distinct current key → when `DRY_RUN=true`, report the prospective cap outcome and return immediately without Phase M8 writes. Otherwise set `CAP_EXHAUSTED=true`, `CYCLE_ATTEMPTED=false`, `REMEDIATION_CYCLE=MAX_REMEDIATION_CYCLES`, `BLOCKED_NEXT_CYCLE_KEY="$CYCLE_KEY"`, and `REMAINING_BLOCKER_FINDING_SET="$BLOCKER_FINDING_SET"`; preserve the three-key `ATTEMPTED_CYCLE_KEYS`, skip directly to Phase M8, retain `needs-human`, and return `RE-ESCALATED`. The cap receipt remains keyed to `BLOCKED_NEXT_CYCLE_KEY` so a duplicate same-input invocation is suppressed, while completed-cycle counting excludes receipts carrying `**Cycle attempted**: false`; never post a claim or begin a fourth cycle.

**Atomic-enough renewable per-cycle claim**: Before checkout or label mutation, post a file-backed `FORGE:REMEDIATION` claim to the PR and mirror it to the issue with `Cycle key`, `Cycle ordinal: CYCLES_COMPLETED + 1`, `State: CLAIMED`, an opaque `Owner token`, and `Lease renewed at`. Read only trusted PR comments (Bot or OWNER/MEMBER/COLLABORATOR), then elect the lowest server-assigned comment ID for this exact cycle key. The winner continues; every later claimant exits `BLOCKED` retryably without touching files or labels.

The winner MUST renew its claim at least every 10 minutes throughout M2–M4, after every quality-gate iteration, and immediately before commit, push, finding closure, or re-review. A claim is takeover-eligible only when its trusted elected receipt's `updated_at` is older than 30 minutes and no later trusted progress/completion exists. A contender must re-fetch that exact comment immediately before deletion and verify its ID, cycle key, owner token, and stale `updated_at` are unchanged. Every destructive side effect calls `assert_cycle_claim_owner` immediately first. This renewable lease and compare-before-delete protocol prevents a live long-running worker from coexisting with a replacement while preserving bounded crash recovery.

The claim body and every later progress/completion body MUST carry:

```text
**Cycle key**: `{REVIEWED_HEAD_SHA}:{SORTED_BLOCKER_FINDING_SET_OR_none}`
**Cycle ordinal**: {N}/{MAX_REMEDIATION_CYCLES}
```

Post and verify the claim before Phase M1 mutates state. First remove only expired bare claims for this exact key. A claim is stale only when it is older than 30 minutes and no later progress/completion receipt for the key exists. Read failures during stale detection or mirror lookup fail closed; they are never treated as permission to dispatch:

```bash
# The cap guard above has already passed, so this key is now an actual attempted cycle.
ATTEMPTED_CYCLE_KEYS=$(printf '%s\n%s\n' "$ATTEMPTED_CYCLE_KEYS" "$CYCLE_KEY" | grep -v '^$' | awk '!seen[$0]++')
NOW_EPOCH=$(date -u +%s)
STALE_PR_CLAIMS=$(echo "$PR_REMEDIATION_COMMENTS" | jq -r --arg key "$CYCLE_KEY" --argjson now "$NOW_EPOCH" '
  . as $all | [.[] | select(.body | contains("**Cycle key**: `" + $key + "`") and contains("**State**: CLAIMED"))
  | select(($now - (.updated_at | fromdateiso8601)) >= 1800)
  | . as $claim
  | select([$all[] | select(.updated_at > $claim.updated_at) | select(.body | contains("**Cycle key**: `" + $key + "`"))
      | select(.body | (contains("Remediation In Progress") or contains("FORGE:REMEDIATION:COMPLETE") or contains("**Cycle state**: COMPLETE-CONTINUE")))] | length == 0)
  | {id, updated_at, owner: (.body | capture("\\*\\*Owner token\\*\\*: `(?<v>[^`]+)`")?.v // "")}]
  | .[] | [.id, .updated_at, .owner] | @tsv') || {
  echo "BLOCKED: cannot evaluate stale remediation claims"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "DRY_RUN: would clean stale claims, claim cycle ${CYCLE_KEY}, and run remediation; no GitHub or git writes performed"
  # RETURN NOW — do not fall through to stale cleanup, claim creation, or any later phase.
  # REMEDIATE_RESULT: status: BLOCKED, re_gate_outcome: N/A, blocker: dry-run report only
fi

if [ -n "$STALE_PR_CLAIMS" ]; then
  set +e
  ISSUE_COMMENT_PAGES=$(gh api repos/{GH_REPO}/issues/{ISSUE_NUMBER}/comments --paginate --slurp 2>/dev/null)
  ISSUE_COMMENTS_EXIT=$?
  set -e
  ISSUE_REMEDIATION_COMMENTS=$(echo "$ISSUE_COMMENT_PAGES" | jq '
    def trusted: (.user.type == "Bot") or (.author_association | IN("OWNER","MEMBER","COLLABORATOR"));
    (add // []) | map(select(trusted))' 2>/dev/null || echo 'null')
  if [ "$ISSUE_COMMENTS_EXIT" -ne 0 ] || ! echo "$ISSUE_REMEDIATION_COMMENTS" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "BLOCKED: cannot read stale-claim mirrors; refusing partial cleanup"
    # EXIT REMEDIATE_RESULT: status: BLOCKED
  fi
  STALE_PR_OWNERS=$(printf '%s\n' "$STALE_PR_CLAIMS" | cut -f3 | jq -Rsc 'split("\n") | map(select(. != ""))')
  STALE_ISSUE_CLAIMS=$(echo "$ISSUE_REMEDIATION_COMMENTS" | jq -r --arg key "$CYCLE_KEY" --argjson now "$NOW_EPOCH" --argjson stale_owners "$STALE_PR_OWNERS" '
    . as $all | [.[] | select(.body | contains("**Cycle key**: `" + $key + "`") and contains("**State**: CLAIMED"))
    | (.body | capture("\\*\\*Owner token\\*\\*: `(?<v>[^`]+)`")?.v // "") as $owner
    | select($stale_owners | index($owner) != null)
    | select(($now - (.updated_at | fromdateiso8601)) >= 1800)
    | . as $claim
    | select([$all[] | select(.updated_at > $claim.updated_at) | select(.body | contains("**Cycle key**: `" + $key + "`"))
        | select(.body | (contains("Remediation In Progress") or contains("FORGE:REMEDIATION:COMPLETE") or contains("**Cycle state**: COMPLETE-CONTINUE")))] | length == 0)
    | {id, updated_at, owner: (.body | capture("\\*\\*Owner token\\*\\*: `(?<v>[^`]+)`")?.v // "")}]
    | .[] | [.id, .updated_at, .owner] | @tsv')
  while IFS=$'\t' read -r COMMENT_ID SNAPSHOT_UPDATED_AT SNAPSHOT_OWNER; do
    [ -n "$COMMENT_ID" ] || continue
    # Compare immediately before delete. Renewal updates updated_at, so a live owner wins.
    FRESH_CLAIM=$(gh api repos/{GH_REPO}/issues/comments/$COMMENT_ID 2>/dev/null) || {
      echo "BLOCKED: stale-claim revalidation failed for $COMMENT_ID"
      # EXIT REMEDIATE_RESULT: status: BLOCKED
    }
    FRESH_MATCH=$(echo "$FRESH_CLAIM" | jq -r --arg key "$CYCLE_KEY" --arg updated "$SNAPSHOT_UPDATED_AT" --arg owner "$SNAPSHOT_OWNER" --argjson now "$(date -u +%s)" '
      ($owner != "") and ((.user.type == "Bot") or (.author_association | IN("OWNER","MEMBER","COLLABORATOR")))
      and (.updated_at == $updated) and (($now - (.updated_at | fromdateiso8601)) >= 1800)
      and (.body | contains("**Cycle key**: `" + $key + "`") and contains("**State**: CLAIMED") and contains("**Owner token**: `" + $owner + "`"))')
    [ "$FRESH_MATCH" = "true" ] || {
      echo "BLOCKED: claim $COMMENT_ID renewed or changed during takeover; live owner retains lease"
      # EXIT REMEDIATE_RESULT: status: BLOCKED
    }
    gh api repos/{GH_REPO}/issues/comments/$COMMENT_ID -X DELETE || {
      echo "BLOCKED: failed to delete stale PR claim $COMMENT_ID"
      # EXIT REMEDIATE_RESULT: status: BLOCKED
    }
  done <<< "$STALE_PR_CLAIMS"
  while IFS=$'\t' read -r COMMENT_ID SNAPSHOT_UPDATED_AT SNAPSHOT_OWNER; do
    [ -n "$COMMENT_ID" ] || continue
    FRESH_MIRROR=$(gh api repos/{GH_REPO}/issues/comments/$COMMENT_ID 2>/dev/null) || {
      echo "BLOCKED: stale mirror revalidation failed for $COMMENT_ID"
      # EXIT REMEDIATE_RESULT: status: BLOCKED
    }
    FRESH_MIRROR_MATCH=$(echo "$FRESH_MIRROR" | jq -r --arg key "$CYCLE_KEY" --arg updated "$SNAPSHOT_UPDATED_AT" --arg owner "$SNAPSHOT_OWNER" --argjson now "$(date -u +%s)" '
      ($owner != "") and ((.user.type == "Bot") or (.author_association | IN("OWNER","MEMBER","COLLABORATOR")))
      and (.updated_at == $updated) and (($now - (.updated_at | fromdateiso8601)) >= 1800)
      and (.body | contains("**Cycle key**: `" + $key + "`") and contains("**State**: CLAIMED") and contains("**Owner token**: `" + $owner + "`"))')
    [ "$FRESH_MIRROR_MATCH" = "true" ] || {
      echo "BLOCKED: claim mirror $COMMENT_ID renewed, changed, or became untrusted during takeover"
      # EXIT REMEDIATE_RESULT: status: BLOCKED
    }
    gh api repos/{GH_REPO}/issues/comments/$COMMENT_ID -X DELETE || {
      echo "BLOCKED: failed to delete stale issue claim mirror $COMMENT_ID"
      # EXIT REMEDIATE_RESULT: status: BLOCKED
    }
  done <<< "$STALE_ISSUE_CLAIMS"
fi

OWNER_TOKEN="remediate-{PR_NUMBER}-$(date -u +%s)-$$-$RANDOM"
CLAIM_BODY_FILE=$(mktemp)
cat > "$CLAIM_BODY_FILE" <<EOF
<!-- FORGE:REMEDIATION -->
## Remediation Cycle Claim for PR #{PR_NUMBER}

**Cycle key**: \`${CYCLE_KEY}\`
**Cycle ordinal**: ${REMEDIATION_CYCLE}/${MAX_REMEDIATION_CYCLES}
**State**: CLAIMED
**Owner token**: \`${OWNER_TOKEN}\`
**Claimed at**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Lease renewed at**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
CLAIM_URL=$(gh pr comment {PR_NUMBER} {GH_FLAG} --body-file "$CLAIM_BODY_FILE") || {
  rm -f "$CLAIM_BODY_FILE"; echo "BLOCKED: failed to post PR remediation claim"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
ISSUE_CLAIM_URL=$(gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body-file "$CLAIM_BODY_FILE") || {
  CLAIM_ID_TO_CLEAN=$(echo "$CLAIM_URL" | grep -oE '[0-9]+$')
  if [ -n "$CLAIM_ID_TO_CLEAN" ]; then
    ROLLBACK_CLAIM=$(gh api repos/{GH_REPO}/issues/comments/$CLAIM_ID_TO_CLEAN 2>/dev/null) || ROLLBACK_CLAIM=""
    echo "$ROLLBACK_CLAIM" | jq -e --arg key "$CYCLE_KEY" --arg owner "$OWNER_TOKEN" '
      (.body | contains("**Cycle key**: `" + $key + "`") and contains("**State**: CLAIMED") and contains("**Owner token**: `" + $owner + "`"))' >/dev/null &&
      gh api repos/{GH_REPO}/issues/comments/$CLAIM_ID_TO_CLEAN -X DELETE 2>/dev/null || true
  fi
  rm -f "$CLAIM_BODY_FILE"; echo "BLOCKED: failed to post issue remediation claim mirror; primary claim rolled back"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
rm -f "$CLAIM_BODY_FILE"
CLAIM_ID=$(echo "$CLAIM_URL" | grep -oE '[0-9]+$')
ISSUE_CLAIM_ID=$(echo "$ISSUE_CLAIM_URL" | grep -oE '[0-9]+$')
[ -n "$CLAIM_ID" ] && [ -n "$ISSUE_CLAIM_ID" ] || {
  echo "BLOCKED: claim write returned no verifiable comment ID"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
for COMMENT_REF in "{PR_NUMBER}:$CLAIM_ID" "{ISSUE_NUMBER}:$ISSUE_CLAIM_ID"; do
  COMMENT_ID=${COMMENT_REF#*:}
  CLAIM_READBACK=$(gh api repos/{GH_REPO}/issues/comments/$COMMENT_ID --jq '.body' 2>/dev/null) || {
    echo "BLOCKED: claim read-back failed for comment $COMMENT_ID"
    # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
  printf '%s' "$CLAIM_READBACK" | grep -Fq "**Cycle key**: \`${CYCLE_KEY}\`" &&
    printf '%s' "$CLAIM_READBACK" | grep -Fq '**State**: CLAIMED' &&
    printf '%s' "$CLAIM_READBACK" | grep -Fq "**Owner token**: \`${OWNER_TOKEN}\`" || {
      echo "BLOCKED: claim read-back did not preserve the exact cycle key/state/owner"
      # EXIT REMEDIATE_RESULT: status: BLOCKED
    }
done

set +e
CLAIM_ELECTION_PAGES=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments --paginate --slurp 2>/dev/null)
CLAIM_ELECTION_EXIT=$?
set -e
CLAIM_ELECTION_COMMENTS=$(echo "$CLAIM_ELECTION_PAGES" | jq '
  def trusted: (.user.type == "Bot") or (.author_association | IN("OWNER","MEMBER","COLLABORATOR"));
  (add // []) | map(select(trusted))' 2>/dev/null || echo 'null')
if [ "$CLAIM_ELECTION_EXIT" -ne 0 ] || ! echo "$CLAIM_ELECTION_COMMENTS" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "BLOCKED: claim election read failed; do not mutate the PR"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
fi
CLAIM_WINNER_ID=$(echo "$CLAIM_ELECTION_COMMENTS" | jq -r --arg key "$CYCLE_KEY" \
  '[.[] | select(.body | contains("**Cycle key**: `" + $key + "`") and contains("**State**: CLAIMED"))] | sort_by(.id) | first | .id // empty')
[ "$CLAIM_ID" = "$CLAIM_WINNER_ID" ] || {
  echo "BLOCKED: remediation cycle already claimed by comment ${CLAIM_WINNER_ID}"
  # EXIT REMEDIATE_RESULT: status: BLOCKED (retryable duplicate suppression)
}
```

Define lease helpers after election. Both helpers fail closed. `renew_cycle_claim` PATCHes both elected mirrors, reads them back, and therefore updates GitHub's authoritative `updated_at`; `assert_cycle_claim_owner` filters to trusted comments, verifies that this comment remains the elected lowest-ID live claim for the key, and matches `OWNER_TOKEN`.

```bash
assert_cycle_claim_owner() {
  local comments winner id claim
  comments=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments --paginate --slurp 2>/dev/null \
    | jq 'def trusted: (.user.type == "Bot") or (.author_association | IN("OWNER","MEMBER","COLLABORATOR")); (add // []) | map(select(trusted))') || return 1
  winner=$(echo "$comments" | jq -r --arg key "$CYCLE_KEY" \
    '[.[] | select(.body | contains("**Cycle key**: `" + $key + "`") and contains("**State**: CLAIMED"))] | sort_by(.id) | first | .id // empty')
  [ "$winner" = "$CLAIM_ID" ] || return 1
  for id in "$CLAIM_ID" "$ISSUE_CLAIM_ID"; do
    claim=$(gh api repos/{GH_REPO}/issues/comments/$id 2>/dev/null) || return 1
    echo "$claim" | jq -e --arg key "$CYCLE_KEY" --arg owner "$OWNER_TOKEN" --argjson now "$(date -u +%s)" '
      ((.user.type == "Bot") or (.author_association | IN("OWNER","MEMBER","COLLABORATOR")))
      and (($now - (.updated_at | fromdateiso8601)) < 1800)
      and (.body | contains("**Cycle key**: `" + $key + "`") and contains("**State**: CLAIMED") and contains("**Owner token**: `" + $owner + "`"))' >/dev/null || return 1
  done
}
renew_cycle_claim() {
  assert_cycle_claim_owner || return 1
  local id current renewed
  for id in "$CLAIM_ID" "$ISSUE_CLAIM_ID"; do
    current=$(gh api repos/{GH_REPO}/issues/comments/$id --jq '.body' 2>/dev/null) || return 1
    printf '%s' "$current" | grep -Fq "**Owner token**: \`${OWNER_TOKEN}\`" || return 1
    renewed=$(printf '%s\n' "$current" | sed "s/^\\*\\*Lease renewed at\\*\\*: .*/**Lease renewed at**: $(date -u +%Y-%m-%dT%H:%M:%SZ)/")
    gh api repos/{GH_REPO}/issues/comments/$id -X PATCH --field body="$renewed" >/dev/null || return 1
    gh api repos/{GH_REPO}/issues/comments/$id --jq '.body' 2>/dev/null | grep -Fq "**Owner token**: \`${OWNER_TOKEN}\`" || return 1
  done
}
```

Call `renew_cycle_claim` on a timer no slower than 10 minutes and after each long subcommand. Call `assert_cycle_claim_owner` immediately before every commit, push, finding close, label mutation, review dispatch, or other destructive side effect; failure adds no mutation and returns retryable `BLOCKED`. The cycle key is also the durable handoff consumed by orchestrator item 6.4.

---

## Phase M1: Load Prior Findings & Classify the Block Reason

Gather everything that caused (or is still causing) `needs-human`:

**M1a — Open review-finding issues spawned from this PR**. Trust the anchored machine-readable `Source`, `Confidence`, and `Severity` fields, never a title substring (which can misattribute PR `#30` to `#3022` or accept spoofed prose):
```bash
FINDINGS=$(gh issue list {GH_FLAG} --state open --label "review-finding" --limit 100 \
  --json number,title,body \
  --jq "[.[] | select(.body | test(\"(?m)^\\\\*\\\\*Source\\\\*\\\\*:[[:space:]]*PR #{PR_NUMBER}([[:space:]]+—.*)?[[:space:]]*$\")) | select(.body | test(\"(?m)^\\\\*\\\\*Confidence\\\\*\\\\*:[[:space:]]*(CONFIRMED|LIKELY)[[:space:]]*$\")) | select(.body | test(\"(?m)^\\\\*\\\\*Severity\\\\*\\\\*:[[:space:]]*(CRITICAL|HIGH|MEDIUM|LOW)[[:space:]]*$\"))]")
```

**M1b — PR review verdicts and merge-block reasons** (Phase 8 of `review-pr.md` records the exact block reason on the linked issue when it aborts auto-merge — read that trail rather than re-deriving it). Only trusted authors may supply this control-plane receipt:
```bash
BLOCK_COMMENTS=$(gh api repos/{GH_REPO}/issues/{ISSUE_NUMBER}/comments \
  --jq '[.[] | select((.user.type == "Bot") or (.author_association == "OWNER") or (.author_association == "MEMBER") or (.author_association == "COLLABORATOR")) | select(.body | test("Auto-merge aborted|not mergeable|Pre-Push Ancestry Guard Failed|Push Failed|Quality Gate Failed"; "i"))] | last')
```

**Classify into FIXABLE vs. UNFIXABLE**:
- **FIXABLE** — open `review-finding` issues (CONFIRMED/LIKELY code defects), a `VERDICT=CHANGES REQUESTED` block with concrete findings attached, a mergeability guard failure (`CONFLICTING`/`DIRTY`/`BLOCKED` — resolvable by rebasing onto `{PR_BASE}`), or a quality-gate/build failure.
- **UNFIXABLE (policy escalation)** — `HAS_PURPOSE_REGRESSION=true` (the PR's behavior diverges from the issue's intent — a judgment call, not a code defect), `CALIBRATION_NEEDS_HUMAN=true` (statistical trust threshold), or `TRUST_NEEDS_HUMAN=true` (provenance `NOVEL_NEEDS_HUMAN` tier, insufficient prior data — a policy gate, not a bug). None of these are mechanically "fixable" by re-editing code.

**If the block reason classifies as UNFIXABLE** (and no FIXABLE item accompanies it): do NOT attempt any fix. Skip directly to Phase M8 with verdict `UNFIXABLE`, re-affirm `needs-human` (it should already be present), and return `REMEDIATE_RESULT: status: UNFIXABLE`. This satisfies AC5 — "genuinely-blocked PRs still terminate at `needs-human`."

**If at least one FIXABLE item exists**: transition the issue out of its terminal gate before proceeding to Phase M2. `needs-human` represents the prior review result, not an active automated remediation run; retaining it would make the dispatcher and recovery paths stop while remediation is in progress. Keep exactly one active workflow state:

```bash
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "BLOCKED: DRY_RUN must already have returned from Phase M0"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
else
  assert_cycle_claim_owner || {
    echo "BLOCKED: cycle ownership lost before label transition"
    # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} \
    --add-label "workflow:in-review" \
    --remove-label "needs-human" 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
fi
```

Do not perform this transition for an UNFIXABLE policy escalation. Any later quality-gate, push, or re-review block re-adds `needs-human`; after re-review, remove `workflow:in-review` whenever that terminal label is present.

---

## Phase M2: Checkout the PR's Existing Branch

Remediation always fixes forward on top of the PR's existing head commit — never rebase onto a different base and never force-push over the PR's history unless a fix genuinely requires it (e.g. resolving a merge conflict per the mergeability guard case, in which case use `git rebase`/`git merge` onto `origin/{PR_BASE}` exactly as the branch's own commit history would, then `--force-with-lease`).

```bash
assert_cycle_claim_owner || {
  echo "BLOCKED: cycle ownership lost before checkout/worktree mutation"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
cd {REPO_PATH}
git fetch origin
WORKTREE_PATH="{WORKTREE_BASE}/remediate-{HEAD_BRANCH_SLUG}-{PR_NUMBER}"
if [ -d "{WORKTREE_PATH}" ]; then
  git -C "{WORKTREE_PATH}" fetch origin
  assert_cycle_claim_owner || { echo "BLOCKED: ownership lost before checkout"; # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
  git -C "{WORKTREE_PATH}" checkout {HEAD_BRANCH}
  assert_cycle_claim_owner || { echo "BLOCKED: ownership lost before reset"; # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
  git -C "{WORKTREE_PATH}" reset --hard "origin/{HEAD_BRANCH}"
else
  assert_cycle_claim_owner || { echo "BLOCKED: ownership lost before worktree creation"; # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
  git worktree add "{WORKTREE_PATH}" {HEAD_BRANCH} "origin/{HEAD_BRANCH}"
fi
```

If the worktree/branch checkout fails for any reason (branch deleted, force-pushed out from under us, etc.): post a comment, add `needs-human`, EXIT `REMEDIATE_RESULT: status: BLOCKED`.

Immediately after checkout, call `renew_cycle_claim`; while applying edits, renew again whenever 10 minutes have elapsed. A renewal failure stops before further file or GitHub mutation.

---

## Phase M3: Apply Fixes

For each FIXABLE item from Phase M1: read the affected file(s) in `{WORKTREE_PATH}` before editing (never assume current state), apply the fix. Follow the same implementation discipline as `work-on.md` Phase 3F (cross-lane import guard, library-callback verification, deliverable-type consistency, no unrequested scope) — this file does not restate those rules, it inherits them.

**If the block reason was a mergeability conflict** (`CONFLICTING`/`DIRTY`/`BLOCKED`): resolve it by rebasing `{HEAD_BRANCH}` onto `origin/{PR_BASE}` (or merging `{PR_BASE}` in, whichever preserves a clean, reviewable history) — resolve conflicts manually, do not blindly take "ours"/"theirs". Call `assert_cycle_claim_owner` immediately before every edit, rebase/merge continuation, conflict-resolution stage, and quality-gate re-stage; ownership failure stops the cycle before that mutation.

**Quality Gate** (same loop as Phase 3G, max 3 iterations):
```
iteration = 0
while iteration < 3:
    iteration += 1
    renew_cycle_claim or return BLOCKED before invoking the gate
    Skill("quality-gate", args="{CHANGED_FILES} --worktree {WORKTREE_PATH}")
    renew_cycle_claim or return BLOCKED after the gate returns
    if result == "QUALITY GATE: PASS": GATE_PASSED=true; break
    else: fix each HIGH/MEDIUM finding, re-stage; renew_cycle_claim again
```
If still failing after 3 iterations: post a comment, re-affirm `needs-human`, EXIT `REMEDIATE_RESULT: status: BLOCKED`. Do not proceed to re-review with an unresolved gate failure — that would just re-escalate one phase later with a worse paper trail.

**Format/verify**: run the project's configured `verification.commands` (same as Phase 3H) before committing.

---

## Phase M4: Commit, Push, and Close Addressed Findings

```bash
cd {WORKTREE_PATH}
renew_cycle_claim && assert_cycle_claim_owner || {
  echo "BLOCKED: cycle ownership lost before staging"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
git add -u
assert_cycle_claim_owner || {
  echo "BLOCKED: cycle ownership lost before commit"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
git commit -s -m "fix(remediate): {description} (#{ISSUE_NUMBER})"
renew_cycle_claim && assert_cycle_claim_owner || {
  echo "BLOCKED: cycle ownership lost before push"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
git push origin {HEAD_BRANCH}
```

If push fails, retry with `--force-with-lease` (expected when M3 rebased to resolve a conflict). If it still fails: post a comment, add `needs-human`, EXIT `REMEDIATE_RESULT: status: BLOCKED`.

**Close each addressed review-finding issue directly** (this remediation fixes findings in-place on the existing PR, rather than each finding spawning its own downstream `/work-on` pipeline — leaving them open would have a future run rediscover already-fixed code). Track the closed numbers in `ADDRESSED_FINDING_NUMBERS[]` — Phase M8 reports this array in the final paper trail:
```bash
ADDRESSED_FINDING_NUMBERS=()
for FINDING_NUM in {FIXABLE_FINDING_NUMBERS_FROM_M1}; do
  renew_cycle_claim && assert_cycle_claim_owner || {
    echo "BLOCKED: cycle ownership lost before closing finding $FINDING_NUM"
    # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
  gh issue close "$FINDING_NUM" {GH_FLAG} \
    --comment "Fixed by remediation of PR #{PR_NUMBER} (commit {COMMIT_SHA}). See #{ISSUE_NUMBER}."
  ADDRESSED_FINDING_NUMBERS+=("$FINDING_NUM")
done
```
Only close findings actually addressed in this commit — leave any FIXABLE-but-deferred or unrelated open findings untouched.

---

## Phase M5: Post Interim FORGE:REMEDIATION Progress (before re-review)

Post the same body to **both** `{PR_NUMBER}` and `{ISSUE_NUMBER}` (PR copy is the idempotency source of truth; issue copy keeps the standard trajectory/resume logic consistent):

```bash
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "DRY_RUN: would post remediation progress and invoke re-review for cycle ${CYCLE_KEY}"
else
  renew_cycle_claim && assert_cycle_claim_owner || {
    echo "BLOCKED: cycle ownership lost before progress/re-review"
    # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
REMEDIATION_PROGRESS_BODY=$(cat <<EOF
<!-- FORGE:REMEDIATION -->
## Remediation In Progress for PR #{PR_NUMBER}

**Cycle key**: \`${CYCLE_KEY}\`
**Cycle ordinal**: ${REMEDIATION_CYCLE}/${MAX_REMEDIATION_CYCLES}
**Findings addressed**:
{bulleted list: finding # — title — one-line fix summary}

**Commit**: {COMMIT_SHA}
**Quality gate**: {iterations} iteration(s), PASS

Re-invoking \`/review-pr --auto-merge\` now.
EOF
)
REMEDIATION_PROGRESS_FILE=$(mktemp)
printf '%s' "$REMEDIATION_PROGRESS_BODY" > "$REMEDIATION_PROGRESS_FILE"
gh pr comment {PR_NUMBER} {GH_FLAG} --body-file "$REMEDIATION_PROGRESS_FILE"
assert_cycle_claim_owner || {
  echo "BLOCKED: cycle ownership lost before progress mirror"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body-file "$REMEDIATION_PROGRESS_FILE"
rm -f "$REMEDIATION_PROGRESS_FILE"
fi
```

Note the marker is `<!-- FORGE:REMEDIATION -->` with **no** `:COMPLETE` suffix yet. The cycle key distinguishes this progress receipt from earlier cycles. M0's stale-claim rule, rather than a PR-wide partial-comment delete, controls interrupted recovery.

---

## Phase M6: Re-Invoke /review-pr

Immediately before either runtime dispatch, renew and verify ownership. A review can mutate verdict comments, labels, and merge state, so it is a destructive side effect for lease purposes:

```
renew_cycle_claim && assert_cycle_claim_owner or return BLOCKED
Skill(skill="review-pr", args="{PR_NUMBER} --auto-merge --issue {ISSUE_NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}")
```

**OpenCode joined-child contract**: When `FORGE_RUNTIME=opencode` (or an OpenCode runtime marker is present), run this required re-review through one native foreground `task`:

```
if DRY_RUN=true:
  record "Would invoke the foreground re-review task for PR #{PR_NUMBER}."
else:
  task(
    description="Re-review PR #{PR_NUMBER}",
    subagent_type="general",
    background=false,
    prompt="Load commands/review-pr.md and execute it for PR {PR_NUMBER} with --auto-merge --issue {ISSUE_NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}. Return only the structured REVIEW_RESULT block after the review reaches its outcome."
  )
```

Wait for the completed child result and retain its `REVIEW_RESULT` in remediation state before continuing to Phase M7. A running/progress response is not a completion result. If the child errors or does not return a parseable `REVIEW_RESULT`, stop with `REMEDIATE_RESULT: status: BLOCKED`; do not report remediation in progress as a terminal parent result. The `Skill(...)` invocation above remains the non-OpenCode path.

This re-runs the full review (domain agents → verdict → Phase 8 auto-merge gate). The FIXABLE transition above left the issue at the non-terminal `workflow:in-review` state. `review-pr.md` recognizes the in-progress `FORGE:REMEDIATION` marker posted in Phase M5 as evidence of the prior escalation, so one of two things happens inside Phase 8:

- **Re-escalated**: the re-review itself trips a fresh block (`CHANGES REQUESTED`, purpose-regression, calibration, trust, or a still-`CONFLICTING` mergeability check) → it adds `needs-human`, and this phase removes `workflow:in-review`, leaving one terminal state.
- **Clean re-review**: `VERDICT=APPROVED`-equivalent, mergeable, and the "Previously-escalated re-review guard" (forge#1810) fires — setting `workflow:awaiting-merge` and removing `workflow:in-review`, *without* auto-merging (that guard's own safe default, left untouched by this file).

```bash
POST_REVIEW_LABELS=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels --jq '[.labels[].name] | join(",")')
if echo "$POST_REVIEW_LABELS" | grep -qE '(^|,)needs-human(,|$)'; then
  assert_cycle_claim_owner || {
    echo "BLOCKED: cycle ownership lost before post-review label cleanup"
    # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} --remove-label "workflow:in-review" 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
fi
```

Extract the re-review verdict for the paper trail (Phase M8 reports this verbatim):
```bash
RE_REVIEW_VERDICT=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select((.user.type == "Bot") or (.author_association == "OWNER") or (.author_association == "MEMBER") or (.author_association == "COLLABORATOR")) | select(.body | test("APPROVED:|CHANGES REQUESTED:"; "i"))] | last | .body // "unknown"' 2>/dev/null | head -c 200)
```

---

## Phase M7: Compute the #1809 Q1 Auto-Land Bar

Re-read the issue's current labels after M6:
```bash
POST_REVIEW_LABELS=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels --jq '[.labels[].name] | join(",")')
```

**If `needs-human` is present** (re-escalated case): re-run Phase M1's FIXABLE/UNFIXABLE classification against the fresh full HEAD and open blocker set before deciding to stop.

- If the new block is policy-level/unfixable, set `RE_GATE_OUTCOME="UNFIXABLE"` and skip to Phase M8.
- Derive `NEXT_CYCLE_KEY` using the exact M0 recipe. If it equals `CYCLE_KEY`, no distinct remediation input exists; set `RE_GATE_OUTCOME="RE-ESCALATED"` and skip to Phase M8 rather than re-reviewing the same state.
- If the blocker is FIXABLE, re-fetch `headRefOid` and the blocker list with the same exit-status/type checks as M0, then derive `NEXT_CYCLE_KEY` from that fresh full SHA and confirmed blocker set. Any failed/invalid read sets `RE_GATE_OUTCOME="RE-ESCALATED"` and stops fail-closed; it never yields an empty set or a new cycle.
- If `NEXT_CYCLE_KEY != CYCLE_KEY` and the current ordinal is below `MAX_REMEDIATION_CYCLES`, call `renew_cycle_claim && assert_cycle_claim_owner` immediately before the PR receipt write, re-assert before the issue mirror, then post a file-backed cycle receipt containing the current key/ordinal, `**Cycle state**: COMPLETE-CONTINUE`, the fresh key, and the newly confirmed blocker numbers. Verify both writes by exact marker/key read-back as in M0. Then set `CYCLE_KEY="$NEXT_CYCLE_KEY"`, increment the ordinal, and continue the M0–M7 loop immediately. M0 appends the key to `ATTEMPTED_CYCLE_KEYS` only after its cap guard passes and immediately before claiming it. Do not return to the caller and do not launch a second same-HEAD panel.
- If the new blocker is FIXABLE and distinct but the current ordinal equals the cap, do **not** append the unattempted `NEXT_CYCLE_KEY` to `ATTEMPTED_CYCLE_KEYS`; set `CAP_EXHAUSTED=true`, `CYCLE_ATTEMPTED=true`, `BLOCKED_NEXT_CYCLE_KEY="$NEXT_CYCLE_KEY"`, and `REMAINING_BLOCKER_FINDING_SET` to the freshly confirmed blocker numbers, retain `needs-human`, and set `RE_GATE_OUTCOME="RE-ESCALATED"`. Phase M8 includes exactly the three attempted keys, the `3/3` count, the blocked next key, and the remaining blocker numbers as durable evidence. This cap receipt counts the just-finished third cycle as completed because `**Cycle attempted**` is true.

This models bounded convergence: one cycle can resolve an initial blocker set, a fresh re-review can discover a second set on the new HEAD, and a later clean review still flows through the unchanged base-scoped auto-land bar below.

**If `workflow:awaiting-merge` is present** (clean re-review case — the only branch where `review-pr.md`'s guard has already safely parked this PR): compute the bar.

```bash
# Trust filter: only reviews/comments from repo collaborators (OWNER/MEMBER/COLLABORATOR
# authorAssociation) can contribute to the auto-land bar. Unlike work-on.md Phase 7A's
# informational-only APPROVED: count (a summary-card/decision-record annotation, not a
# merge gate), this count directly drives `gh pr merge` below — so it must not trust
# unauthenticated signal. Any GitHub user can comment "APPROVED: ..." on a public PR;
# authorAssociation is GitHub's own repo-permission classification and cannot be spoofed
# by comment text. (Ref: forge#1976)
REVIEW_BODIES=$(gh pr view {PR_NUMBER} {GH_FLAG} --json reviews,comments \
  --jq '[.reviews[] | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR") | .body // ""] +
        [.comments[] | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR") | .body // ""] | .[]')
APPROVED_COUNT=$(echo "$REVIEW_BODIES" | grep -cE 'APPROVED:' 2>/dev/null || true); APPROVED_COUNT=${APPROVED_COUNT:-0}
```

**Auto-land bar — base-branch scoped** (forge#2570): the condition the PR must clear to auto-land depends on its target branch. This reconciles the remediation bar with the normal `/work-on` fast-lane merge bar for the *same target branch*, while keeping the strict human-verified bar only where a human is genuinely in the loop (the `staging → main` deploy gate).

**Re-derive the base fresh — do NOT reuse `$PR_BASE` for this decision** (forge#2624): `$PR_BASE` was resolved in Phase M0 as `PR_BASE="${PR_BASE:-$(... .baseRefName)}"` — a caller-supplied `--base` wins over the PR's actual live base whenever non-empty. That is fine for M0's own purposes (worktree base, display text), but this is a security-relevant decision point: a wrong/stale `--base staging` on a PR that actually targets `main` must never be allowed to relax the strict deploy-gate bar. Mirror `review-pr.md`'s sibling guard (`GUARD_BASE`, which always re-fetches `baseRefName` fresh at its own decision point) by re-querying the PR's live base here, independent of whatever `$PR_BASE` currently holds:

```bash
# forge#2624: re-fetch baseRefName fresh from the PR itself — never trust the
# M0-resolved $PR_BASE for this decision, since M0 prefers a caller-supplied
# --base over the live value. This is the one line in this phase that makes
# a trust/security decision, so it must be immune to a caller-overridable input.
LIVE_BASE_REF=$(gh pr view {PR_NUMBER} {GH_FLAG} --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "")

# forge#2570: `main` (and any deploy-gate base) keeps the strict #1809 Q1 verified-human bar;
# every other base (staging, milestone/* — the reversible integration branches) reconciles to
# the fast-lane bar. Key on "is the deploy gate", NOT the literal string "staging", so milestone
# branches reconcile too. Fail closed: only a KNOWN, non-empty, non-`main` LIVE base reconciles
# to the fast lane; an empty/unresolved fetch is treated as the deploy gate (strict) so a base-
# resolution failure (or a caller passing a stale/incorrect --base) can never accidentally
# relax the bar.
# forge#2625: `jq -r '.baseRefName'` stringifies a JSON null to the literal text "null" (not an
# empty string), so the `-n` check alone does not catch it — add an explicit `!= "null"` check
# so a literal-string "null" is treated the same as an empty/unresolved base (strict).
if [ -n "$LIVE_BASE_REF" ] && [ "$LIVE_BASE_REF" != "null" ] && [ "$LIVE_BASE_REF" != "main" ]; then IS_DEPLOY_GATE=false; else IS_DEPLOY_GATE=true; fi
```

**Non-`main` base (`IS_DEPLOY_GATE=false` — staging / milestone)** — reconcile to the fast-lane bar. `review-pr.md`'s Phase 8 guard only parks a PR at `workflow:awaiting-merge` after a clean, mergeable `APPROVED` re-review (the same bot-`APPROVED` signal the normal fast lane auto-merges on), so the only additional condition is this remediation's own quality gate:
1. `GATE_PASSED = true` from this remediation's Phase M3 quality-gate loop.

The strict `APPROVED_COUNT >= 2` verified-human requirement does NOT apply here: it is structurally unsatisfiable for bot-only pipeline review (bot reviews are `authorAssociation=NONE`), and `staging` is reversible — the real human gate is `staging → main`, which no agent performs. This makes the remediation bar identical to the normal fast-lane bar for the same target branch (the issue's core ask). The `authorAssociation` trust filter above is **unchanged** — the relaxation is scoped by *target branch only*, never by *who* may approve (forge#1976/#2519).

**`main` base (`IS_DEPLOY_GATE=true` — deploy gate)** — keep the strict #1809 Q1 bar, BOTH conditions required:
1. `APPROVED_COUNT >= 2` — at least two distinct adversarial `APPROVED:` review comments from repo collaborators (`OWNER`/`MEMBER`/`COLLABORATOR` authorAssociation only — see trust filter above; same counting convention as `work-on.md` Phase 7A).
2. `GATE_PASSED = true` from this remediation's own Phase M3 quality-gate loop.

**Evaluate the base-scoped bar**:
```bash
if [ "$IS_DEPLOY_GATE" = "true" ]; then
  # main / deploy gate — strict verified-human bar
  { [ "${APPROVED_COUNT:-0}" -ge 2 ] && [ "${GATE_PASSED:-false}" = "true" ]; } && BAR_MET=true || BAR_MET=false
else
  # staging / milestone — fast-lane bar (bot APPROVED already implied by workflow:awaiting-merge)
  [ "${GATE_PASSED:-false}" = "true" ] && BAR_MET=true || BAR_MET=false
fi
```

**If the bar is met** (`BAR_MET=true`):
```bash
renew_cycle_claim && assert_cycle_claim_owner || {
  echo "BLOCKED: cycle ownership lost before merge"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
gh pr merge {PR_NUMBER} {GH_FLAG} --merge
MERGE_STATE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state --jq '.state')
if [ "$MERGE_STATE" = "MERGED" ]; then
  assert_cycle_claim_owner || {
    echo "BLOCKED: cycle ownership lost before merged-label transition"
    # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
  RESOLUTION=$(resolve_script 'transition-label')
  TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
  case "$TIER" in
    adaptive|universal) bash "$SCRIPT_PATH" {ISSUE_NUMBER} {GH_FLAG} merged ;;
    prose)
      gh issue edit {ISSUE_NUMBER} {GH_FLAG} --add-label "workflow:merged" \
        --remove-label "workflow:awaiting-merge,needs-human,workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:invalid,workflow:decomposed" 2>/dev/null || true
      ;;
  esac
  RE_GATE_OUTCOME="AUTO-LANDED"
else
  RE_GATE_OUTCOME="HELD-AWAITING-MERGE"
  # gh pr merge reported success but the PR isn't actually MERGED — leave workflow:awaiting-merge
  # in place (unchanged) and let a human merge manually rather than retrying automatically.
fi
```

**If the bar is NOT met** (`BAR_MET=false`): leave the issue at `workflow:awaiting-merge` exactly as `review-pr.md`'s guard set it — do NOT attempt a merge. `RE_GATE_OUTCOME="HELD-AWAITING-MERGE"`. Fail-safe direction: any doubt about the bar (including an unresolved or unexpected `LIVE_BASE_REF`, which leaves `IS_DEPLOY_GATE=true`-equivalent strict handling) defaults to holding, matching `review-pr.md`'s own existing default for every other caller.

---

## Phase M8: Finalize FORGE:REMEDIATION Paper Trail

Post the completion body to **both** `{PR_NUMBER}` and `{ISSUE_NUMBER}` — this is the single idempotency marker checked by Phase M0 (this file, on future resume) and by the orchestrator's item 6.4 dispatch guard:

```bash
case "$RE_GATE_OUTCOME" in
  AUTO-LANDED)
    # forge#2570: the bar that was met differs by target branch. Non-`main` (staging/milestone)
    # lands on the fast-lane bar (clean re-review APPROVED + quality-gate pass), identical to the
    # normal /work-on path; `main`/deploy-gate lands only on the strict ≥2 verified-human bar.
    if [ "${IS_DEPLOY_GATE:-true}" = "false" ]; then
      AUTO_LAND_BAR_TEXT="MET — fast-lane bar for non-\`main\` base (clean re-review APPROVED + quality gate pass), matching the normal /work-on merge bar for the same target branch"
    else
      AUTO_LAND_BAR_TEXT="MET (${APPROVED_COUNT:-0} APPROVED: reviews + quality gate pass)"
    fi
    OUTCOME_DETAIL="to {PR_BASE}" ;;
  HELD-AWAITING-MERGE) AUTO_LAND_BAR_TEXT="NOT MET (${APPROVED_COUNT:-0} APPROVED: reviews)"; OUTCOME_DETAIL="at workflow:awaiting-merge" ;;
  RE-ESCALATED)        AUTO_LAND_BAR_TEXT="N/A — re-escalated before the bar was evaluated"; OUTCOME_DETAIL="at needs-human" ;;
  UNFIXABLE)           AUTO_LAND_BAR_TEXT="N/A — unfixable (see Phase M1 classification)"; OUTCOME_DETAIL="at needs-human" ;;
  *)                   AUTO_LAND_BAR_TEXT="N/A"; OUTCOME_DETAIL="" ;;
esac

REMEDIATION_BODY="<!-- FORGE:REMEDIATION -->
## Remediation Complete for PR #{PR_NUMBER}

**Cycle key**: \`${CYCLE_KEY}\`
**Cycle ordinal**: ${REMEDIATION_CYCLE:-1}/${MAX_REMEDIATION_CYCLES:-3}
**Cycle cap exhausted**: ${CAP_EXHAUSTED:-false}
**Cycle attempted**: ${CYCLE_ATTEMPTED:-true}
**Attempted cycle keys**: $(printf '%s' "${ATTEMPTED_CYCLE_KEYS:-$CYCLE_KEY}" | tr '\n' ' ')
**Blocked next cycle key**: ${BLOCKED_NEXT_CYCLE_KEY:-none}
**Findings addressed**: ${#ADDRESSED_FINDING_NUMBERS[@]} (${ADDRESSED_FINDING_NUMBERS[*]:-none})
**Remaining blockers**: ${REMAINING_BLOCKER_FINDING_SET:-none}
**Re-review verdict**: ${RE_REVIEW_VERDICT:-unknown}
**Auto-land bar**: ${AUTO_LAND_BAR_TEXT}
**Re-gate outcome**: ${RE_GATE_OUTCOME} ${OUTCOME_DETAIL}

<!-- FORGE:REMEDIATION:COMPLETE -->"

# An attempted cycle must still own its renewable claim immediately before terminal writes.
# A cap-only receipt (`Cycle attempted: false`) has no claim by design; re-read trusted PR
# receipts and fail closed if another receipt for the blocked key appeared since M0.
if [ "${CYCLE_ATTEMPTED:-true}" = "true" ]; then
  renew_cycle_claim && assert_cycle_claim_owner || {
    echo "BLOCKED: cycle ownership lost before completion receipts"
    # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
else
  CAP_RECEIPTS=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments --paginate --slurp 2>/dev/null \
    | jq --arg key "$CYCLE_KEY" 'def trusted: (.user.type == "Bot") or (.author_association | IN("OWNER","MEMBER","COLLABORATOR")); (add // []) | map(select(trusted)) | [.[] | select(.body | contains("**Cycle key**: `" + $key + "`"))] | length') || {
      echo "BLOCKED: cannot compare cap receipts before terminal write"
      # EXIT REMEDIATE_RESULT: status: BLOCKED
    }
  [ "$CAP_RECEIPTS" -eq 0 ] || {
    echo "BLOCKED: a receipt for the cap-exhausted cycle appeared concurrently"
    # EXIT REMEDIATE_RESULT: status: BLOCKED
  }
fi
gh pr comment {PR_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
# Re-assert between the two durable writes for attempted cycles.
[ "${CYCLE_ATTEMPTED:-true}" != "true" ] || assert_cycle_claim_owner || {
  echo "BLOCKED: cycle ownership lost before issue completion mirror"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
}
gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
```

**If the outcome was `AUTO-LANDED`**: this Skill invocation is itself the caller's terminal delegate (Phase 0A.1 of `work-on.md` already told its own routing loop to STOP after dispatching here) — so `remediate.md` must drive the close phase itself rather than assume some other inline logic will. Invoke the close subcommand directly, the same way `work-on/review.md` does when it hands off from a spawned sub-agent context:

```
assert_cycle_claim_owner or return BLOCKED
Skill("work-on:close", args="{ISSUE_NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --pr {PR_NUMBER} --base {PR_BASE}")
```

`work-on:close` handles project board update, final issue body, parent tracker, trajectory log, and worktree cleanup (including the remediation worktree at `{WORKTREE_PATH}`) — do not duplicate any of that here.

**If the outcome was `HELD-AWAITING-MERGE`, `RE-ESCALATED`, or `UNFIXABLE`**: leave the worktree in place (a human may need it for manual inspection/merge) and return the structured result below without invoking close. Do not close the issue.

---

## Output

Return this structured block to the caller:

```
REMEDIATE_RESULT:
  status: COMPLETE | ALREADY_DONE | UNFIXABLE | BLOCKED
  pr_number: {PR_NUMBER}
  issue_number: {ISSUE_NUMBER}
  re_gate_outcome: AUTO-LANDED | HELD-AWAITING-MERGE | RE-ESCALATED | UNFIXABLE | N/A
  findings_addressed: [{finding_number}, ...]
  blocker: {description if status=BLOCKED}
```

**Caller behavior**: this Skill already drives its own close phase when `re_gate_outcome: AUTO-LANDED` (see Phase M8) — the caller does not need to invoke close itself. For every other `re_gate_outcome`, this result is terminal for the current invocation: the issue is left at `needs-human` or `workflow:awaiting-merge`, both already recognized as terminal states in the Universal Phase Dispatcher (see `work-on.md`). Whether invoked standalone (`/work-on <pr> --remediate`) or via the orchestrator's item 6.4 dispatch, no further action is required from the caller.
