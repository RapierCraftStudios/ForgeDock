---
title: "ForgeDock Command Learning Path"
description: "A tiered learning path for ForgeDock's slash commands. Learn the 3 essential commands first, then add team, operations, and pipeline-tuning commands as you need them."
keywords: ["claude code commands guide", "forgedock learning path", "claude code getting started", "which claude code commands to learn", "ai pipeline commands"]
---

# Command Learning Path

ForgeDock installs 25+ slash commands. You do **not** need to learn them all. Most of the time you'll use three.

This page tiers every command by *when you need it* — so you can start small and add commands as your workflow grows. For an alphabetical, domain-grouped lookup of every command, see the [Complete Command Reference](./command-reference.md).

---

## Start here: 3 commands

If you only learn three commands, learn these. They cover the entire issue-to-merge loop:

```text
/issue       →  describe what you want, get a pipeline-ready issue
/work-on #N  →  investigate, build, review, and merge it automatically
/review-pr   →  review a pull request with domain-specialist agents
```

Everything below is optional and additive. Come back when you hit the situation each tier describes.

---

## Tier 1 — Essential

**When you need this:** Day 1. This is the minimum viable ForgeDock.

| Command | What it does |
|---------|-------------|
| `/work-on #N` | Pick up an issue and run the full pipeline: investigate → build → review → merge |
| `/issue` | Create a well-structured issue the pipeline can consume reliably |
| `/review-pr` | Review a PR with context-aware, domain-specialist agents |

With just these three, you can ship a change end-to-end: write an issue, run it, and review the result.

---

## Tier 2 — Team Workflows

**When you need this:** Week 1, once you're running more than one issue at a time or coordinating work across a milestone.

| Command | What it does |
|---------|-------------|
| `/orchestrate` | Run multiple issues — or an entire milestone — in parallel |
| `/milestone` | Plan, track, and ship a milestone |
| `/deploy-info` | See what will deploy next: staging vs. main diff with risk assessment |
| `/quality-gate` | Run pre-commit quality checks before you push |

These commands scale ForgeDock from "one issue at a time" to "a planned body of work moving in parallel."

---

## Tier 3 — Operations

**When you need this:** When something goes wrong in production, or when you're shipping a release.

| Command | What it does |
|---------|-------------|
| `/rollback` | Create a revert PR to roll back a shipped feature or fix |
| `/incident-response` | Coordinate a P0 incident: hotfix validation, timeline, postmortem |
| `/security-audit` | Run a periodic security posture audit |
| `/changelog` | Generate release notes from merged work |

You'll reach for these occasionally, not daily — but you'll be glad they exist the moment you need them.

---

## Tier 4 — Pipeline Tuning

**When you need this:** Advanced. Once ForgeDock is part of your daily workflow and you want to make the pipeline itself faster and smarter.

| Command | What it does |
|---------|-------------|
| `/autopilot` | Autonomous improvement cycle: recon → triage → fix |
| `/pipeline-health` | Self-analysis: measure pipeline performance and propose improvements |
| `/optimize` | Generate adaptive scripts to speed up repeated pipeline work |
| `/diagnose` | Debug pipeline failures |

These commands turn ForgeDock on itself — measuring, debugging, and tuning the pipeline you run every day.

---

## How to grow your toolkit

1. **Start with the 3 Essential commands.** Ship one issue end-to-end.
2. **Add Tier 2 when you have more than one thing in flight.** Orchestrate a milestone instead of babysitting issues one by one.
3. **Reach for Tier 3 only when operations demand it** — a bad deploy, an incident, a release.
4. **Explore Tier 4 once the pipeline is routine** and you want it faster and self-tuning.

You never have to memorize the full command set. Learn the next tier the day you need it.

---

## Next Steps

- [Getting Started with ForgeDock in 5 Minutes](./getting-started.md) — install and run your first pipeline
- [Complete Command Reference](./command-reference.md) — every command, grouped by domain, with usage and examples
- [How ForgeDock's Knowledge Graph Works](./how-it-works.md) — understand how commands share context
- [ForgeDock vs. Manual Claude Code Workflows](./vs-manual-workflows.md) — why structured commands beat ad-hoc prompting
