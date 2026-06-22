---
layout: home
title: ForgeDock
titleTemplate: Autonomous AI Development Pipeline

hero:
  name: ForgeDock
  text: Autonomous AI Development Pipeline
  tagline: Open a GitHub issue, type /work-on — an AI agent investigates, builds, reviews, and merges. No manual coordination.
  image:
    src: https://avatars.githubusercontent.com/in/3731547?s=200
    alt: ForgeDock
  actions:
    - theme: brand
      text: Quick Start
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/RapierCraftStudios/ForgeDock

features:
  - icon: 🔁
    title: Full Pipeline Automation
    details: /work-on investigates the issue, architects a fix, builds it, runs a 14-category quality gate, opens a PR, reviews it with 9 domain agents, and merges. One command.
  - icon: 🧠
    title: Persistent Agent Memory
    details: FORGE annotations on GitHub issues and PRs survive context resets and session boundaries. Every agent picks up exactly where the last one left off — no re-investigation.
  - icon: 🔍
    title: 9 Specialist Review Agents
    details: Security, billing, database, concurrency, auth, frontend, API, performance, and infrastructure agents review every PR. Critical findings become tracked issues automatically.
  - icon: ⚡
    title: Zero Infrastructure
    details: Just npx forgedock. Symlinks 25+ slash commands into Claude Code. No server, no service, no subscription. You pay your normal Anthropic API usage.
---

## Install

```bash
npx forgedock
```

Requires: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Node.js 18+, [GitHub CLI](https://cli.github.com/), [`yq`](https://github.com/mikefarah/yq).

---

## How It Works

```
/work-on 42
  → Phase 1: Investigates root cause (git blame, domain context, related issues)
  → Phase 2: Architects the fix (traces all affected code paths)
  → Phase 3: Builds in an isolated git worktree (14-category quality gate)
  → Phase 4: Opens a PR targeting your staging branch
  → Phase 5: 9 domain-specialist agents review the PR
  → Phase 6: Merges, closes the issue, cleans up the worktree
```

Every phase writes structured `FORGE:` annotations to GitHub. If the session compacts or restarts, the next agent reads those annotations and continues from where the last one left off.

---

## Learn More

| Page | What You'll Learn |
|------|-------------------|
| [Quick Start](./getting-started) | Install ForgeDock, configure forge.yaml, run your first pipeline |
| [How It Works](./how-it-works) | FORGE annotations, the knowledge graph, compaction resilience |
| [Command Reference](./command-reference) | All 25+ commands with usage and examples |
| [Configuration](./configuration) | forge.yaml schema — every field explained |
| [Architecture](./architecture) | Pipeline stages, FORGE annotation types, design decisions |
| [ForgeDock vs. Manual Workflows](./vs-manual-workflows) | Why structured pipelines beat ad-hoc Claude Code sessions |
