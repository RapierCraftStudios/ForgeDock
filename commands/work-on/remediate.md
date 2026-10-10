---
user-invocable: false
description: Remediate subcommand — checkout a needs-human or workflow:remediating PR, fix review findings, re-review, and re-gate with a FORGE:REMEDIATION paper trail
argument-hint: "[PR number] [--issue N] [--repo GH_REPO] [--gh-flag GH_FLAG] [--base PR_BASE]"
context: fork
background: false
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/remediate — Remediation Subcommand

> **Skill Name Resolution (forked phase)**: `{FORGE_SKILL_PREFIX}` is the namespace this skill itself was invoked under — invoked as `forgedock:work-on:…` → `forgedock:` (nesting `:`); as `work-on:…` → empty (`install.sh`); as `forge-work-on-…` → `forge-` (Codex, nesting `-`); OpenCode → empty with `-` nesting. Confirm the target name in the available-skills list before calling it. A forked phase receives no resolved value from its caller; never guess, and if the target skill is not listed return BLOCKED "skill not found: <name>".

**Input**: $ARGUMENTS

> **Transient GitHub failures** (field test: a 12-minute GitHub HTTP 500 window parked an issue at needs-human): retry any `gh` call that fails with HTTP 5xx, a timeout or "Something went wrong" up to 3 times with 10s/30s/60s backoff. If it still fails, do NOT add `needs-human` — print this phase's RESULT block with `status: BLOCKED` and a blocker that starts with `github-unavailable:`. The router retries the phase; every phase resumes from GitHub state, so a retry is safe.


**Invoked by**:
- `work-on.md` Phase 0A.1 (router), standalone: `/work-on <pr> --remediate` (see forge#1813).
- `commands/orchestrate/phase-4-execution.md` item 6.4, auto-dispatched against a `needs-human`-gated or `workflow:remediating` predecessor's own open PR.
- `work-on.md` Phase 4R (router), when the review phase hands off a red CI gate or an in-PR fix request (`REVIEW_RESULT: status: NEXT`).

**Only the router invokes this skill** (forge#3398, `work-on.md` Hard Rule 1a). It re-reviews through `/review-pr`, which spawns domain reviewers, so it must run one level below the router. No phase may invoke it from inside its own fork.

**Output**: Checkout the PR's existing branch → classify the block reason (fixable vs. policy escalation) → apply fixes → quality-gate → commit/push → re-invoke `/review-pr --auto-merge` → compute the #1809 Q1 auto-land bar → merge-if-verified or hold at `workflow:awaiting-merge` → emit a `FORGE:REMEDIATION` paper trail. Return result to caller.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

**Scope note**: This mode owns exactly one gap — re-driving a `needs-human` or `workflow:remediating` PR's own remediation (the latter is the non-human "autonomous remediation pending" state review sets for ci-gate, in-pr-fix and base-sync handoffs, forge#3541). It does NOT implement the `needs-human` sub-label taxonomy (#1815's scope) and it does NOT edit `review-pr.md`'s Phase 8 guard (forge#1810) — that guard's existing safe-default (`workflow:awaiting-merge` on any clean re-review of a previously-escalated PR) is reused as-is; this file only adds a bar-check *after* that guard has already fired.

**Engine coverage** (forge#2379, #2889): this subcommand's `command` name (`work-on/remediate`) and completion marker (`FORGE:REMEDIATION:COMPLETE`, including the `**Re-gate outcome**` field Phase M8 posts below) are registered in the headless engine's phase table — `RESERVED_TYPES.REMEDIATION` in `packages/protocol/src/types.js`, `remediate` in `packages/protocol/src/phases.js`'s `PHASE_IDS`/`PHASE_MARKERS`, and a matching `remediate` entry in `bin/engine/phases.mjs`'s `PHASES` array. A blocked review is committed with `terminalReason: "needs-human"`, then the engine continues directly into remediation; the divergence guard permits this specific handoff while keeping all other `needs-human` states paused.

---

## Inputs

Parse from $ARGUMENTS:
- `{PR_NUMBER}` — PR number to remediate (required, first positional arg). This is the `needs-human`-gated or `workflow:remediating` PR itself, NOT the linked issue number.
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

- If neither `needs-human` nor `workflow:remediating` is among `ISSUE_LABELS` → EXIT `REMEDIATE_RESULT: status: BLOCKED`, blocker: "issue #{ISSUE_NUMBER} is neither `needs-human` nor `workflow:remediating` — remediation mode only targets PRs in one of those two states; use the normal `/work-on {ISSUE_NUMBER}` resume path instead." This keeps blast radius scoped to exactly the gap this mode fills — it is not a general-purpose re-review trigger. `workflow:remediating` is the non-human state review sets when it hands an autonomous ci-gate / in-pr-fix / base-sync fix to this phase (forge#3541); a bare `needs-human` (older runs, genuine escalations being re-driven) is still accepted. <!-- Added: forge#3541 -->
- **Stranded-state rule**: `workflow:remediating` must never outlive this run. Every exit that returns `BLOCKED` or `UNFIXABLE` (including exits before Phase M1) removes `workflow:remediating` and adds `needs-human`, because at that point a human really is needed:

  ```bash
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} --add-label "needs-human" --remove-label "workflow:remediating" 2>/dev/null || true # allowlist:check-command-side-effects
  ```

**Idempotency / resume check** — the paper trail lives on **both** the PR (primary — checked by the orchestrator's item 6.4 dispatch guard) and the linked issue (mirror — keeps `/work-on`'s standard FORGE-annotation trajectory and resume logic consistent with every other phase):

```bash
# Trust predicate: ONE shared copy (scripts/trusted-comments.sh). Markers are matched as the comment's LEADING
# text (^ anchors at the start of the body, not of a line), never with a bare contains(): a review comment or
# an INPR_FIX work order that merely QUOTES FORGE:REMEDIATION:COMPLETE must not read as a remediation trail (forge#3412).
# TRUSTED_SCRIPT resolver (canonical; byte-identical across specs, guarded by scripts/forge-root.test.sh): plugin root, FORGE_ROOT, FORGEDOCK_HOME, FORGE_HOME, install symlink, marketplaces, newest pinned plugin cache under CLAUDE_CONFIG_DIR then ~/.claude. Never the working directory (author-controlled, #3400). The cache scan matters because the plugin-root placeholder is not always substituted in forked runs.
_l="$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null || true)"; _l="${_l%/commands/work-on.md}"
_tc="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGEDOCK_HOME:-}" "${FORGE_HOME:-}" "$_l" "$HOME/.claude/plugins/marketplaces/forgedock")"
for _cfg in "${CLAUDE_CONFIG_DIR:-}" "$HOME/.claude"; do
  [ -n "$_cfg" ] && _tc="$_tc"$'\n'"$(find -L "$_cfg/plugins/cache/forgedock/forgedock" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | awk -F/ '$NF ~ /^[0-9]+\.[0-9]+\.[0-9]+$/{split($NF,a,".");printf "%d %d %d %s\n",a[1],a[2],a[3],$(0)}' | sort -k1,1nr -k2,2nr -k3,3nr | cut -d' ' -f4- || true)"
done
TRUSTED_SCRIPT=""
while IFS= read -r _c; do
  case "$_c" in /*) [ -z "$TRUSTED_SCRIPT" ] && [ -f "$_c/scripts/trusted-comments.sh" ] && TRUSTED_SCRIPT="$_c/scripts/trusted-comments.sh" ;; esac
done <<< "$_tc"
PR_COMMENTS=$(gh api --paginate repos/{GH_REPO}/issues/{PR_NUMBER}/comments 2>/dev/null) || PR_COMMENTS=""
if [ -n "$TRUSTED_SCRIPT" ] && [ -n "$PR_COMMENTS" ]; then
  # Real trail comments (M5 interim, M8 final) START with <!-- FORGE:REMEDIATION -->; M8 also carries <!-- FORGE:REMEDIATION:COMPLETE -->.
  REMEDIATION_COMPLETE_N=$(printf '%s' "$PR_COMMENTS" | bash "$TRUSTED_SCRIPT" count '^<!-- FORGE:REMEDIATION -->[\s\S]*<!-- FORGE:REMEDIATION:COMPLETE -->' 2>/dev/null || echo "")
  REMEDIATION_TRAIL_N=$(printf '%s' "$PR_COMMENTS" | bash "$TRUSTED_SCRIPT" count '^<!-- FORGE:REMEDIATION -->' 2>/dev/null || echo "")
else
  REMEDIATION_COMPLETE_N=""; REMEDIATION_TRAIL_N=""
fi
# Partial (interim, no COMPLETE) comment ids for cleanup: anchored leading marker, no COMPLETE marker, same bot/association trust.
PARTIAL_PR_COMMENT_IDS=$(printf '%s' "$PR_COMMENTS" | jq -rs '[.[][] | select((.body // "") | startswith("<!-- FORGE:REMEDIATION -->")) | select((.body | contains("<!-- FORGE:REMEDIATION:COMPLETE -->")) | not) | select((.user.type // "") == "Bot" or ((.author_association // "") | IN("OWNER","MEMBER","COLLABORATOR"))) | .id] | .[]' 2>/dev/null || true)
```

**Per-kind scoping of the single-attempt guard** (forge#3496): the guard is scoped per remediation kind so a base-sync round is not swallowed by an earlier `ci-gate` / `inpr-fix` remediation on the same PR. A base-sync handoff is recognised by the router's `FORGE:BASESYNC_REMEDIATION: pr={PR_NUMBER}` bound marker on the issue (the router posts it immediately before invoking this phase); a completed base-sync round is recognised by a `FORGE:REMEDIATION:COMPLETE` trail carrying the `**Base sync**: ran` line that Phase M8 posts. The base-sync round is itself bounded to one, by that marker count in `work-on/review.md` R4 and by this check:

```bash
if [ -n "$TRUSTED_SCRIPT" ] && [ -n "$PR_COMMENTS" ]; then
  BASESYNC_DONE_N=$(printf '%s' "$PR_COMMENTS" | bash "$TRUSTED_SCRIPT" count '^<!-- FORGE:REMEDIATION -->[\s\S]*\*\*Base sync\*\*: ran[\s\S]*<!-- FORGE:REMEDIATION:COMPLETE -->' 2>/dev/null || echo "")
  ISSUE_COMMENTS=$(gh api --paginate repos/{GH_REPO}/issues/{ISSUE_NUMBER}/comments 2>/dev/null) || ISSUE_COMMENTS=""
  BASESYNC_BOUND_N=$(printf '%s' "$ISSUE_COMMENTS" | bash "$TRUSTED_SCRIPT" count '^<!-- FORGE:BASESYNC_REMEDIATION: pr={PR_NUMBER} -->' 2>/dev/null || echo "")
  # A base-sync handoff (bound marker present) with no completed base-sync round yet is a fresh attempt for ITS kind,
  # whatever earlier ci-gate / inpr-fix trails exist. Fail closed: an unreadable count keeps the kind-agnostic guard.
  if [ -n "$BASESYNC_DONE_N" ] && [ -n "$BASESYNC_BOUND_N" ] && [ "$BASESYNC_BOUND_N" -ge 1 ] && [ "$BASESYNC_DONE_N" -eq 0 ]; then REMEDIATION_COMPLETE_N=0; fi
fi
```

Completed trails of other kinds are left in place (never deleted); only the interrupted-partial cleanup below deletes anything.

- If `REMEDIATION_COMPLETE_N` or `REMEDIATION_TRAIL_N` is empty (comments or `scripts/trusted-comments.sh` unreadable or unresolvable) → fail closed: EXIT `REMEDIATE_RESULT: status: BLOCKED`, blocker: "github-unavailable: remediation trail unreadable (comments or scripts/trusted-comments.sh unresolvable)". Never treat unreadable as "no trail" and never as `ALREADY_DONE`.
- If `REMEDIATION_COMPLETE_N` is at least 1 (a trusted comment that starts with `<!-- FORGE:REMEDIATION -->` and contains `<!-- FORGE:REMEDIATION:COMPLETE -->`) → EXIT `REMEDIATE_RESULT: status: ALREADY_DONE`. **Single-attempt semantics (AC5)**: once a genuine `FORGE:REMEDIATION:COMPLETE` trail comment exists for this PR, do NOT re-attempt fixes on a subsequent invocation, regardless of the prior verdict — this is what prevents an infinite remediation retry loop on a genuinely-blocked PR. A comment that only quotes the marker mid-body (review findings, an `INPR_FIX` work order, a disposition record) or comes from an untrusted author never counts.
- If `REMEDIATION_COMPLETE_N` is 0 and `REMEDIATION_TRAIL_N` is at least 1 → a prior attempt was interrupted mid-flight (same failure mode as the investigation phase's partial-comment case). Delete the partial comment(s) on both the PR and the issue (ids from `PARTIAL_PR_COMMENT_IDS` above and the same anchored filter over the issue's comments), then continue below as a fresh attempt:
  ```bash
  for _id in $PARTIAL_PR_COMMENT_IDS; do gh api repos/{GH_REPO}/issues/comments/$_id -X DELETE 2>/dev/null || true; done
  ISSUE_PARTIAL_IDS=$(gh api --paginate repos/{GH_REPO}/issues/{ISSUE_NUMBER}/comments 2>/dev/null | jq -rs '[.[][] | select((.body // "") | startswith("<!-- FORGE:REMEDIATION -->")) | select((.body | contains("<!-- FORGE:REMEDIATION:COMPLETE -->")) | not) | select((.user.type // "") == "Bot" or ((.author_association // "") | IN("OWNER","MEMBER","COLLABORATOR"))) | .id] | .[]' 2>/dev/null || true)
  for _id in $ISSUE_PARTIAL_IDS; do gh api repos/{GH_REPO}/issues/comments/$_id -X DELETE 2>/dev/null || true; done
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
- **FIXABLE** — open `review-finding` issues (CONFIRMED/LIKELY code defects), a `VERDICT=CHANGES REQUESTED` block with concrete findings attached, a base conflict (`base-conflict`: `CONFLICTING`/`DIRTY`, or `BEHIND` under required-up-to-date protection — resolvable by merging `origin/{PR_BASE}` in, the base-sync step in Phase M3; `BLOCKED` alone is branch protection that a sync cannot clear and is UNFIXABLE unless a conflict state is also present), a quality-gate/build failure, or a CI-gate refusal (`ci gate not green` — the failing/cancelled/timed-out checks are listed on the linked issue; read each failing job's log with `gh run view --log-failed`, fix the cause on the PR branch, or re-run a check that failed for an infrastructure reason), or an in-PR fix request (`in-pr fix required` — review-pr §6B.6 posted a `<!-- FORGE:INPR_FIX: round=1 head=<sha> findings=<ids> -->` comment on the PR listing CONFIRMED MEDIUM findings in files this PR changed. That comment is the work order: fix exactly the listed findings, at the listed `file:line`, and nothing else. Do not file them as issues; the re-review in Phase M6 files any that remain).
- **UNFIXABLE (policy escalation)** — `HAS_PURPOSE_REGRESSION=true` (the PR's behavior diverges from the issue's intent — a judgment call, not a code defect), `CALIBRATION_NEEDS_HUMAN=true` (statistical trust threshold), or `TRUST_NEEDS_HUMAN=true` (provenance `NOVEL_NEEDS_HUMAN` tier, insufficient prior data — a policy gate, not a bug). None of these are mechanically "fixable" by re-editing code.

**If the block reason classifies as UNFIXABLE** (and no FIXABLE item accompanies it): do NOT attempt any fix. Skip directly to Phase M8 with verdict `UNFIXABLE`, re-affirm `needs-human` (add it and remove `workflow:remediating` if the issue entered as `workflow:remediating`), and return `REMEDIATE_RESULT: status: UNFIXABLE`. This satisfies AC5 — "genuinely-blocked PRs still terminate at `needs-human`."

**If at least one FIXABLE item exists**: transition the issue out of its terminal gate before proceeding to Phase M2. `needs-human` (or the `workflow:remediating` handoff state) represents the prior review result, not an active automated remediation run; retaining it would make the dispatcher and recovery paths stop while remediation is in progress. Keep exactly one active workflow state:

```bash
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "DRY_RUN: would replace needs-human / workflow:remediating with workflow:in-review on issue #{ISSUE_NUMBER}"
else
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} \
    --add-label "workflow:in-review" \
    --remove-label "needs-human,workflow:remediating" 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
fi
```

Do not perform this transition for an UNFIXABLE policy escalation. Any later quality-gate, push, or re-review block re-adds `needs-human`; after re-review, remove `workflow:in-review` whenever that terminal label is present.

---

## Phase M2: Checkout the PR's Existing Branch

Remediation always fixes forward on top of the PR's existing head commit — never rebase and never force-push. The only history-affecting operation permitted is the base sync (`git merge origin/{PR_BASE}`, Phase M3), which adds a merge commit and pushes with a plain `git push`.

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

For each FIXABLE item from Phase M1: read the affected file(s) in `{WORKTREE_PATH}` before editing (never assume current state), apply the fix. Follow the same implementation discipline as `work-on/build/implement.md` I3 (cross-lane import guard, library-callback verification, deliverable-type consistency, no unrequested scope) — this file does not restate those rules, it inherits them.

**Never delete, skip, or weaken a failing check to go green.** Removing, skipping (`skip`, `xfail`, `continue-on-error`, `if: false`, commenting out) or weakening a failing test or CI step is never a valid fix. Fix the cause in the code under test, or classify the item UNFIXABLE, add/re-affirm `needs-human`, and post a comment that names the failing tests and failing assertions (test title plus assertion text from the CI log). The only exception is a deletion justified by removal of the tested code itself (see quality-gate 2U). Enforcement is the quality gate's coverage-reduction check (2U): a `COVERAGE-1` finding is fixed by restoring the test or step, never by suppressing the finding. <!-- Added: forge#3257 -->

**Base-sync (merge-only)** <!-- Added: forge#3496 -->: runs when the block reason was a base conflict (`base-conflict`, or `CONFLICTING`/`DIRTY`, or `BEHIND` under required-up-to-date protection). This step is authorized by the operator's batch dispatch and by the router's `FORGE:BASESYNC_REMEDIATION` bound; it applies to the PR's own branch in `{WORKTREE_PATH}` only. Never rebase, never force-push, never merge into or push to a shared branch.

```bash
cd {WORKTREE_PATH}
CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD)
case "{HEAD_BRANCH}" in
  "{PR_BASE}"|main|master|staging|milestone/*) echo "refusing base sync: {HEAD_BRANCH} is a shared branch"; BASESYNC_REFUSED=true ;;
esac
[ "$CUR_BRANCH" = "{HEAD_BRANCH}" ] || BASESYNC_REFUSED=true
if [ "${BASESYNC_REFUSED:-false}" != "true" ]; then
  git fetch origin {PR_BASE} # allowlist:check-command-side-effects
  git merge origin/{PR_BASE} --no-edit # allowlist:check-command-side-effects
  BASESYNC_RAN=true
fi
```

- Clean merge: nothing more to resolve; the merge commit is the sync.
- Conflicts: read BOTH sides of every conflicted hunk and the surrounding code, then write the combined result by hand. No `-X ours`/`-X theirs`, no wholesale `git checkout --ours/--theirs`, no blanket take-one-side. After resolving, `git add` the files and conclude with `git commit -s --no-edit` (the merge commit).
- **Unresolvable with confidence** (a hunk whose intent on either side you cannot reconcile, or the branch is refused above): capture the file list first, then abort, and park:
  ```bash
  run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
  CONFLICT_FILES=$(git diff --name-only --diff-filter=U)
  git merge --abort # allowlist:check-command-side-effects
  run gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "<!-- FORGE:BASESYNC_FAILED -->
  Base sync of PR #{PR_NUMBER} (\`origin/{PR_BASE}\` into \`{HEAD_BRANCH}\`) could not be resolved with confidence. Conflicting files:

  \`\`\`
  ${CONFLICT_FILES}
  \`\`\`" # allowlist:check-command-side-effects
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} --add-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
  ```
  EXIT `REMEDIATE_RESULT: status: BLOCKED` with blocker "base-sync: unresolvable conflicts". Only that issue is parked.
- After a sync, the quality gate below re-runs on the merged tree, and Phase M6's re-review covers the new head (the reviewed-head guard forces a fresh review).

**Quality Gate** (same loop as Phase 3G, max 3 iterations):
```
iteration = 0
while iteration < 3:
    iteration += 1
    Skill("{FORGE_SKILL_PREFIX}quality-gate", args="{CHANGED_FILES} --worktree {WORKTREE_PATH}")
    if result == "QUALITY GATE: PASS": GATE_PASSED=true; break
    else: fix each HIGH/MEDIUM finding, re-stage
```
If still failing after 3 iterations: post a comment, re-affirm `needs-human`, EXIT `REMEDIATE_RESULT: status: BLOCKED`. Do not proceed to re-review with an unresolved gate failure — that would just re-escalate one phase later with a worse paper trail.

**Format/verify**: run the project's configured `verification.commands` (same as Phase 3H) before committing.

---

## Phase M4: Commit, Push, and Close Addressed Findings

**Pre-push ancestry guard** (same guard as `work-on/review.md` Phase R1; reuse it, do not write a parallel check): a base-sync merge of `origin/{PR_BASE}` passes it, a merge that brings in history from outside the base fails it.

```bash
# <Script resolution block from work-on/review.md, verbatim>
cd {WORKTREE_PATH}
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
git fetch origin {PR_BASE} >/dev/null 2>&1 || true
RESOLUTION=$(resolve_script 'check-branch-ancestry'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
if [ "$TIER" = "prose" ]; then
  MERGE_COMMITS="check-branch-ancestry script not resolvable (fail closed)"; ANCESTRY_RC=2
else
  MERGE_COMMITS=$(bash "$SCRIPT_PATH" {HEAD_BRANCH} origin/{PR_BASE} 2>&1); ANCESTRY_RC=$?
fi
if [ "$ANCESTRY_RC" -ne 0 ]; then
  run gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "## Pre-Push Ancestry Guard Failed

Branch \`{HEAD_BRANCH}\` has merge commits from outside \`{PR_BASE}\`, or ancestry could not be verified (rc=${ANCESTRY_RC}). Not pushing.

\`\`\`
${MERGE_COMMITS}
\`\`\`" # allowlist:check-command-side-effects
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} --add-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
  # EXIT REMEDIATE_RESULT: status: BLOCKED (blocker: pre-push ancestry guard failed) - do not push
fi
```

Then commit and push. A base-sync merge commit already exists from Phase M3; commit only additional quality-gate or fix edits on top.

```bash
cd {WORKTREE_PATH}
git add -u
git diff --cached --quiet || git commit -s -m "fix(remediate): {description} (#{ISSUE_NUMBER})"
git push origin {HEAD_BRANCH} # allowlist:check-command-side-effects
```

If the push fails, do NOT retry with a force flag (never force-push): post a comment, add `needs-human`, EXIT `REMEDIATE_RESULT: status: BLOCKED`. A raced remote is resolved by a re-run, which fetches and merges naturally.

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

**Dispatch-tool probe (forge#3240 — run FIRST)**: `review-pr` must launch its domain review agents through a sub-agent dispatch tool and refuses to review inline. This only fails when remediation was invoked deeper than the router allows (see `docs/WORK-ON-RUNTIME.md`); invoked from the router, a dispatch tool is available, so the branch below is a safety net. Resolve the tool with the identical order `commands/review-pr.md` § "Sub-Agent Dispatch Tool Resolution" uses (`Task`, then `Agent`; OpenCode uses `task`). Do not copy or weaken that section, and never review inline here.

If no dispatch tool resolves, a missing tool is not a human decision, so do NOT invoke `review-pr`, do NOT add `needs-human`, and leave `workflow:in-review` in place. Set `RE_GATE_OUTCOME="REREVIEW-REQUIRED"`, skip Phase M7, go to Phase M8 (which posts `FORGE:REMEDIATION:COMPLETE` with a `REREVIEW-REQUIRED` re-gate line), and return `REMEDIATE_RESULT: status: REREVIEW_REQUIRED`. The caller re-runs `/review-pr {PR_NUMBER} --auto-merge --issue {ISSUE_NUMBER} --base {PR_BASE}` from a session that has dispatch. The caller owns the terminal fallback if that re-review cannot run (`commands/work-on.md` Phase 0A.1); remediation itself stays single-attempt and adds no `needs-human` here. If a dispatch tool resolves, continue below.

```
if DRY_RUN=true:
  record "Would invoke review-pr --auto-merge for PR #{PR_NUMBER}; skipped (dry-run)."
else:
  Skill(skill="{FORGE_SKILL_PREFIX}review-pr", args="{PR_NUMBER} --auto-merge --issue {ISSUE_NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}")
```

**Reviewer ownership (spawn-site rule, `docs/WORK-ON-RUNTIME.md` R6)**: `/review-pr` runs inline in this fork. Under async `Agent` dispatch its domain reviewers are attributed to the root session, so their completion notifications never reach this phase: do not end the turn to wait for them. `/review-pr` Phase 4 waits on the reviewers' current-SHA `FORGE:REVIEW-AGENT` PR comments (bounded), and that GitHub comment, not a notification, is the completion signal. If the call returns with no parseable `REVIEW_RESULT` (empty, running or backgrounded), first re-read the PR and issue: a complete current-SHA reviewer panel plus a `FORGE:REVIEW` verdict means consume that state; otherwise re-invoke `/review-pr` once more with the same args (idempotent: it reuses the current-SHA reviewer comments already posted and dispatches only missing domains). Never review inline.

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

If the retained `REVIEW_RESULT` is `PHASE_TRAIL_FAILED` (forge#3102): the gate refused to merge on missing phase markers, not on a code finding. Re-run each missing phase named on the `MISSING:` lines via its `Skill(...)`, then re-invoke this phase once. If it is `PHASE_TRAIL_FAILED` again, keep `needs-human`, post `<!-- FORGE:PHASE_TRAIL_FAILED -->` listing the still-missing markers, and exit `REMEDIATE_RESULT: status: BLOCKED`. Never treat it as `HELD-AWAITING-MERGE` or `AUTO-LANDED`. A still-failing trail can also be cleared by a human `<!-- FORGE:PHASE_TRAIL_OVERRIDE -->` comment (forge#3152, see `scripts/verify-phase-trail.sh -h`); the verifier decides, this phase never posts one.

If the retained `REVIEW_RESULT` is `BLOCKED` with a blocker mentioning the phase trail (e.g. "phase trail unreadable (rc=N)": the Phase 8 verifier exited ≥2 / 127, forge#3147): the gate could not run, so nothing is missing and nothing is re-run. Keep `needs-human` (review-pr Phase 8 already re-asserted it), do not merge, and exit `REMEDIATE_RESULT: status: BLOCKED` with the same blocker.

If the retained `REVIEW_RESULT` is `BLOCKED` with blocker "base-conflict" (forge#3496): the base moved again, or the sync did not clear the conflict. Treat it as re-escalated: the `BASESYNC_REMEDIATION` bound is already used, so do NOT sync a second time. Add `needs-human`, post a comment naming the PR and the conflicting files (`git diff --name-only --diff-filter=U` against a trial merge, or the GitHub mergeability report), and exit `REMEDIATE_RESULT: status: BLOCKED` with blocker "base conflict persists after base-sync remediation".

This re-runs the full review (domain agents → verdict → Phase 8 auto-merge gate). The FIXABLE transition above left the issue at the non-terminal `workflow:in-review` state. `review-pr.md` recognizes the in-progress `FORGE:REMEDIATION` marker posted in Phase M5 as evidence of the prior escalation, so one of two things happens inside Phase 8:

- **Re-escalated**: the re-review itself trips a fresh block (`CHANGES REQUESTED`, purpose-regression, calibration, trust, or a still-`CONFLICTING` mergeability check) → it adds `needs-human`, and this phase removes `workflow:in-review`, leaving one terminal state.
- **Clean re-review**: `VERDICT=APPROVED`-equivalent, mergeable, and the "Previously-escalated re-review guard" (forge#1810) fires — setting `workflow:awaiting-merge` and removing `workflow:in-review`, *without* auto-merging (that guard's own safe default, left untouched by this file).

```bash
POST_REVIEW_LABELS=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels --jq '[.labels[].name] | join(",")')
if echo "$POST_REVIEW_LABELS" | grep -qE '(^|,)needs-human(,|$)'; then
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} --remove-label "workflow:in-review" 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
fi
```

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

**If `RE_GATE_OUTCOME="REREVIEW-REQUIRED"`** (forge#3240, set in M6): the bar does not apply — no review ran. Skip to Phase M8.

**If `needs-human` is present** (re-escalated case): the bar does not apply — nothing to compute. `RE_GATE_OUTCOME="RE-ESCALATED"`. Skip to Phase M8.

**If `workflow:awaiting-merge` is present** (clean re-review case — the only branch where `review-pr.md`'s guard has already safely parked this PR): compute the bar.

```bash
# Trust filter: only reviews/comments from repo collaborators (OWNER/MEMBER/COLLABORATOR
# authorAssociation) can contribute to the auto-land bar. Unlike work-on/close.md's
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
1. `APPROVED_COUNT >= 2` — at least two distinct adversarial `APPROVED:` review comments from repo collaborators (`OWNER`/`MEMBER`/`COLLABORATOR` authorAssociation only — see trust filter above; same counting convention as `work-on/close.md` C4).
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
# CI gate (MANDATORY before any autonomous merge): merge only when every check on the PR is
# green. Field test: PRs merged to staging with checks pending or red (#3165), because branch
# protection required none and an auto-merge waits only for *required* checks.
CI_GATE_SCRIPT=""
_l="$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null || true)"; _l="${_l%/commands/work-on.md}"
for _c in '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGEDOCK_HOME:-}" "${FORGE_HOME:-}" "$_l"; do
  case "$_c" in /*) [ -z "$CI_GATE_SCRIPT" ] && [ -f "$_c/scripts/wait-ci-green.sh" ] && CI_GATE_SCRIPT="$_c/scripts/wait-ci-green.sh" ;; esac
done
if [ -n "$CI_GATE_SCRIPT" ]; then CI_GATE_OUT=$(bash "$CI_GATE_SCRIPT" {PR_NUMBER} {GH_FLAG}); CI_GATE_RC=$?
else CI_GATE_OUT="CI_GATE: ERROR — scripts/wait-ci-green.sh not resolvable (fail closed)"; CI_GATE_RC=2; fi
echo "$CI_GATE_OUT"
GATED_HEAD=$(printf '%s\n' "$CI_GATE_OUT" | sed -n 's/^CI_GATE_HEAD: //p' | head -1)
# rc 3 = CI still running: re-run this block (up to 3 more times) before treating it as a failure.
if [ "$CI_GATE_RC" -ne 0 ]; then
  # Not green: do not land. Re-escalate with the gate output (counts as RE-ESCALATED below).
  CI_MSG="⛔ Remediation auto-land refused for PR #{PR_NUMBER}: CI is not green (rc=${CI_GATE_RC}).
\`\`\`
${CI_GATE_OUT}
\`\`\`"
  gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "$CI_MSG" 2>/dev/null || true # allowlist:check-command-side-effects
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} --add-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
else
gh pr merge {PR_NUMBER} {GH_FLAG} --merge --match-head-commit "$GATED_HEAD" # allowlist:check-command-side-effects (CI-gated merge)
fi
MERGE_STATE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state --jq '.state')
if [ "$MERGE_STATE" = "MERGED" ]; then
  RESOLUTION=$(resolve_script 'transition-label')
  TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
  case "$TIER" in
    adaptive|universal) bash "$SCRIPT_PATH" {ISSUE_NUMBER} {GH_FLAG} merged ;;
    prose)
      gh issue edit {ISSUE_NUMBER} {GH_FLAG} --add-label "workflow:merged" \
        --remove-label "workflow:awaiting-merge,needs-human,workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:remediating,workflow:invalid,workflow:decomposed" 2>/dev/null || true # allowlist:check-command-side-effects
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
  REREVIEW-REQUIRED)   AUTO_LAND_BAR_TEXT="N/A — re-review not run (no sub-agent dispatch tool in this session)"; OUTCOME_DETAIL="at workflow:in-review, re-review required from a session with dispatch" ;;
  *)                   AUTO_LAND_BAR_TEXT="N/A"; OUTCOME_DETAIL="" ;;
esac

# forge#3413: embed the pushed head so the orchestrator scopes a REREVIEW-REQUIRED trail to the CURRENT head only.
REMEDIATED_HEAD_SHA=$(gh pr view {PR_NUMBER} {GH_FLAG} --json headRefOid --jq '.headRefOid' 2>/dev/null || true)

# forge#3496: mark a base-sync round so Phase M0 scopes the single-attempt guard per kind.
BASESYNC_LINE=""; [ "${BASESYNC_RAN:-false}" = "true" ] && BASESYNC_LINE="**Base sync**: ran"

REMEDIATION_BODY="<!-- FORGE:REMEDIATION -->
## Remediation Complete for PR #{PR_NUMBER}

**Findings addressed**: ${#ADDRESSED_FINDING_NUMBERS[@]} (${ADDRESSED_FINDING_NUMBERS[*]:-none})
**Re-review verdict**: ${RE_REVIEW_VERDICT:-unknown}
**Auto-land bar**: ${AUTO_LAND_BAR_TEXT}
**Re-gate outcome**: ${RE_GATE_OUTCOME} ${OUTCOME_DETAIL}
**Head**: ${REMEDIATED_HEAD_SHA:-unknown}
${BASESYNC_LINE}
<!-- FORGE:REMEDIATION:COMPLETE -->"

gh pr comment {PR_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
```

**If the outcome was `AUTO-LANDED`**: this Skill invocation is itself the caller's terminal delegate (Phase 0A.1 of `work-on.md` already told its own routing loop to STOP after dispatching here) — so `remediate.md` must drive the close phase itself rather than assume some other inline logic will. Invoke the close subcommand directly, the same way `work-on/review.md` does when it hands off from a spawned sub-agent context:

```
Skill("{FORGE_SKILL_PREFIX}work-on:close", args="{ISSUE_NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --pr {PR_NUMBER} --base {PR_BASE}")
```

`work-on:close` handles project board update, final issue body, parent tracker, trajectory log, and worktree cleanup (including the remediation worktree at `{WORKTREE_PATH}`) — do not duplicate any of that here.

**If the outcome was `REREVIEW-REQUIRED`** (forge#3240): do not invoke close and do not add `needs-human`. Leave the worktree and `workflow:in-review` in place and return `REMEDIATE_RESULT: status: REREVIEW_REQUIRED`; the caller runs the re-review and, on `AUTO-LANDED`, drives close itself; if the re-review cannot run, the caller applies the terminal fallback (`commands/work-on.md` Phase 0A.1).

**If the outcome was `HELD-AWAITING-MERGE`, `RE-ESCALATED`, or `UNFIXABLE`**: leave the worktree in place (a human may need it for manual inspection/merge) and return the structured result below without invoking close. Do not close the issue.

---

## Output

Return this structured block to the caller:

```
REMEDIATE_RESULT:
  status: COMPLETE | ALREADY_DONE | UNFIXABLE | BLOCKED | REREVIEW_REQUIRED
  pr_number: {PR_NUMBER}
  issue_number: {ISSUE_NUMBER}
  re_gate_outcome: AUTO-LANDED | HELD-AWAITING-MERGE | RE-ESCALATED | UNFIXABLE | REREVIEW-REQUIRED | N/A
  findings_addressed: [{finding_number}, ...]
  blocker: {description if status=BLOCKED}
```

**Caller behavior**: this Skill already drives its own close phase when `re_gate_outcome: AUTO-LANDED` (see Phase M8) — the caller does not need to invoke close itself. For `re_gate_outcome: REREVIEW-REQUIRED` (`status: REREVIEW_REQUIRED`, forge#3240) the fix is pushed but no review ran because this session has no sub-agent dispatch tool: the caller MUST run `review-pr {PR_NUMBER} --auto-merge --issue {ISSUE_NUMBER} --base {PR_BASE}` from a session that has dispatch (never inline) and then drive close itself on a merge. For every other `re_gate_outcome`, this result is terminal for the current invocation: the issue is left at `needs-human` or `workflow:awaiting-merge`, both already recognized as terminal states in the Universal Phase Dispatcher (see `work-on.md`). Whether invoked standalone (`/work-on <pr> --remediate`) or via the orchestrator's item 6.4 dispatch, no further action is required from the caller.
