---
title: "ForgeDock Troubleshooting & Recovery Guide"
description: "Diagnose and recover from the most common ForgeDock pipeline failures: missing forge.yaml, gh auth errors, quality gate failures, worktree conflicts, stale labels, and API rate limits. Symptom, cause, and fix for each."
keywords: ["forgedock troubleshooting", "claude code pipeline errors", "work-on recovery", "forge.yaml not found", "gh auth login", "quality gate failed"]
---

# ForgeDock Troubleshooting & Recovery Guide

When the pipeline stops, it should tell you exactly why and how to recover. This guide covers the most common failure modes, each with its **symptom**, **cause**, and **fix**.

ForgeDock is resumable by design: GitHub is the source of truth. After fixing the underlying problem, you can almost always re-run `/work-on #N` and the pipeline picks up where it left off — it reads the issue's comments and labels to reconstruct state.

> Tip: `/work-on` runs a Phase 0 pre-flight check that catches several of these problems before the pipeline spends any tokens. The errors below mirror what that check reports.

---

## 1. `forge.yaml` not found

**Symptom**
The pipeline stalls early, or an agent guesses project values (owner, repo, paths) instead of reading them.

**Cause**
Every ForgeDock command reads `forge.yaml` from the repository root for project identity, paths, and branch configuration. If the file is missing, there is nothing to resolve `GH_REPO`, `REPO_PATH`, or branch targets from.

**Fix**
```bash
npx forgedock init
```
This scans your codebase and generates a `forge.yaml`. Alternatively, copy `forge.yaml.example` from the ForgeDock repo to `forge.yaml` and edit the `project`, `paths`, and `branches` sections. Re-run `/work-on #N` afterward.

---

## 2. `forge.yaml` has a syntax error

**Symptom**
A parse error appears in agent output, or values that clearly exist in the file resolve as empty.

**Cause**
`forge.yaml` is not valid YAML — usually a bad indentation level, a tab character where spaces are required, or an unquoted value containing a special character (`:`, `#`, `@`).

**Fix**
Validate the file and find the offending line:
```bash
# With yq (recommended):
yq '.' forge.yaml

# Or with Python:
python -c "import yaml,sys; yaml.safe_load(open('forge.yaml'))"
```
Both print the line and column of the first error. Fix the indentation or quote the value (e.g. `description: "turns GitHub into a knowledge graph"`), then re-run.

---

## 3. `gh` CLI not authenticated

**Symptom**
A `gh` command fails partway through the pipeline with `HTTP 401`, `Bad credentials`, or `gh: To use GitHub CLI, please run gh auth login`.

**Cause**
ForgeDock uses the GitHub CLI for every GitHub operation (reading issues, posting comments, creating PRs, merging). If `gh` is not authenticated — or the token expired — these calls fail.

**Fix**
```bash
gh auth login
gh auth status   # confirm you are logged in and the token has repo scope
```
Phase 0 pre-flight detects this before the pipeline starts. Re-run `/work-on #N` once `gh auth status` is clean.

---

## 4. Quality gate failed

**Symptom**
```
QUALITY GATE: FAIL
```
The build stops after listing HIGH/MEDIUM findings, and the issue keeps a `workflow:building` label.

**Cause**
The pre-commit quality gate caught defects (security, correctness, or convention violations) that the review would otherwise flag. The pipeline retries fixes up to 3 times; if it still fails, it adds `needs-human` and stops.

**Fix**
Read the findings in the issue comment, fix the flagged issues in the worktree, then re-run `/work-on #N` to resume the build. If `needs-human` was added, address the findings and remove the label before re-running. The worktree path is recorded in the build comment on the issue.

---

## 5. Worktree already exists

**Symptom**
```
fatal: '<path>' already exists
```
when the pipeline tries to create a git worktree for the issue.

**Cause**
A previous run created a worktree for this branch and it was never cleaned up — usually because the run was interrupted before Phase 6 cleanup.

**Fix**
Either reuse it (if it's on the correct branch) or remove and let the pipeline recreate it:
```bash
git worktree list                      # find the path
git worktree remove <path> --force     # remove the stale worktree
git branch -D <branch>                 # optional: delete the leftover branch
```
Re-run `/work-on #N`.

---

## 6. Label in the wrong state

**Symptom**
The pipeline is confused by labels that don't match reality — e.g. an issue tagged `workflow:merged` with no merged PR, or `workflow:building` with no open branch.

**Cause**
A run was interrupted between updating a label and completing the corresponding phase, leaving a stale `workflow:*` label.

**Fix**
```bash
/cleanup
```
`/cleanup` sweeps closed issues and stale labels, reconciling `workflow:*` state with actual PR/branch status. Then re-run `/work-on #N` if the issue still needs work.

---

## 7. Branch already exists

**Symptom**
```
fatal: a branch named 'feat/issue-N-slug' already exists
```

**Cause**
A previous run created the implementation branch and it wasn't deleted after merge or abandonment.

**Fix**
- **To continue** the existing work: check out the branch and let the pipeline reuse it.
- **To restart** from scratch:
```bash
git branch -D feat/issue-N-slug        # local
git push origin --delete feat/issue-N-slug   # remote, if pushed
```
Re-run `/work-on #N`.

---

## 8. PR targets the wrong branch

**Symptom**
A PR is opened against `main`, or against a branch that isn't the issue's correct target.

**Cause**
ForgeDock never targets `main`. Fast-lane issues (no milestone) target `staging`; milestone issues target `milestone/{slug}`. A wrong target usually means the lane was misclassified or the PR was created manually.

**Fix**
The `/work-on` pipeline computes the correct base from the issue's milestone and re-targets automatically — close the mis-targeted PR and re-run `/work-on #N`. To retarget an existing PR without recreating it:
```bash
gh pr edit <PR_NUMBER> --base staging          # or milestone/<slug>
```

---

## 9. Missing workflow labels

**Symptom**
The pipeline can't transition state; `gh issue edit --add-label "workflow:..."` fails with `label not found`.

**Cause**
The repository doesn't have ForgeDock's managed `workflow:*` labels yet (new repo, or labels were deleted).

**Fix**
```bash
npx forgedock labels setup          # from the project directory
# or, for a different repo:
npx forgedock labels setup --repo owner/repo
```
This idempotently bootstraps every managed label with canonical colors and descriptions. Re-run `/work-on #N`.

---

## 10. GitHub API rate limit exceeded

**Symptom**
```
API rate limit exceeded
```
`gh` commands fail in bursts, often during heavy orchestration runs.

**Cause**
The GitHub REST API allows 5,000 requests/hour per token, shared across all tools and agents. Parallel orchestration can exhaust this.

**Fix**
Check your remaining quota and reset time:
```bash
gh api rate_limit --jq '.resources.core'
```
Wait until the `reset` timestamp, or authenticate with a Personal Access Token that has higher limits. Reduce parallelism (fewer concurrent `/orchestrate` agents) to stay under the cap. Re-run `/work-on #N` after the limit resets.

---

## Still stuck?

If your problem isn't listed here, or a fix didn't work:

1. **Read the issue's comments.** Every phase writes a structured `FORGE:*` comment (investigation, contract, builder, trajectory). They explain what the pipeline saw and decided.
2. **Check the labels.** The `workflow:*` label tells you which phase the issue is in.
3. **Re-run `/work-on #N`.** The pipeline is idempotent and resumable — re-running is safe and usually cheap.

If none of that resolves it, open an issue on the [ForgeDock GitHub repository](https://github.com/RapierCraftStudios/ForgeDock/issues) with the failing command, the relevant `FORGE:*` comment, and the error output.
