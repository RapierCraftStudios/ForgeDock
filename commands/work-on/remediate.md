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

---

## Inputs

Parse from $ARGUMENTS:
- `{PR_NUMBER}` — PR number to remediate (required, first positional arg). This is the `needs-human`-gated PR itself, NOT the linked issue number.
- `--issue {ISSUE_NUMBER}` — linked issue number (optional). If absent, resolved in Phase M0 from the PR body's `Closes #N` reference.
- `--repo {GH_REPO}` — GitHub repo (resolved from `forge.yaml → project` if omitted)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag
- `--base {PR_BASE}` — PR target branch (optional; resolved from the PR's `baseRefName` if omitted)

---

## Phase M0: Load State & Guard Rails (MANDATORY)

Re-read current state before doing anything:

```bash
PR_STATE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state,headRefName,baseRefName,body,mergeable,mergeStateStatus,url)
PR_OPEN_STATE=$(echo "$PR_STATE" | jq -r '.state')
HEAD_BRANCH=$(echo "$PR_STATE" | jq -r '.headRefName')
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

**Idempotency / resume check** — the paper trail lives on **both** the PR (primary — checked by the orchestrator's item 6.4 dispatch guard) and the linked issue (mirror — keeps `/work-on`'s standard FORGE-annotation trajectory and resume logic consistent with every other phase):

```bash
PR_REMEDIATION_COMMENT=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:REMEDIATION"))] | last')
```

- If a comment is found AND its body contains `FORGE:REMEDIATION:COMPLETE` → EXIT `REMEDIATE_RESULT: status: ALREADY_DONE`. **Single-attempt semantics (AC5)**: once a `FORGE:REMEDIATION:COMPLETE` marker exists for this PR, do NOT re-attempt fixes on a subsequent invocation, regardless of the prior verdict — this is what prevents an infinite remediation retry loop on a genuinely-blocked PR.
- If a comment is found WITHOUT `:COMPLETE` → a prior attempt was interrupted mid-flight (same failure mode as the investigation phase's partial-comment case). Delete the partial comment(s) on both the PR and the issue, then continue below as a fresh attempt:
  ```bash
  gh api repos/{GH_REPO}/issues/comments/{PARTIAL_PR_COMMENT_ID} -X DELETE 2>/dev/null || true
  gh api repos/{GH_REPO}/issues/comments/{PARTIAL_ISSUE_COMMENT_ID} -X DELETE 2>/dev/null || true
  ```
- If no comment is found → fresh attempt, continue below.

---

## Phase M1: Load Prior Findings & Classify the Block Reason

Gather everything that caused (or is still causing) `needs-human`:

**M1a — Open review-finding issues spawned from this PR** (same title-match precedent as `review-pr.md` Phase 8B/9A):
```bash
FINDINGS=$(gh issue list {GH_FLAG} --state open --label "review-finding" --limit 100 \
  --json number,title,body \
  --jq "[.[] | select(.title | test(\"PR #{PR_NUMBER}\"))]")
```

**M1b — PR review verdicts and merge-block reasons** (Phase 8 of `review-pr.md` records the exact block reason on the linked issue when it aborts auto-merge — read that trail rather than re-deriving it):
```bash
BLOCK_COMMENTS=$(gh api repos/{GH_REPO}/issues/{ISSUE_NUMBER}/comments \
  --jq '[.[] | select(.body | test("Auto-merge aborted|not mergeable|Pre-Push Ancestry Guard Failed|Push Failed|Quality Gate Failed"; "i"))] | last')
```

**Classify into FIXABLE vs. UNFIXABLE**:
- **FIXABLE** — open `review-finding` issues (CONFIRMED/LIKELY code defects), a `VERDICT=CHANGES REQUESTED` block with concrete findings attached, a mergeability guard failure (`CONFLICTING`/`DIRTY`/`BLOCKED` — resolvable by rebasing onto `{PR_BASE}`), or a quality-gate/build failure.
- **UNFIXABLE (policy escalation)** — `HAS_PURPOSE_REGRESSION=true` (the PR's behavior diverges from the issue's intent — a judgment call, not a code defect), `CALIBRATION_NEEDS_HUMAN=true` (statistical trust threshold), or `TRUST_NEEDS_HUMAN=true` (provenance `NOVEL_NEEDS_HUMAN` tier, insufficient prior data — a policy gate, not a bug). None of these are mechanically "fixable" by re-editing code.

**If the block reason classifies as UNFIXABLE** (and no FIXABLE item accompanies it): do NOT attempt any fix. Skip directly to Phase M8 with verdict `UNFIXABLE`, re-affirm `needs-human` (it should already be present), and return `REMEDIATE_RESULT: status: UNFIXABLE`. This satisfies AC5 — "genuinely-blocked PRs still terminate at `needs-human`."

**If at least one FIXABLE item exists**: proceed to Phase M2.

---

## Phase M2: Checkout the PR's Existing Branch

Remediation always fixes forward on top of the PR's existing head commit — never rebase onto a different base and never force-push over the PR's history unless a fix genuinely requires it (e.g. resolving a merge conflict per the mergeability guard case, in which case use `git rebase`/`git merge` onto `origin/{PR_BASE}` exactly as the branch's own commit history would, then `--force-with-lease`).

```bash
cd {REPO_PATH}
git fetch origin
WORKTREE_PATH="{WORKTREE_BASE}/remediate-{HEAD_BRANCH_SLUG}-{PR_NUMBER}"
if [ -d "{WORKTREE_PATH}" ]; then
  git -C "{WORKTREE_PATH}" fetch origin
  git -C "{WORKTREE_PATH}" checkout {HEAD_BRANCH}
  git -C "{WORKTREE_PATH}" reset --hard "origin/{HEAD_BRANCH}"
else
  git worktree add "{WORKTREE_PATH}" {HEAD_BRANCH} "origin/{HEAD_BRANCH}"
fi
```

If the worktree/branch checkout fails for any reason (branch deleted, force-pushed out from under us, etc.): post a comment, add `needs-human`, EXIT `REMEDIATE_RESULT: status: BLOCKED`.

---

## Phase M3: Apply Fixes

For each FIXABLE item from Phase M1: read the affected file(s) in `{WORKTREE_PATH}` before editing (never assume current state), apply the fix. Follow the same implementation discipline as `work-on.md` Phase 3F (cross-lane import guard, library-callback verification, deliverable-type consistency, no unrequested scope) — this file does not restate those rules, it inherits them.

**If the block reason was a mergeability conflict** (`CONFLICTING`/`DIRTY`/`BLOCKED`): resolve it by rebasing `{HEAD_BRANCH}` onto `origin/{PR_BASE}` (or merging `{PR_BASE}` in, whichever preserves a clean, reviewable history) — resolve conflicts manually, do not blindly take "ours"/"theirs".

**Quality Gate** (same loop as Phase 3G, max 3 iterations):
```
iteration = 0
while iteration < 3:
    iteration += 1
    Skill("quality-gate", args="{CHANGED_FILES} --worktree {WORKTREE_PATH}")
    if result == "QUALITY GATE: PASS": GATE_PASSED=true; break
    else: fix each HIGH/MEDIUM finding, re-stage
```
If still failing after 3 iterations: post a comment, re-affirm `needs-human`, EXIT `REMEDIATE_RESULT: status: BLOCKED`. Do not proceed to re-review with an unresolved gate failure — that would just re-escalate one phase later with a worse paper trail.

**Format/verify**: run the project's configured `verification.commands` (same as Phase 3H) before committing.

---

## Phase M4: Commit, Push, and Close Addressed Findings

```bash
cd {WORKTREE_PATH}
git add -u
git commit -s -m "fix(remediate): {description} (#{ISSUE_NUMBER})"
git push origin {HEAD_BRANCH}
```

If push fails, retry with `--force-with-lease` (expected when M3 rebased to resolve a conflict). If it still fails: post a comment, add `needs-human`, EXIT `REMEDIATE_RESULT: status: BLOCKED`.

**Close each addressed review-finding issue directly** (this remediation fixes findings in-place on the existing PR, rather than each finding spawning its own downstream `/work-on` pipeline — leaving them open would have a future run rediscover already-fixed code). Track the closed numbers in `ADDRESSED_FINDING_NUMBERS[]` — Phase M8 reports this array in the final paper trail:
```bash
ADDRESSED_FINDING_NUMBERS=()
for FINDING_NUM in {FIXABLE_FINDING_NUMBERS_FROM_M1}; do
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
gh pr comment {PR_NUMBER} {GH_FLAG} --body "<!-- FORGE:REMEDIATION -->
## Remediation In Progress for PR #{PR_NUMBER}

**Findings addressed**:
{bulleted list: finding # — title — one-line fix summary}

**Commit**: {COMMIT_SHA}
**Quality gate**: {iterations} iteration(s), PASS

Re-invoking \`/review-pr --auto-merge\` now."
gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "<!-- FORGE:REMEDIATION -->
## Remediation In Progress for PR #{PR_NUMBER}

**Findings addressed**:
{bulleted list: finding # — title — one-line fix summary}

**Commit**: {COMMIT_SHA}
**Quality gate**: {iterations} iteration(s), PASS

Re-invoking \`/review-pr --auto-merge\` now."
```

Note the marker is `<!-- FORGE:REMEDIATION -->` with **no** `:COMPLETE` suffix yet — per the marker-presence convention (forge#1360/#1357), the absence of `:COMPLETE` correctly signals "in progress" to any concurrent reader, and the M0 resume check above treats this exact state as an interrupted attempt if a session dies before M8.

---

## Phase M6: Re-Invoke /review-pr

```
Skill(skill="review-pr", args="{PR_NUMBER} --auto-merge --issue {ISSUE_NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}")
```

This re-runs the full review (domain agents → verdict → Phase 8 auto-merge gate). Because `{ISSUE_NUMBER}` still carries `needs-human` at this point, one of two things happens inside `review-pr.md`'s existing, **unedited** Phase 8:

- **Re-escalated**: the re-review itself trips a fresh block (`CHANGES REQUESTED`, purpose-regression, calibration, trust, or a still-`CONFLICTING` mergeability check) → `needs-human` remains set, no merge attempted.
- **Clean re-review**: `VERDICT=APPROVED`-equivalent, mergeable, and the "Previously-escalated re-review guard" (forge#1810) fires — clearing `needs-human` and setting `workflow:awaiting-merge`, *without* auto-merging (that guard's own safe default, left untouched by this file).

Extract the re-review verdict for the paper trail (Phase M8 reports this verbatim):
```bash
RE_REVIEW_VERDICT=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | test("APPROVED:|CHANGES REQUESTED:"; "i"))] | last | .body // "unknown"' 2>/dev/null | head -c 200)
```

---

## Phase M7: Compute the #1809 Q1 Auto-Land Bar

Re-read the issue's current labels after M6:
```bash
POST_REVIEW_LABELS=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels --jq '[.labels[].name] | join(",")')
```

**If `needs-human` is present** (re-escalated case): the bar does not apply — nothing to compute. `RE_GATE_OUTCOME="RE-ESCALATED"`. Skip to Phase M8.

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

**Auto-land bar** (per #1809 Q1) — BOTH conditions required:
1. `APPROVED_COUNT >= 2` — at least two distinct adversarial `APPROVED:` review comments from repo collaborators (`OWNER`/`MEMBER`/`COLLABORATOR` authorAssociation only — see trust filter above; same counting convention as `work-on.md` Phase 7A).
2. `GATE_PASSED = true` from this remediation's own Phase M3 quality-gate loop.

**If the bar is met**:
```bash
gh pr merge {PR_NUMBER} {GH_FLAG} --merge
MERGE_STATE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state --jq '.state')
if [ "$MERGE_STATE" = "MERGED" ]; then
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

**If the bar is NOT met**: leave the issue at `workflow:awaiting-merge` exactly as `review-pr.md`'s guard set it — do NOT attempt a merge. `RE_GATE_OUTCOME="HELD-AWAITING-MERGE"`. Fail-safe direction: any doubt about the bar defaults to holding, matching `review-pr.md`'s own existing default for every other caller.

---

## Phase M8: Finalize FORGE:REMEDIATION Paper Trail

Post the completion body to **both** `{PR_NUMBER}` and `{ISSUE_NUMBER}` — this is the single idempotency marker checked by Phase M0 (this file, on future resume) and by the orchestrator's item 6.4 dispatch guard:

```bash
case "$RE_GATE_OUTCOME" in
  AUTO-LANDED)         AUTO_LAND_BAR_TEXT="MET (${APPROVED_COUNT:-0} APPROVED: reviews + quality gate pass)"; OUTCOME_DETAIL="to {PR_BASE}" ;;
  HELD-AWAITING-MERGE) AUTO_LAND_BAR_TEXT="NOT MET (${APPROVED_COUNT:-0} APPROVED: reviews)"; OUTCOME_DETAIL="at workflow:awaiting-merge" ;;
  RE-ESCALATED)        AUTO_LAND_BAR_TEXT="N/A — re-escalated before the bar was evaluated"; OUTCOME_DETAIL="at needs-human" ;;
  UNFIXABLE)           AUTO_LAND_BAR_TEXT="N/A — unfixable (see Phase M1 classification)"; OUTCOME_DETAIL="at needs-human" ;;
  *)                   AUTO_LAND_BAR_TEXT="N/A"; OUTCOME_DETAIL="" ;;
esac

REMEDIATION_BODY="<!-- FORGE:REMEDIATION -->
## Remediation Complete for PR #{PR_NUMBER}

**Findings addressed**: ${#ADDRESSED_FINDING_NUMBERS[@]} (${ADDRESSED_FINDING_NUMBERS[*]:-none})
**Re-review verdict**: ${RE_REVIEW_VERDICT:-unknown}
**Auto-land bar**: ${AUTO_LAND_BAR_TEXT}
**Re-gate outcome**: ${RE_GATE_OUTCOME} ${OUTCOME_DETAIL}

<!-- FORGE:REMEDIATION:COMPLETE -->"

gh pr comment {PR_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
```

**If the outcome was `AUTO-LANDED`**: this Skill invocation is itself the caller's terminal delegate (Phase 0A.1 of `work-on.md` already told its own routing loop to STOP after dispatching here) — so `remediate.md` must drive the close phase itself rather than assume some other inline logic will. Invoke the close subcommand directly, the same way `work-on/review.md` does when it hands off from a spawned sub-agent context:

```
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
