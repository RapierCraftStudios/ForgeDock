---
description: "[BENCHMARK] Monolithic work-on — single-prompt pipeline with no Skill sub-phase boundaries"
argument-hint: [issue number]
install: internal
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /work-on-monolithic — Full Issue Pipeline (Single Prompt)

**Input**: $ARGUMENTS

Orchestrator for the full issue lifecycle: investigate → build → review → merge → close. GitHub issues are the persistent context layer — read existing comments before starting, write structured reports back, use `workflow:*` labels to track state.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

> **Relationship to `/work-on` (canonical path)**: This file is a `[BENCHMARK]` reference variant. It documents the same inline-execution model that `/work-on` Phase 3 and `work-on/build.md` use as their **default** for STANDARD/fast-lane issues — all build sub-phases (context → architect → implement → validate) run inline in the current context window with no `Skill()` sub-agent spawns. The difference is that this file omits the worktree lifecycle, `FORGE:CONTRACT` posting, and the Spawn-Decision exception path for large builds. Use `/work-on` for production runs; use this file for baseline benchmarking or when comparing single-prompt token cost against the modular path. See `work-on/build.md` (Canonical Build Path section) for the reconciled build topology. <!-- Added: forge#1276 -->
**NEVER use the Agent tool** — this spec executes all phases inline as a single monolithic prompt. The Agent tool would spawn a subprocess outside this context, breaking the single-prompt contract and losing all accumulated pipeline state.

<!-- FORGE:SPEC_LOADED — work-on-monolithic.md loaded and active. Agent is bound by this spec. -->

### Compaction Resilience

1. Write state to GitHub after EVERY significant step
2. Re-read GitHub state at the START of each phase (don't rely on in-memory context)
3. After compaction: re-read issue (body + comments + labels) to reconstruct state
4. Key principle: A NEW session running this command should pick up where the last left off by reading GitHub state alone

---

## Pipeline Rules

- **NEVER merge to main.** PRs target `staging` (fast lane) or `milestone/{slug}` (feature lane).
- **`Closes #N` does not auto-close for non-default-branch PRs.** You MUST explicitly `gh issue close`.
- **Review findings are NOT merge blockers.** They become separate issues.

---

## Project Configuration

Read `forge.yaml` from the repository root. If missing, tell the user to run `npx forgedock init` and stop.

Resolve the following variables from `forge.yaml` before running any pipeline phase:

| Variable | Source in forge.yaml | Description |
|----------|----------------------|-------------|
| `GH_REPO` | `project.owner` + `project.repo` | Full GitHub repo identifier (`owner/repo`) |
| `REPO_PATH` | `paths.root` | Absolute path to the local repository |
| `STAGING_BRANCH` | `branches.staging` | Branch for fast-lane PRs (no milestone) |
| `WORKTREE_BASE` | `paths.worktree_base` | Directory where git worktrees are created |
| `GH_FLAG` | _(empty for default repo; `-R owner/repo` for satellites)_ | Extra flag for `gh` CLI satellite repo calls |

**Multi-repo routing** (optional): If `forge.yaml` contains a `repos.satellites` list, build the prefix routing table from it. Each satellite entry has `prefix`, `repo`, `staging_branch`, and `local_path`. Issues without a prefix route to the default `GH_REPO`. Satellite repos have no staging — their fast-lane PRs go to their configured `staging_branch` (typically `main`).

If no `repos.satellites` section exists, only the primary repo is available — all issues route to `GH_REPO`.

---

## Phase 0: Resolve Issue & Load Context

### 0A: Parse input
Extract project prefix and issue number.

### 0B: Load issue + existing context
```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,comments,milestone
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --jq '.[] | {id: .id, author: .user.login, body: .body}'
```

**Check**: state (closed → STOP), terminal labels (`workflow:merged`/`workflow:invalid` → STOP), existing agent comments (`FORGE:INVESTIGATOR`, `FORGE:CONTRACT`, `FORGE:BUILDER`, `FORGE:TRAJECTORY`), parent tracker status.

**Determine resume point**: No comments → Phase 1. Investigation exists + ready-to-build → Phase 3. Builder:COMPLETE + no PR → Phase 4. Builder without :COMPLETE (partial/interrupted build) + no PR → Phase 3 (partial-build cleanup). Builder + PR open → Phase 5. PR merged + issue open → close issue.

**Classify lane**: Milestone → feature lane (`milestone/{slug}`). No milestone → fast lane (`staging`).

**Source branch for review-findings**: Parse `**Code branch**: \`{branch}\`` from body. Branch from there, not main.

### 0C: Sync to Project board
Add issue to project, set Status=In Progress, Lane, Component, Priority, Workflow=Investigating.

---

## Phase 1: Investigation

**Skip if**: `<!-- FORGE:INVESTIGATOR -->` exists with `<!-- INVESTIGATION:COMPLETE -->`.

### 1A: Set label
```bash
gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:investigating"
gh issue edit {NUMBER} {GH_FLAG} --remove-label "workflow:ready-to-build,workflow:building,workflow:in-review" 2>/dev/null || true
```

### 1B: Investigate the issue

Mission: Validate whether the issue is real. Assume description is wrong until proven otherwise.

**Domain file hints** (start search here):

Configure domain-to-file mappings for your project in `forge.yaml → review.key_paths`. The table below shows the standard layout — override any entry that doesn't match your codebase:

| Domain | Default key files (override via forge.yaml) |
|--------|---------------------------------------------|
| BILLING | `routers/billing.py`, `core/pricing.py`, `services/payment_service.py` |
| WORKER | `worker/main.py`, `worker/queues.py`, `worker/tasks.py` |
| AUTH | `core/auth.py`, `routers/auth.py`, `dependencies.py` |
| DATABASE | `infra/migrations/`, `models/`, `db/` |
| FRONTEND | `web/src/app/`, `web/src/components/`, `web/src/lib/` |
| AI | `services/ai_client.py`, `routers/ai.py` |
| INFRA | `.github/workflows/`, `docker-compose.yml`, `infra/traefik/` |

If `forge.yaml → review.key_paths` is present, use those mappings instead of the defaults above.

**Steps**: Check right branch → read domain files → verify claims → git blame → determine root cause → identify affected files → validate proposed fixes against full system stack.

**Fix-Approach Validation**: If issue proposes a fix, don't adopt it as spec. Trace through target system's middleware, auth, routing.

**Domain Context Discovery** (narrow scope, max 5 files):
```bash
git log --oneline --all -30 -- {affected_files} | grep -oP '#\d+' | sort -u
```

**Output format**: Verdict (CONFIRMED/PARTIAL/INVALID), Confidence, Severity, Task Type, What Was Claimed, What We Found, Root Cause, Affected Files, Evidence, Recommendation.

### 1C: Post investigation comment
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:INVESTIGATOR -->
<!-- INVESTIGATION:COMPLETE -->
## Investigation Report
{report}"
```

### 1D: Update labels
CONFIRMED/PARTIAL → add `workflow:ready-to-build`, continue to Phase 3.
INVALID → close issue, add `workflow:invalid`, STOP.

---

## Phase 3: Build

**Skip if**: `<!-- FORGE:BUILDER -->` exists.

### 3A: Re-read state from GitHub (MANDATORY)
```bash
gh issue view {NUMBER} {GH_FLAG} --json body,labels
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'
```

### 3B: Classify task type

| Signal | Type | Approach |
|--------|------|----------|
| UI/UX, feature + web/ files | UI/UX | `frontend-design` skill |
| Feature + services/ | Backend Feature | Implement directly |
| Feature + both | Full-Stack | Backend first, then frontend-design |
| Bug + web/ | Frontend Fix | Direct |
| Bug + services/ | Backend Fix | Direct |
| Refactor/docs | Maintenance | Direct |

### 3C: Builder Contract (MANDATORY)
Post `<!-- FORGE:CONTRACT -->` comment with: task type, proposed approach, deliverables table (file/change/why), acceptance criteria, quality considerations.

### 3C.5: Context Gathering (max 2 minutes)

Surface institutional memory before writing code. For each affected file:
```bash
# Recent agent work on these files
git log --oneline --all -30 -- {affected_files} | grep -oP '#\d+' | sort -u | head -5
# Check for review findings on same files
for ISSUE_NUM in {related_issue_numbers}; do
  gh api repos/{GH_REPO}/issues/${ISSUE_NUM}/comments --jq '.[] | select(.body | contains("FORGE:")) | .body' 2>/dev/null | head -20
done
```

Post `<!-- FORGE:CONTEXT -->` comment with findings (or skip if no relevant history).

### 3C.6: Architecture Plan

For multi-file changes, trace ALL affected code paths before writing code:
- Map the call chain: entry point → middleware → handler → service → model → response
- Identify every file that needs to change
- Order implementation steps to avoid broken intermediate states

Post `<!-- FORGE:ARCHITECT -->` comment with the implementation plan.

For single-file or trivial changes, skip this step.

### 3D: Set building label
```bash
gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:building" --remove-label "workflow:ready-to-build,workflow:investigating"
```

### 3E: Create worktree
Branch slug from title (lowercase, hyphenated, max 40 chars). Prefix: `fix/` (bugs) or `feat/` (features).
- Review-finding → branch from `origin/{SOURCE_BRANCH}`
- Fast lane → branch from `origin/{STAGING_BRANCH}`
- Feature lane → branch from `origin/milestone/{slug}`

```bash
cd {REPO_PATH}
git fetch origin
BRANCH="fix/{slug}-{NUMBER}"
git worktree add {WORKTREE_BASE}/{BRANCH} -b {BRANCH} origin/{PR_BASE}
```

### 3F: Implement
Route by task type. Read the investigation report and contract. Implement the fix/feature.

### 3F.5: Quality Gate
Invoke quality-gate on changed files:
```
Skill(skill="quality-gate", args="{changed_files} --worktree {WORKTREE_PATH}")
```
Fix HIGH/MEDIUM findings. Max 2 iterations. Skip for 1-file config/docs edits.

### 3G: Format and verify
- Python: `black` + `isort` + `py_compile`
- TypeScript (primary repo): `prettier --write` + `tsc --noEmit` (BLOCKING if fails)
- TypeScript (satellite): `npm run build` + `prettier --write`

### 3H: Frontend proxy wiring check (MANDATORY)
All client-side fetch/useSWR/apiFetch must use `/api/...` proxy routes, NEVER `/api/v1/...` directly.

### 3I: Deployment completeness check (MANDATORY)
Skip if no new env vars introduced.

For each new env var, verify present in ALL required locations:

| Location | Required for |
|----------|-------------|
| `.env.example` | All new vars |
| Secrets backend (see `deploy.secrets_backend`) | Secret vars — skip if backend is `none` or unset |
| `app/env_validation.py` | API service vars (if project has one) |

**Secrets backend check** *(trigger: `deploy.secrets_backend == "sops"`)*:

If the project uses SOPS, verify the new var is present in all SOPS chain locations:
- `infra/secrets/prod.enc.yaml` — SOPS-encrypted secret store
- `infra/decrypt-secrets.sh` ENV_MAPPING — maps SOPS key to env var name

If `deploy.secrets_backend` is absent or not `sops`, skip these checks and log:
> `SKIP: SOPS chain check — deploy.secrets_backend is not "sops". Configure deploy.secrets_backend in forge.yaml to enable.`

### 3J: Commit
Conventional prefix (fix/feat/refactor/docs). Reference #{NUMBER} in the commit message.

### 3K: Post implementation comment
Post `<!-- FORGE:BUILDER -->` with: branch, commit, files changed, approach, changes list, testing checklist.

---

## Phase 4: PR Creation

### 4A: Push branch
```bash
cd {WORKTREE_PATH} && git push -u origin {BRANCH}
```
If fails: try `--force-with-lease`. If still fails: post comment, add `needs-human`, STOP.

### 4B: Determine PR target
No milestone → `staging`. Has milestone → `milestone/{slug}`. NEVER `main`.

### 4C: Create PR
```bash
gh pr create {GH_FLAG} --base {PR_BASE} --title "{Fix|Feat}: {description} (#{NUMBER})" --body "..."
```
Include `Closes #{NUMBER}`.

### 4D: Update labels
```bash
gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:in-review" --remove-label "workflow:building"
```

---

## Phase 5: Auto-Review

### 5A: Re-read state from GitHub (MANDATORY)
### 5B: Invoke /review-pr with --auto-merge
```
Skill(skill="review-pr", args="{PR_NUMBER} --auto-merge --issue {NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}")
```

### 5C: Verify merge and close (recovery)
- PR MERGED + issue CLOSED → proceed to Phase 6/7
- PR MERGED + issue OPEN → close issue manually
- PR NOT MERGED → `gh pr merge --merge {GH_FLAG}`, close issue. If merge fails → post comment, add `needs-human`, STOP.

### 5D: Project board update (Workflow=Merged, Status=Done)

### 5E: Final issue body update
Check off remaining items.

---

## Phase 6: Parent Tracker Update (Sub-Issues Only)

**Skip if**: Not a sub-issue.

Check off this sub-issue in parent body. If ALL sub-issues closed → close parent with `workflow:merged`.

---

## Phase 7: Summary & Trajectory

### 7A: Report
```
## Done: #{NUMBER} — {TITLE}
- Investigation: {verdict} ({confidence})
- Lane: {FAST/FEATURE}
- Fix: {branch} → PR #{PR_NUMBER} → merged to `{PR_BASE}`
- Files changed: {count}
```

### 7B: Trajectory Log (MANDATORY)
Post `<!-- FORGE:TRAJECTORY -->` comment with phase-by-phase results table, decisions, anomalies.

---

## Error Handling

- Worktree exists: reuse or clean up
- PR creation fails: check if branch pushed, if PR already exists
- Merge conflicts: report to user, do NOT auto-resolve
- gh CLI fails: check `gh auth status`
- Label missing: create it
