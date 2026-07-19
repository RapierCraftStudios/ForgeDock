---
description: Push the build branch, validate the PR target against the classified lane, and create the pull request — Phase 4 of the /work-on pipeline
argument-hint: "[issue number] [--repo {owner}/{repo}] [--gh-flag \"-R {owner}/{repo}\"] [--worktree {path}] [--branch {name}] [--base {branch}]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/phase-4-pr — PR Creation

**Input**: $ARGUMENTS

Phase 4 of the `/work-on` pipeline: pre-push ancestry guard, branch push, PR-target
resolution and validation against the classified lane, PR creation, and the
`workflow:in-review` label transition. Runs after Phase 3 (Build) posts
`FORGE:BUILDER:COMPLETE`, and before Phase 5 (Auto-Review) invokes `/review-pr`.

**Agent model policy**: see `work-on.md` section "Model and Effort Tiering — What Actually
Applies" (`FORGE:MODEL_TIER_NOTE`) — this file's steps are mechanical (branch push, label
edit, `gh pr create`) end-to-end, a legitimate `effort: low` candidate; `model` overrides
are non-functional for `Skill()`-dispatched sub-phases per that note.
Plan mode: see `commands/shared/agent-policies.md` § Plan mode ban if not already in context.
**PRs NEVER target `main`.** Target `staging` (fast lane) or `milestone/{slug}` (feature lane).

<!-- FORGE:SPEC_LOADED — work-on/phase-4-pr.md loaded and active. -->

## Phase 4: PR Creation

### 4A: Pre-push ancestry guard

```bash
cd {WORKTREE_PATH}
if git ls-remote --exit-code origin {PR_BASE} >/dev/null 2>&1; then
  MERGE_COMMITS=$(git log --merges {BRANCH} ^origin/{PR_BASE} 2>/dev/null)
  if [ -n "$MERGE_COMMITS" ]; then
    # Post ancestry guard failure, add needs-human → STOP
  fi
fi
```

### 4B: Push branch
```bash
cd {WORKTREE_PATH} && git push -u origin {BRANCH}  # not DRY_RUN-gated — unconditional pipeline step, matches sibling phase files <!-- allowlist:check-command-side-effects -->
```
If fails: try `--force-with-lease`. If still fails: post comment, add `needs-human`, STOP.

### 4C: Determine PR target
`PR_BASE` was computed in Phase 3E. If somehow unset (e.g., resumed session after compaction), recompute:
```bash
# Not DRY_RUN-gated — a classify-lane/PR-target failure is an unconditional
# needs-human escalation in every /work-on run, matching sibling phase files.
RESOLUTION=$(resolve_script 'classify-lane')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal)
    if ! PR_BASE=$(bash "$SCRIPT_PATH" {NUMBER} -R {GH_REPO}); then
      gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKER: classify-lane.sh failed to recompute PR target — see script error above. Adding needs-human."
      gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
      exit 1
    fi
    ;;
  prose)
    # No valid prose fallback — see Phase 3E note.
    gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKER: classify-lane.sh not installed (prose tier). Cannot recompute PR target. Adding needs-human."
    gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
    exit 1
    ;;
esac
```
Output is authoritative — no prose fallback. Script exits 1 on error (invalid issue, `gh` auth failure, or milestone branch absent on remote); treat non-zero exit as `needs-human` and STOP. <!-- Added: forge#669, forge#639 -->

### 4C.5: Validate PR target against classified lane
```bash
RESOLUTION=$(resolve_script 'validate-pr-target')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal)
    bash "$SCRIPT_PATH" {PR_BASE} {CLASSIFIED_LANE}
    ;;
  prose)
    # validate-pr-target has no safe prose fallback — silently skipping validation risks
    # merging to the wrong branch. Log a warning but do NOT block the pipeline; the PR
    # review step will catch a mismatched target before merge.
    echo "WARNING: validate-pr-target.sh not installed (prose tier) — skipping lane validation. Confirm PR base manually." >&2
    ;;
esac
```
`{CLASSIFIED_LANE}` is the value returned by `classify-lane.sh` in Phase 4C. `{PR_BASE}` is the branch the PR will target. If exit code is 1 (mismatch):
```bash
# Not DRY_RUN-gated — a lane mismatch is an unconditional needs-human escalation.
gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKING: validate-pr-target.sh — PR base \`{PR_BASE}\` does not match classified lane \`{CLASSIFIED_LANE}\`. Manual intervention required."
gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
```
→ STOP. Do NOT proceed to Phase 4D. <!-- Added: forge#671 -->

### 4D: Create PR
```bash
# Not DRY_RUN-gated — PR creation is the unconditional purpose of this phase.
PR_URL=$(gh pr create {GH_FLAG} --base {PR_BASE} --head {BRANCH} \
  --title "{Fix|Feat|Refactor}: {description}" \
  --body "## Summary
{BRIEF_DESCRIPTION}

## Changes
{CHANGES_LIST}

## Testing
{TESTING_CHECKLIST}

---
Closes #{NUMBER}
**Implementation branch**: \`{BRANCH}\`
**Base**: \`{PR_BASE}\`")
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
```

`Closes #{NUMBER}` documents intent but does NOT auto-close for non-default-branch PRs. Capture `PR_NUMBER` here — Phase 5A reuses it instead of re-querying `gh pr list`.

If PR already exists for this branch, use the existing PR number.

### 4E: Update labels
```bash
# Not DRY_RUN-gated — the workflow:in-review transition is unconditional once a PR exists.
RESOLUTION=$(resolve_script 'transition-label')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} in-review ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:in-review" \
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:awaiting-merge,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true
    ;;
esac
```

---


→ Return to `work-on.md` Universal Phase Dispatcher: Phase 4 complete, PR created and `workflow:in-review` set. Proceed to Phase 5 (Auto-Review) via `work-on/review.md`.
