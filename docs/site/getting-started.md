---
title: "Getting Started with ForgeDock in 5 Minutes"
description: "Install ForgeDock and run your first autonomous Claude Code pipeline in under 5 minutes. Complete tutorial: install, configure, and ship your first issue."
keywords: ["claude code commands setup", "forgedock install", "claude code pipeline", "ai agent setup"]
---

# Getting Started with ForgeDock in 5 Minutes

ForgeDock turns GitHub issues into shipped code — automatically. You open an issue, type one command, and an AI agent investigates it, writes the fix, runs a quality gate, opens a PR, reviews it, and merges it.

This tutorial gets you from zero to your first autonomous pipeline run in under 5 minutes.

---

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Git and GitHub CLI (`gh`) installed and authenticated (`gh auth login`)
- Node.js 18 or higher

---

## Step 1: Install ForgeDock

Run the installer with `npx`:

```bash
npx forgedock
```

This symlinks all 25+ ForgeDock command specs into `~/.claude/commands/` — making them available as slash commands in every Claude Code session.

**Verify the install:**

```bash
ls ~/.claude/commands/ | grep -E "work-on|review-pr|quality-gate"
```

You should see `work-on.md`, `review-pr.md`, and `quality-gate.md`.

---

## Step 2: Your Config Is Already There

`npx forgedock` in Step 1 already detected your repo and walked you through a reviewed `forge.yaml` — there's no separate config step to run. If you need to redo detection later (moved the repo, renamed a branch), just re-run:

```bash
cd /path/to/your/project
npx forgedock init
```

**Optional: enrich the config.** Once `forge.yaml` exists, open Claude Code in your project directory and run `/forgedock-init` to fill in the optional sections that plain detection can't infer:

- Project board connection (GitHub Projects v2)
- Satellite repo routing (multi-repo setups)
- Review context (tech stack, known pitfalls)
- Service URLs for health checks

`/forgedock-init` completes an existing `forge.yaml` — it won't create one from scratch.

**Minimal `forge.yaml` example:**

```yaml
project:
  name: "My App"
  owner: "my-github-org"
  repo: "my-app"

paths:
  root: "/path/to/my-app"
  worktree_base: "/path/to/my-app/.claude/worktrees"

branches:
  staging: "staging"
  default: "staging"
```

---

## Step 3: Open an Issue

Create a GitHub issue for something real in your repo — a bug, a feature, a refactor. ForgeDock works best with issues that have:

- A clear problem description
- Expected behavior
- Acceptance criteria

You can create one manually on GitHub, or use:

```bash
/issue "The login button is misaligned on mobile Safari"
```

Note the issue number — let's say it's `#42`.

---

## Step 4: Run Your First Pipeline

Open Claude Code in your project directory and run:

```bash
/work-on 42
```

That's it. ForgeDock now:

1. **Investigates** — reads the issue, traces the code, identifies the root cause
2. **Architects** — plans the implementation order, identifies all affected files
3. **Builds** — implements the fix in an isolated git worktree
4. **Quality gates** — checks for 14+ categories of common defects
5. **Reviews** — runs 9 domain-specific review agents (security, logic, UX, etc.)
6. **Merges** — opens a PR and merges it when review passes

---

## Step 5: See the Result

While the pipeline runs, you can watch it in real time on the GitHub issue. ForgeDock writes structured comments at every stage:

```
<!-- FORGE:INVESTIGATOR -->   ← What it found
<!-- FORGE:CONTRACT -->       ← What it will build
<!-- FORGE:ARCHITECT -->      ← Implementation plan
<!-- FORGE:BUILDER -->        ← What was built
<!-- FORGE:TRAJECTORY -->     ← Full audit trail
```

When it's done, you'll have a merged PR, a closed issue, and a complete audit trail in GitHub.

---

## What Just Happened?

ForgeDock uses **GitHub as a knowledge graph**. Every stage writes structured data that the next stage reads. This means:

- A new agent session can pick up exactly where the last one left off
- Review agents can see the full investigation context, not just the diff
- Future issues touching the same code can learn from what was found here

For a deep dive into how this works, read [How ForgeDock's Knowledge Graph Works](./how-it-works.md).

---

## Next Steps

- [How ForgeDock's Knowledge Graph Works](./how-it-works.md) — understand the architecture
- [ForgeDock vs. Manual Claude Code Workflows](./vs-manual-workflows.md) — why this beats ad-hoc prompting
- [Complete Command Reference](./command-reference.md) — all 25 commands with examples

---

## Troubleshooting

**`/work-on` not found in Claude Code**

The symlink wasn't created. Re-run `npx forgedock` and check `ls ~/.claude/commands/`.

**`forge.yaml` not found**

Run `npx forgedock init` in your project directory to generate it, or copy `forge.yaml.example` from the ForgeDock repo and edit it. Once it exists, `/forgedock-init` inside Claude Code can fill in the optional sections.

**`gh` auth errors**

Run `gh auth login` and complete the OAuth flow. ForgeDock uses `gh` for all GitHub operations.

**Pipeline stops at investigation**

The issue may have been marked `workflow:invalid`. Check the issue comments for the investigation report — it will explain why.
