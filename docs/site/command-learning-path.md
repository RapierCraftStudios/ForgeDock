---
title: "ForgeDock Command Learning Path"
description: "A tiered learning path for ForgeDock's slash commands. Learn the 3 essential commands first, then add observe-&-recover, ops, and advanced commands as you need them."
keywords: ["claude code commands guide", "forgedock learning path", "claude code getting started", "which claude code commands to learn", "ai pipeline commands"]
---

# Command Learning Path

ForgeDock installs many slash commands. You do **not** need to learn them all. Most of the time you'll use three.

This page tiers every command by *when you need it* — so you can start small and add commands as your workflow grows. For a full domain-grouped lookup of every command, see the [Complete Command Reference](./command-reference.md).

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

## Tier 1 — Core Loop

**When you need this:** Day 1. This is the minimum viable ForgeDock.

| Command | What it does |
|---------|-------------|
| `/work-on #N` | Pick up an issue and run the full pipeline: investigate → build → review → merge |
| `/issue` | Create a well-structured issue the pipeline can consume reliably |
| `/review-pr` | Review a PR with context-aware, domain-specialist agents |
| `/quality-gate` | Pre-commit checks, gated by the domains your change actually touches |
| `/test-gate` | Acceptance verification against running code before anything deploys |

With just these, you can ship a change end-to-end: write an issue, run it, review the result, and verify it works before it ships.

---

## Tier 2 — Team Workflows

**When you need this:** Week 1, once you're running more than one issue at a time or coordinating work across a milestone.

| Command | What it does |
|---------|-------------|
| `/orchestrate` | Run multiple issues — or an entire milestone — in parallel |
| `/milestone` | Plan, track, and ship a milestone |
| `/deploy-info` | See what will deploy next: staging vs. main diff with risk assessment |
| `/scope` | Estimate issue complexity before committing to `/work-on` |
| `/adopt` | Bootstrap an existing repo's backlog into pipeline-ready issues |

These commands scale ForgeDock from "one issue at a time" to "a planned body of work moving in parallel."

---

## Tier 3 — Observe & Recover

**When you need this:** As soon as you have multiple pipeline runs in flight or your first interrupted run. These are the durable-state commands — the most differentiating part of ForgeDock's architecture.

| Command | What it does |
|---------|-------------|
| `/pipeline-status` | Fleet view of every in-flight issue, straight from workflow labels |
| `/pipeline-resume` | Resume an interrupted run from whatever state GitHub reports |
| `/diagnose` | Trace why a run failed, from its annotations |
| `/explain` | Translate the FORGE annotations on any issue into plain language |
| `/replay` | Replay a past run's full audit trail |
| `/changelog` | Release notes assembled from merged PRs and trajectory receipts |

These commands turn ForgeDock's event-sourced run log and FORGE annotation trail into something you can inspect, recover from, and communicate about — crash-safe pipelines that can always resume, and audit trails that any teammate can read.

---

## Tier 4 — Operations

**When you need this:** When something goes wrong in production, or when you're shipping a release.

| Command | What it does |
|---------|-------------|
| `/rollback` | Create a revert PR to roll back a shipped feature or fix |
| `/incident-response` | Coordinate a P0 incident: hotfix validation, timeline, postmortem |
| `/security-audit` | Run a periodic security posture audit |
| `/autopilot` | Autonomous improvement cycle: recon → triage → fix |
| `/cleanup` | Sweep stale issues, branches, and worktrees |

You'll reach for these occasionally, not daily — but you'll be glad they exist the moment you need them.

---

## Tier 5 — Pipeline Tuning

**When you need this:** Advanced. Once ForgeDock is part of your daily workflow and you want to make the pipeline itself faster and smarter.

| Command | What it does |
|---------|-------------|
| `/pipeline-health` | Self-analysis: measure pipeline performance and propose improvements |
| `/optimize` | Generate adaptive scripts to speed up repeated pipeline work |
| `/ci-audit` | Audit CI workflows for missing stack-specific validation checks |
| `/compat-audit` | Check Claude Code version compatibility with ForgeDock features |

These commands turn ForgeDock on itself — measuring, debugging, and tuning the pipeline you run every day.

---

## Extras / Project-Specific

**When you need this:** Only if your project is a public web property with analytics platforms (GSC, GA4, Umami, Cloudflare, Stripe, Clarity) configured in `forge.yaml`.

| Command | What it does |
|---------|-------------|
| `/analytics` | Pull production analytics from multiple sources and create issues |
| `/qa-sweep` | Browser-automated QA sweep across your web app (requires Playwright MCP) |
| `/geo-audit` | Check AI referral traffic and GEO compliance for your pages |
| `/audit-agents` | Analyze per-agent performance from large `/orchestrate` runs |

These ship with ForgeDock but are not general-purpose pipeline commands. If your project is a backend service, CLI tool, or library, these have nothing to act on.

---

## How to grow your toolkit

1. **Start with the Tier 1 commands.** Ship one issue end-to-end.
2. **Add Tier 2 when you have more than one thing in flight.** Orchestrate a milestone instead of babysitting issues one by one.
3. **Add Tier 3 when you hit your first interrupted run or want visibility into in-flight work.** These are the observe-and-recover commands — they make the pipeline resilient and readable.
4. **Reach for Tier 4 only when operations demand it** — a bad deploy, an incident, a release.
5. **Explore Tier 5 once the pipeline is routine** and you want it faster and self-tuning.

You never have to memorize the full command set. Learn the next tier the day you need it.

---

## Next Steps

- [Getting Started with ForgeDock in 5 Minutes](./getting-started.md) — install and run your first pipeline
- [Complete Command Reference](./command-reference.md) — every command, grouped by domain, with usage and examples
- [How ForgeDock's Knowledge Graph Works](./how-it-works.md) — understand how commands share context
- [ForgeDock vs. Manual Claude Code Workflows](./vs-manual-workflows.md) — why structured commands beat ad-hoc prompting
