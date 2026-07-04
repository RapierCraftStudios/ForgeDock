---
authority: required
scope: agent
applies_to: [work-on, review-pr, orchestrate, quality-gate, issue, milestone]
domain: pipeline
last_validated: "YYYY-MM-DD"
version: "0.0.0"
---

# Using ForgeDock — Authoritative Pipeline Reference

ForgeDock is an autonomous development pipeline for Claude Code. It turns GitHub issues into the persistent context layer — agents investigate, build, review, and merge code with minimal human intervention.

---

## Core Principle

**GitHub issues are the persistent memory.** Every significant action is written back to the issue as a structured comment. If a session is interrupted, the next session re-reads the issue's comments and labels to reconstruct where it left off.

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

## Lane Types

Issues route to different PR targets based on their milestone:

| Lane | Trigger | PR Target | Branch Prefix |
|------|---------|-----------|---------------|
| **Fast Lane** | Issue has no milestone | `staging` | `fix/` or `feat/` |
| **Feature Lane** | Issue has a milestone | `milestone/{slug}` | `fix/` or `feat/` |

**Never target `main` directly.** PRs go to `staging` (fast lane) or `milestone/*` (feature lane). Main receives changes only through the staging→main deploy process.

---

## Command Reference

### `/work-on [issue_number]`

Runs the full pipeline for a single issue. Invoke repeatedly until the issue reaches a terminal state.

```bash
# Pick up specific issue
/work-on 258

# Pick highest-priority open issue automatically
/work-on next
```

**Resume behavior**: If `/work-on` was interrupted, re-invoking it reads the issue's existing comments and labels to determine which phase to resume from. No manual state management needed.

### `/orchestrate [milestone_slug]`

Orchestrates parallel work on an entire milestone — spawns sub-agents, each running `/work-on` for a separate issue.

```bash
/orchestrate milestone user-auth-v2
```

### `/review-pr [PR_number]`

Runs a multi-agent code review on a PR. 9 domain agents (API, frontend, security, infra, database, etc.) each review their area. Findings become separate GitHub issues.

```bash
/review-pr 42
/review-pr staging   # review the staging→main PR
```

**Review findings are NOT merge blockers.** They become separate issues to fix in subsequent PRs.

### `/issue [description]`

Creates a well-structured GitHub issue with all mandatory pipeline sections. Reads code before creating the issue to ensure file paths are accurate.

```bash
/issue the billing page crashes when credits hit zero
/issue feat: add dark mode toggle to dashboard settings
```

### `/milestone [action] [name]`

Creates and manages milestones — the top-level planning layer.

```bash
/milestone create "User Auth v2"
/milestone ship user-auth-v2
```

### `/quality-gate [files...]`

Runs automated checks on changed files: dead code, missing error handling, security anti-patterns, performance footguns.

### `/analytics`

Pulls production analytics from configured sources (GSC, GA4, Umami, Clarity, Cloudflare, Stripe). Generates insights and creates actionable GitHub issues.

### `/cleanup`

Sweeps closed issues for stale labels, prunes worktrees, cleans up stale branches.

### `/deploy-info`

Shows what will deploy next — diffs staging vs main with issue/PR summary, risk assessment, and deploy checklist.

### `/audit [issue_or_run]`

Traces a production issue or pipeline failure end-to-end through GitHub artifacts.

### `/audit-agents`

Analyzes agent output from an orchestration run — timeline, stall detection, active vs idle time.

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
3H  Format and verify (black/isort/py_compile for Python; prettier/tsc for TypeScript)
3I  Frontend proxy wiring check (if TypeScript files changed)
3I.5  Database configuration advisory (if DB engine patterns changed)
3J  Deployment completeness check (if new env vars introduced)
3K  Commit (conventional commit message with issue reference)
3L  Update issue body (check off completed items)
3M  Post implementation comment (FORGE:BUILDER)
```

---

## Workflow Labels

Labels track pipeline state. Do not manually modify `workflow:*` labels — the pipeline manages them.

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

## forge.yaml Configuration

`forge.yaml` at the project root configures all pipeline variables. Required sections:

- `project` — GitHub owner, repo name
- `paths` — local repo root, worktree base directory
- `branches` — default, staging, feature pattern

Optional sections:
- `project_board` — GitHub Projects v2 integration
- `review` — tech stack context for review agents
- `services` — analytics/monitoring endpoints
- `repos` — multi-repo satellite routing

Generate or update `forge.yaml`:

```bash
npx forgedock init        # interactive setup
npx forgedock docs init   # scaffold devdocs directory
```

---

## Compaction Resilience

ForgeDock is designed to survive session interruptions:

1. Every significant step writes state to GitHub (comments + labels)
2. Re-reading the issue at the start of each phase reconstructs all context
3. A new session can pick up any interrupted pipeline by re-running `/work-on {number}`

**Never rely on in-memory state across phase boundaries.** Read from GitHub.

---

## Multi-Repo Routing

When `forge.yaml → repos.satellites` is configured, issue numbers can be prefixed to route to satellite repos:

```bash
/work-on mcp:5     # routes to satellite repo with prefix "mcp"
/work-on sdk:12    # routes to satellite repo with prefix "sdk"
/work-on 42        # routes to default repo
```

---

## Spec Compliance Rules

Command specs declare constraints that agents MUST follow. These rules are not enforced at the tool-call level — compliance depends entirely on the agent reading and obeying the spec. Violations are invisible to the pipeline and can silently skip critical safety gates.

1. **Respect `allowed-tools` frontmatter.** When a command spec declares `allowed-tools:` in its YAML frontmatter, NEVER use a tool not in that list. In particular, NEVER use the `Agent` tool when it is not listed — use `Task` or `Skill` instead. The `Agent` tool spawns opaque subprocesses that bypass `allowed-tools` constraints and cannot post structured output.

2. **Execute Phase 0 routing before any other phase.** Commands with Phase 0 routing conditions (e.g., `review-pr.md` routing staging PRs to `review-pr-staging`) MUST evaluate the routing check before proceeding. Skipping routing can bypass entire sub-pipelines including deploy gates, test gates, and structured finding creation.

3. **Look for `FORGE:SPEC_LOADED` markers.** Critical command specs include a `<!-- FORGE:SPEC_LOADED -->` HTML comment near the top. If you are executing a command and do not see this marker in your context, the spec was not loaded — stop and re-read the command file before proceeding.

<!-- Added: forge#1383 — agent spec-compliance enforcement -->

---

## Idempotency Rules

- Re-invoking `/work-on` on a completed issue is safe — it reads the terminal label and stops
- Creating a worktree that already exists: the pipeline reuses it
- Posting a duplicate phase comment: the pipeline checks for existing comments before posting
- Quality gate running on already-clean code: it passes immediately

---

## Common Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|------------|
| Issue stuck at `workflow:investigating` | Investigation comment missing `<!-- INVESTIGATION:COMPLETE -->` | Re-run `/work-on` — partial comments are detected and deleted |
| Merge conflict on PR | Branch diverged from base | Post comment, add `needs-human`; never auto-resolve |
| `needs-human` label set | Pipeline encountered a blocker | Read the issue comments for the specific blocker |
| Worktree already exists | Previous run was interrupted mid-build | Re-run — worktree is reused if branch is correct |
| Sub-issue pipeline not started | Parent was decomposed | Run `/work-on {sub_issue_number}` for each sub-issue |
