---
title: "How ForgeDock's Knowledge Graph Works"
description: "Deep dive into how ForgeDock uses GitHub as a persistent AI agent memory system. FORGE annotations, context passing, and cross-issue knowledge explained."
keywords: ["ai agent memory", "ai agent knowledge graph", "forge annotations", "claude code memory", "ai agent context"]
---

# How ForgeDock's Knowledge Graph Works

Every AI coding agent faces the same fundamental problem: **it forgets everything between sessions.**

When a conversation ends or context compacts, the agent loses all the context it gathered — why the code looks the way it does, which approaches were already tried, which files are connected. The next session starts from scratch.

ForgeDock solves this by treating GitHub as a persistent, structured memory system that every agent can read and write.

---

## The Core Insight: GitHub Is Already a Knowledge Graph

Your repository already contains everything an agent needs to know:

- **Issues** — what problems were reported and why
- **Pull requests** — what was changed and the reasoning behind it
- **Commits** — the exact changes, with references back to issues
- **Comments** — investigator notes, architectural decisions, review findings
- **Labels** — current workflow state at a glance
- **Blame** — who changed each line and when, tracing back to the originating issue

These aren't just records for humans. They're **queryable, structured data** that an agent can use as memory.

ForgeDock adds the coordination layer that makes agents use this data systematically.

---

## FORGE Annotations: Machine-Readable Comments

The key mechanism is **FORGE annotations** — structured HTML comment blocks posted to GitHub issues and PRs at every pipeline stage.

Each annotation has a type that identifies which pipeline agent wrote it and what it contains:

```
<!-- FORGE:INVESTIGATOR -->   Root cause, affected files, confidence level
<!-- FORGE:CONTRACT -->       What will be built — deliverables, acceptance criteria
<!-- FORGE:ARCHITECT -->      Implementation plan — file order, consistency checks, risks
<!-- FORGE:CONTEXT -->        Historical pitfalls, past bugs, patterns to avoid
<!-- FORGE:BUILDER -->        What was built — commits, files changed, criteria status
<!-- FORGE:REVIEWER -->       Review findings — severity, pattern, prevention rule
<!-- FORGE:TRAJECTORY -->     Full audit trail — every phase, every decision
```

Every downstream agent reads these before starting work. The builder reads the investigator's root cause analysis. The reviewer reads the builder's implementation notes. The architect reads the context agent's historical findings.

**The result**: agents that follow structured data, not guesses.

---

## The Pipeline: A Relay Race

When you run `/work-on 42`, ForgeDock runs a sequential pipeline where each stage hands off structured context to the next:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     GITHUB (Knowledge Graph)                        │
│                                                                     │
│  Issues:  FORGE:INVESTIGATOR → FORGE:CONTRACT → FORGE:ARCHITECT     │
│           → FORGE:CONTEXT → FORGE:BUILDER → FORGE:TRAJECTORY        │
│                                                                     │
│  PRs:     FORGE:REVIEWER (9 domain agents)                          │
│                                                                     │
│  Labels:  workflow:investigating → workflow:building →              │
│           workflow:in-review → workflow:merged                      │
│                                                                     │
│  Every agent reads this. Every agent writes to it.                  │
│  Nothing is lost between conversations.                             │
└─────────────────────────────────────────────────────────────────────┘
```

### Stage 1: Investigation

The investigator agent reads the issue, explores the relevant code files, traces git blame, and searches for related issues. It posts a `<!-- FORGE:INVESTIGATOR -->` comment containing:

- **Verdict**: CONFIRMED, PARTIAL, or INVALID
- **Root Cause**: specific file:line references
- **Affected Files**: complete list of what needs to change
- **Evidence**: function names, behavior observed
- **Decomposition Assessment**: whether to split into sub-issues

### Stage 2: Architecture

Before writing any code, the architect agent traces all affected code paths, identifies data flow, and checks for consistency invariants. This prevents the most common build failures — missing callers, type mismatches, broken imports.

The `<!-- FORGE:ARCHITECT -->` comment contains an ordered implementation plan. The builder follows this exactly.

### Stage 3: Context Gathering

The context agent surfaces **institutional memory** — past review findings on the same files, historical bugs in the same module, patterns that have caused bugs before. This is the agent equivalent of asking a senior engineer "what should I know before touching this?"

### Stage 4: Build

The builder reads the architecture plan and implements in the specified order. It works in an isolated git worktree (not the main repo checkout) to avoid interfering with other in-flight work.

### Stage 5: Quality Gate

Before committing, the quality gate runs 14+ checks covering: security, SQL safety, auth model, env var completeness, frontend proxy wiring, deployment config, and more. The builder iterates until the gate passes (max 3 iterations).

### Stage 6: Review

Nine specialized review agents examine the PR simultaneously: security, business logic, frontend, backend, database, infrastructure, documentation, test coverage, and dependency audit. Each finding becomes a separate GitHub issue that flows through the same pipeline.

---

## Compaction Resilience: The Agent Can Always Resume

Claude Code sessions have context limits. When a session compacts, the in-memory state is lost. ForgeDock is designed for this.

**The rule**: Write state to GitHub after every significant step. Re-read GitHub state at the start of every phase.

When a new session runs `/work-on 42`, it:

1. Reads the issue body and all comments
2. Checks existing FORGE annotations to determine the current phase
3. Reads the workflow label (`workflow:investigating`, `workflow:building`, etc.)
4. Picks up exactly where the last session left off

A new agent session running `/work-on 42` should always know what to do next by reading GitHub state alone — with no reliance on any in-memory context from previous sessions.

---

## Labels as State Machine

GitHub labels track the workflow state of every issue. The pipeline reads these labels to determine what to do next. A human can also manually set a label to nudge the pipeline or override its routing.

> **Label reference**: [`docs/spec/label-state-machine.md`](https://github.com/RapierCraftStudios/ForgeDock/blob/main/docs/spec/label-state-machine.md) — full state table, transition rules, and terminal labels.

---

## Cross-Issue Knowledge: How History Informs the Present

When the context agent runs for a new issue, it searches for:

1. **Past review findings on the same files** — issues labeled `review-finding` that mention the affected filenames
2. **Past bugs in the same module** — closed bug issues found by mining `git log` references on the affected files
3. **Related code paths** — callers and importers of the functions being changed

This means that every bug that gets fixed, and every review finding that gets filed, makes the pipeline smarter for future work on the same codebase.

---

## forge.yaml: The Configuration Layer

The `forge.yaml` file in your repo root tells ForgeDock how your project is structured:

```yaml
project:
  name: "My App"
  owner: "my-github-org"
  repo: "my-app"

paths:
  root: "/path/to/repo"
  worktree_base: "/path/to/worktrees"

branches:
  staging: "staging"          # Fast-lane PR target
  default: "staging"
  feature_pattern: "milestone/{slug}"  # Milestone-gated feature lane

project_board:
  owner: "my-github-org"
  project_number: 1
```

ForgeDock resolves this once at the start of every pipeline run. Every `gh` command uses the correct repo. Every branch creation targets the correct base.

---

## Next Steps

- [Getting Started with ForgeDock in 5 Minutes](./getting-started.md) — run your first pipeline
- [ForgeDock vs. Manual Claude Code Workflows](./vs-manual-workflows.md) — why this beats ad-hoc prompting
- [The FORGE Annotation Protocol](./forge-annotation-protocol.md) — technical spec for FORGE annotations
- [Complete Command Reference](./command-reference.md) — all 25 commands
