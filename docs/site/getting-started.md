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
- [`yq`](https://github.com/mikefarah/yq) — YAML parser used by all pipeline commands to read `forge.yaml`

**Install `yq`:**

```bash
# macOS
brew install yq

# Ubuntu / Debian
sudo apt-get install yq
# or: sudo snap install yq

# Windows
winget install mikefarah.yq
# or: choco install yq

# Any platform (via Go)
go install github.com/mikefarah/yq/v4@latest
```

> **Note:** Without `yq`, pipeline commands that read `forge.yaml` (including `/work-on`, `/scope`, `/orchestrate`, and most others) will fall back to defaults or skip config-driven steps silently.

---

## Step 1: Install ForgeDock

Run the installer with `npx` from your project directory:

```bash
npx forgedock
```

This installs all 25+ ForgeDock command specs into `~/.claude/commands/` — making them available as slash commands in every Claude Code session on this machine, not just this repo.

> Install is always global. `--global` is still accepted on the command line for backward compatibility, but it's a no-op — `npx forgedock` and `npx forgedock --global` do exactly the same thing.

**Verify the install:**

```bash
npx forgedock doctor
```

`doctor` runs an installation health check across six categories — command symlinks, `forge.yaml`, required tools (`gh`, `yq`, Claude Code), GitHub workflow labels, and Playwright MCP — and prints a pass/fail/warn line with a fix hint for each:

```
ForgeDock Doctor — Installation Health Check

  ✔  Command symlinks  25 symlinks valid
  ✔  gh CLI  installed and authenticated
  ✔  yq  yq (https://github.com/mikefarah/yq/) version v4.x
  ✔  Claude Code  v2.x (compatible, >= v2.0.0)
  ⚠  Playwright MCP  Not registered — needed for /qa-sweep

  All checks passed. ForgeDock installation is healthy.
```

It exits `0` when everything passes and `1` if any check fails, so you can also use it in CI.

> Prefer a quick spot-check? `ls ~/.claude/commands/ | grep -E "work-on|review-pr|quality-gate"` should list `work-on.md`, `review-pr.md`, and `quality-gate.md`.

---

## Step 2: Your Config Is Already There

`npx forgedock` in Step 1 ran the full install journey — including repo detection and a reviewed `forge.yaml` — so there's no separate config step to run. If you need to redo detection later (moved the repo, renamed a branch), or want a leaner config with just the required sections, re-run:

```bash
cd /path/to/your/project
npx forgedock init --minimal
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
  worktree_base: "/path/to/my-app/.forgedock/worktrees"

branches:
  default: "main"
  staging: "staging"
  feature_pattern: "milestone/{slug}"
```

That's the whole config. Run `npx forgedock doctor` to confirm it's valid.

> **The three required sections are `project`, `paths`, and `branches`** — `npx forgedock init --minimal` auto-detects `paths` for you (so worktrees land in the right place) and you rarely need to touch it. Everything else (project board, review context, verification commands, multi-repo routing) is optional and falls back to sensible defaults. Browse [`forge.yaml.example`](https://github.com/RapierCraftStudios/ForgeDock/blob/main/forge.yaml.example) and [`docs/CONFIG.md`](https://github.com/RapierCraftStudios/ForgeDock/blob/main/docs/CONFIG.md) when you're ready to customize.

**Prefer guided, AI-powered setup?** Open Claude Code in your project directory and run `/forgedock-init` instead — it scans your repo and fills in the optional sections (repo owner/name, worktree path, branch strategy, project board) for you.

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

- [Command Learning Path](./command-learning-path.md) — which commands to learn next, tiered by when you need them
- [How ForgeDock's Knowledge Graph Works](./how-it-works.md) — understand the architecture
- [What Are Those FORGE Comments?](./annotations-explained.md) — a 2-minute explainer for the annotations on your issues
- [ForgeDock vs. Manual Claude Code Workflows](./vs-manual-workflows.md) — why this beats ad-hoc prompting
- [Complete Command Reference](./command-reference.md) — all 25 commands with examples
- [Troubleshooting & Recovery Guide](./troubleshooting.md) — diagnose and recover from common pipeline failures

---

## Troubleshooting

The quick fixes below cover the most common first-run issues. For the full list of failure modes — quality gate failures, worktree conflicts, stale labels, rate limits, and more — see the [Troubleshooting & Recovery Guide](./troubleshooting.md).

**`/work-on` not found in Claude Code**

The symlink wasn't created. Re-run `npx forgedock` and check `ls ~/.claude/commands/`.

**`forge.yaml` not found**

Run `npx forgedock init` in your project directory to generate it, or copy `forge.yaml.example` from the ForgeDock repo and edit it. Once it exists, `/forgedock-init` inside Claude Code can fill in the optional sections.

**`gh` auth errors**

Run `gh auth login` and complete the OAuth flow. ForgeDock uses `gh` for all GitHub operations.

**Pipeline stops at investigation**

The issue may have been marked `workflow:invalid`. Check the issue comments for the investigation report — it will explain why.

---

## A note on install location

ForgeDock briefly shipped a project-scoped-by-default install mode. It was backed out after causing a "split-brain" bug (`doctor`/`status` assumed project-scoped while the installer still wrote globally — [#1589](https://github.com/RapierCraftStudios/ForgeDock/issues/1589)), so install has always been global (`~/.claude/commands/`) since. If you have scripts or CI that still pass `--global`, there's nothing to change — it's accepted for backward compatibility and does exactly what a plain `npx forgedock` does.

```bash
npx forgedock update           # re-link after a version bump
npx forgedock doctor           # confirm the install is healthy
npx forgedock status           # shows the install path (~/.claude/commands/)
```
