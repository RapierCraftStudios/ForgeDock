---
title: "ForgeDock Architecture"
description: "How ForgeDock's autonomous pipeline works. Phase-by-phase breakdown, FORGE annotation relay, worktree isolation, and how agents reconstruct context after compaction."
---

# ForgeDock Architecture

ForgeDock is **not an application** — it's a set of markdown command specs that get symlinked into `~/.claude/commands/` and invoked as slash commands in Claude Code. There is no runtime process. Every pipeline operation runs inside Claude Code, using GitHub as the persistence layer.

---

## Repository Structure

```
commands/              # Authoritative workflow specs
  work-on.md           # Main orchestrator: investigate → build → review → merge
  work-on/             # Sub-phases: investigate, build, review, close
    build/             # Sub-sub-phases: context, architect, implement, validate
  review-pr.md         # PR review orchestrator
  review-pr-agents.md  # 9-agent review catalog
  orchestrate.md       # Parallel multi-issue execution
  quality-gate.md      # Pre-commit checks (14+ domains)
  autopilot.md         # Self-improvement cycle
  ...                  # 25+ more commands

bin/                   # npm installer
  forgedock.mjs        # npx forgedock — symlinks commands into ~/.claude/commands/

docs/                  # Reference docs and this site
scripts/               # Verification scripts used by quality-gate
.agents/               # Codex adapter layer (repo-local skill overrides)
```

---

## The Pipeline Relay

The core innovation is **structured context passing via GitHub annotations**. Every pipeline phase writes a `FORGE:` annotation as a GitHub issue comment. Every downstream phase reads prior annotations before acting.

```
Issue opened
    │
    ▼
FORGE:INVESTIGATOR  — root cause, affected files, recommendation
    │
    ▼
FORGE:CONTRACT      — what will be built, deliverables table, acceptance criteria
    │
    ▼
FORGE:CONTEXT       — past review findings, historical bugs, related code paths
    │
    ▼
FORGE:ARCHITECT     — implementation plan, ordered file changes, risk assessment
    │
    ▼
FORGE:BUILDER       — branch, commits, files changed, acceptance criteria status
    │
    ▼
FORGE:REVIEW        — domain agent findings, severity ratings
    │
    ▼
FORGE:TRAJECTORY    — audit trail, pipeline phase results, anomalies
```

This relay means:
- A new session can pick up exactly where a previous one left off by reading GitHub state
- Context compaction does not lose work — the next agent re-reads annotations and continues
- The audit trail is human-readable and queryable with the `gh` CLI

---

## Pipeline Phases

### Phase 0: Context Load

Reads issue number, labels, milestone, existing annotations. Determines which phase to resume from. Classifies lane (fast vs. feature) based on milestone presence.

**Fast lane**: Issues without a milestone → PR targets `staging`.
**Feature lane**: Issues with a milestone → PR targets `milestone/{slug}`.

### Phase 1: Investigation

Validates whether the issue is real. Reads domain files, traces execution paths, git blame. Posts `FORGE:INVESTIGATOR` with verdict (CONFIRMED / PARTIAL / INVALID), root cause, affected files, and decomposition assessment.

### Phase 2: Decomposition (conditional)

If 2+ services, 6+ files across directories, or multiple task types: creates sub-issues with dependency order. Parent issue gets `workflow:decomposed`. Each sub-issue runs its own `/work-on`.

### Phase 3: Build

Sub-phases in order:

| Sub-phase | What Happens |
|-----------|-------------|
| 3C: Contract | Builder posts deliverables table, acceptance criteria, quality considerations |
| 3C.5: Context | Surfaces institutional memory — past review findings, historical bugs, related code paths |
| 3C.6: Architect | Traces ALL affected code paths, sequences implementation order, assesses risk |
| 3F: Implement | Writes code in isolated git worktree per the architect plan |
| 3G: Quality Gate | 14-category pre-commit check (runs up to 3 iterations) |
| 3H: Format | Language-specific formatting and type checking |
| 3K: Commit | Conventional commit with issue reference |
| 3M: Builder comment | Posts `FORGE:BUILDER` with branch, commits, acceptance criteria status |

### Phase 4: PR Creation

Pushes branch, creates PR targeting the correct base branch. Updates issue to `workflow:in-review`.

### Phase 5: Auto-Review

Invokes `/review-pr --auto-merge`. 9 domain agents (security, billing, database, concurrency, auth, frontend, API, performance, infrastructure) review the PR. Critical/HIGH findings become separate GitHub issues. PR merges if no blocking findings.

### Phase 6: Close & Cleanup

Closes the issue, sets `workflow:merged`, removes worktree and local branch. If issue is a sub-issue, checks off the item in the parent tracker.

### Phase 7: Trajectory Log

Posts `FORGE:TRAJECTORY` with phase-by-phase results table for pipeline health monitoring.

---

## Git Worktree Isolation

Every build phase creates an isolated git worktree:

```bash
git worktree add .claude/worktrees/feat-my-feature-42 \
  -b feat/my-feature-42 origin/staging
```

Benefits:
- Build operations never dirty the main working tree
- Multiple issues can be built in parallel without branch conflicts
- Worktree is removed in Phase 6 after merge

---

## Quality Gate

The quality gate checks code before commit across 14+ domains:

- **Logic**: null checks, off-by-one errors, unreachable code
- **Auth**: auth guards on all state-changing routes
- **Database**: N+1 queries, missing indexes, raw SQL injection surface
- **Security**: hardcoded credentials, injection vectors, CSRF exposure
- **Frontend**: proxy wiring, missing error boundaries, a11y regressions
- **Infrastructure**: Docker ownership, port binding, env var sync
- **API contracts**: response shape changes, SDK literal sync
- **Tests**: coverage gaps, missing edge cases

Each finding is rated HIGH / MEDIUM / LOW. HIGH findings are blocking. The gate runs up to 3 iterations.

---

## Compaction Resilience

Claude Code compacts context mid-session. ForgeDock is designed to survive this:

1. **Write to GitHub after every significant step** — annotations are the durable state
2. **Re-read GitHub at the start of each phase** — never assume in-memory context
3. **Universal dispatcher** — any session can re-read issue labels and comments and determine exactly which phase to resume

A new `/work-on 42` invocation after compaction reads the existing `FORGE:INVESTIGATOR`, `FORGE:CONTRACT`, `FORGE:ARCHITECT`, and `FORGE:BUILDER` comments and jumps straight to Phase 4 (PR creation) or Phase 5 (review) without re-running earlier phases.

---

## Command Specs Are Prompts

The `.md` files in `commands/` are detailed prompt engineering documents — some exceed 50KB. They constrain LLM behavior at every step:

- **Phase boundaries** are explicit with entry conditions and exit actions
- **Universal continuation rule** prevents premature stopping after intermediate results
- **Structured output requirements** (e.g., `<!-- INVESTIGATION:COMPLETE -->` marker) are machine-readable gates that downstream phases check before proceeding
- **Domain-specific rules** (INFRA footguns, type invariant verification, sibling pattern sweeps) encode institutional memory directly into the prompt

---

## Contributing

The pipeline dogfoods itself. Bug reports, improvements, and new command specs all flow through `/work-on`. See [CONTRIBUTING.md](https://github.com/RapierCraftStudios/ForgeDock/blob/main/CONTRIBUTING.md) and [devdocs/project/architecture.md](https://github.com/RapierCraftStudios/ForgeDock/blob/main/devdocs/project/architecture.md) for the full strategic context.
