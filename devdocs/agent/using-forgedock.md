---
authority: required
scope: agent
applies_to: [work-on, review-pr, orchestrate, quality-gate, issue, milestone]
domain: pipeline
last_validated: "2026-06-15"
version: "1.0.15"
---

# Using ForgeDock — Self-Dogfooding Pipeline Reference

ForgeDock IS a ForgeDock installation. This repo uses its own pipeline commands to develop itself. This document captures what that means in practice — the conventions and constraints specific to dogfooding ForgeDock on ForgeDock.

---

## Self-Dogfooding Pattern

ForgeDock agents running on this repository are running ForgeDock to improve ForgeDock. This creates a feedback loop:

- Pipeline commands live in `commands/` — any agent reading `commands/work-on.md` is the same agent that built it
- Bugs found during pipeline runs surface immediately as pipeline failures
- Any improvement to command specs takes effect in the NEXT pipeline run (not the current one)

**Implication for agents**: When a command spec has a bug you observe during execution, do NOT work around it silently. Create a GitHub issue via `gh issue create` and note the observation. The fix will be addressed by a subsequent `/work-on` run.

---

## Pipeline Architecture

The `/work-on` command runs the full lifecycle. A single invocation may span multiple Claude sessions — each picks up from the last state.

### Phase Sequence

| Phase | Name | What Happens |
|-------|------|-------------|
| 0 | Context Load | Read `forge.yaml`, load issue state, classify lane |
| 1 | Investigation | Validate the issue, find root cause, read affected files |
| 2 | Decomposition | (Optional) Split large issues into sub-issues |
| 3A–3M | Build | Contract → Context → Architecture → Implement → Quality Gate → Commit |
| 4 | PR Creation | Push branch, create PR targeting the correct base branch |
| 5 | Auto-Review | Run `/review-pr --auto-merge`; domain agents review; PR merges |
| 6 | Close & Cleanup | Close issue, update project board, remove worktree |
| 7 | Trajectory | Post pipeline summary; terminal state |

### Terminal States

The pipeline stops only when one of these labels is present:

- `workflow:merged` — PR merged, issue closed
- `workflow:invalid` — issue confirmed as not valid
- `needs-human` — blocker requires manual intervention
- `workflow:decomposed` — sub-issues spawned; each runs its own pipeline

---

## Repository Structure

```
commands/              # Authoritative pipeline specs — what agents READ and EXECUTE
  work-on.md           # Main orchestrator: phases 0–7
  work-on/             # Sub-phases: investigate, build, review, close
    build/             # Sub-sub-phases: context, architect, implement, validate
  review-pr.md         # PR review orchestrator
  review-pr-agents.md  # 9-agent review catalog
  orchestrate.md       # Parallel multi-issue execution
  quality-gate.md      # Pre-commit checks (14+ domains)
  autopilot.md         # Self-improvement cycle
bin/                   # npm installer
  forgedock.mjs        # npx forgedock — project-scoped install (default); npx forgedock --global installs into ~/.claude/commands/
scripts/               # Universal deterministic scripts (ship with npm)
  classify-lane.sh     # Lane routing: milestone → feature lane, no milestone → staging
  transition-label.sh  # Label state machine validation
  validate-pr-target.sh # Hard-fail if PR base branch doesn't match classified lane
.forgedock/scripts/    # Per-repo adaptive scripts (gitignored by default)
devdocs/               # THIS REPO'S active devdocs (what you are reading)
templates/devdocs/     # Template devdocs for user projects (NOT this repo's docs)
docs/                  # Reference docs (CONFIG.md, field IDs, Codex architecture)
```

**Critical distinction**: `templates/devdocs/` contains generic templates for user projects. `devdocs/` (this directory) contains ForgeDock's own authoritative knowledge. When updating ForgeDock's devdocs, edit files in `devdocs/` — not in `templates/devdocs/`.

---

## Lane Types

Issues route to different PR targets based on their milestone:

| Lane | Trigger | PR Target | Branch Prefix |
|------|---------|-----------|---------------|
| **Fast Lane** | Issue has no milestone | `staging` | `fix/` or `feat/` |
| **Feature Lane** | Issue has a milestone | `milestone/{slug}` | `fix/` or `feat/` |

**Never target `main` directly.** Main receives changes only through the staging review process.

### Active Milestone

Most active development is in the **Deterministic Pipeline v2** milestone:

- **Milestone name**: `Deterministic Pipeline v2`
- **Branch**: `milestone/deterministic-pipeline-v2`
- **Track**: Scripts layer, knowledge determinism, reliability improvements

---

## Command Reference

### `/work-on [issue_number]`

Runs the full pipeline for a single issue. Re-invoking picks up from the last state.

```bash
/work-on 676      # work on specific issue
/work-on next     # pick highest-priority open issue
```

**When dogfooding**: `/work-on` reads its own spec from the project-scoped install location (symlinked from `commands/work-on.md`). On a global install (`--global`), the spec lives at `~/.claude/commands/work-on.md`. Changes to `commands/work-on.md` take effect in the NEXT session, not the current one.

### `/orchestrate [milestone_slug]`

Orchestrates parallel work on all open issues in a milestone.

```bash
/orchestrate milestone deterministic-pipeline-v2
```

### `/review-pr [PR_number]`

Runs a multi-agent code review. Findings become separate GitHub issues.

```bash
/review-pr 720            # review a specific PR
/review-pr staging        # review the staging→main PR
```

**Review findings are NOT merge blockers.** They become separate issues.

### `/quality-gate [files...]`

Pre-commit checks: dead code, missing error handling, security anti-patterns, performance.

### `/issue [description]`

Creates a well-structured GitHub issue with all mandatory pipeline sections.

### `/cleanup`

Sweeps closed issues for stale labels, prunes worktrees, cleans stale branches.

---

## Phase 3 Build Sub-Phases

When building, these sub-phases run in order. Every sub-phase is mandatory:

```
3A  Re-read issue state from GitHub
3B  Classify task type (bug/feature/refactor/docs/investigation)
3C  Post Builder Contract (deliverables, acceptance criteria)
3C.5  Context gathering (past review findings, related code paths)
3C.6  Architecture plan (affected paths, implementation order, risk assessment)
3D  Set workflow:building label
3E  Create git worktree from source branch
3F  Implement (follow architect plan; read context before writing code)
3F.5  Env/config completeness check
3G  Quality gate (up to 3 iterations to fix findings)
3H  Format and verify (language-specific tooling)
3I  Frontend proxy wiring check (if TypeScript files changed)
3I.5  Database configuration advisory (if DB engine patterns changed)
3J  Deployment completeness check (if new env vars introduced)
3K  Commit (conventional commit message with issue reference)
3L  Update issue body (check off completed items)
3M  Post implementation comment (FORGE:BUILDER)
```

---

## FORGE: Annotations

Every pipeline stage writes a structured HTML comment to the issue. These are the handoff protocol between stages.

| Annotation | Posted by | Read by | Purpose |
|-----------|-----------|---------|---------|
| `<!-- FORGE:INVESTIGATOR -->` | Phase 1 | Phase 3 | Root cause, affected files, recommendation |
| `<!-- FORGE:CONTRACT -->` | Phase 3C | Phase 3F | Deliverables table, acceptance criteria |
| `<!-- FORGE:CONTEXT -->` | Phase 3C.5 | Phase 3F | Historical findings, pitfalls, related paths |
| `<!-- FORGE:ARCHITECT -->` | Phase 3C.6 | Phase 3F | Implementation order, consistency checks |
| `<!-- FORGE:BUILDER -->` | Phase 3M | Phase 5 | What was built, commit SHAs, testing checklist |
| `<!-- FORGE:TRAJECTORY -->` | Phase 7 | Post-mortem | Pipeline summary, cycle time, token cost |

**Rule**: Always read all existing annotations before posting a new one. Annotations accumulate on the issue — they are the persistent state.

---

## Workflow Labels

Labels track pipeline state. The pipeline manages these — do not set manually.

| Label | Meaning |
|-------|---------|
| `workflow:investigating` | Phase 1 in progress |
| `workflow:ready-to-build` | Investigation complete; build queued |
| `workflow:building` | Phase 3 in progress |
| `workflow:in-review` | PR created; awaiting review |
| `workflow:merged` | Pipeline complete; PR merged |
| `workflow:invalid` | Issue closed as not valid |
| `workflow:decomposed` | Issue split into sub-issues |
| `needs-human` | Pipeline stalled; manual action required |

---

## forge.yaml Configuration (this repo)

```yaml
project:
  name: "Forgedock"
  owner: "RapierCraftStudios"
  repo: "forgedock"

paths:
  root: "/path/to/your/project"
  worktree_base: "/path/to/your/project/.claude/worktrees"

branches:
  default: "main"
  staging: "staging"
  feature_pattern: "milestone/{slug}"

adaptive_scripts:
  enabled: true
  directory: ".forgedock/scripts"
  commit: false
```

---

## Compaction Resilience

ForgeDock is designed to survive session interruptions:

1. Every significant step writes state to GitHub (comments + labels)
2. Re-reading the issue at the start of each phase reconstructs all context
3. A new session can pick up any interrupted pipeline by re-running `/work-on {number}`

**Never rely on in-memory state across phase boundaries.** Read from GitHub.

---

## Dogfooding Constraints

When working on ForgeDock itself (vs. a user project):

1. **Command spec changes**: changes to `commands/*.md` affect the pipeline's own behavior on the next session. Do not expect the CURRENT session to behave differently after editing a command spec.
2. **Script changes**: changes to `scripts/*.sh` take effect immediately (scripts are executed from disk, not from memory).
3. **No production database/service**: ForgeDock has no runtime service to check. Acceptance criteria are validated by reading/running command specs and scripts — not by hitting an API.
4. **AGPL compliance**: all changes to this repo are AGPL. Do not merge Platform-only (proprietary) code here. See `devdocs/project/architecture.md` for the open-core boundary rules.
5. **npm publish trigger**: CI auto-publishes on push to `main` when `commands/`, `bin/`, `docs/`, `scripts/`, or `package.json` change. `devdocs/` changes do NOT trigger publish (intentional).

---

## Common Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|------------|
| Issue stuck at `workflow:investigating` | Investigation comment missing `<!-- INVESTIGATION:COMPLETE -->` | Re-run `/work-on` — partial comments are detected and deleted |
| Merge conflict on PR | Branch diverged from base | Post comment, add `needs-human`; never auto-resolve |
| `needs-human` label set | Pipeline encountered a blocker | Read the issue comments for the specific blocker |
| Worktree already exists | Previous run was interrupted mid-build | Re-run — worktree is reused if branch is correct |
| Sub-issue pipeline not started | Parent was decomposed | Run `/work-on {sub_issue_number}` for each sub-issue |
| Quality gate fails on `.md` files | Docs-only PR hitting unexpected checks | Phase 3G skips for 1-file config/docs edits; multi-file docs PRs run quality gate |
