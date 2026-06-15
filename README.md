<div align="center">

<img src="https://avatars.githubusercontent.com/in/3731547?s=200&u=b38eba537e011502c010d4b682d641f802591845&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>Give Claude Code a memory that survives every session.</strong></p>

<p>ForgeDock turns GitHub into a persistent knowledge graph for AI agents. Every pipeline stage writes structured annotations to issues and PRs — so the next agent always knows what happened, why the code looks this way, and what to do next.</p>

<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/dm/forgedock?label=npm%20downloads&color=CB3837" alt="npm downloads/month" /></a>
<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/v/forgedock?color=CB3837" alt="npm version" /></a>
<a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/forgedock?color=339933" alt="node version" /></a>
<a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Built%20for-Claude%20Code-7C3AED" alt="Claude Code" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
<a href="https://github.com/RapierCraftStudios/ForgeDock/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
<a href="https://github.com/sponsors/RapierCraftStudios"><img src="https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa.svg" alt="Sponsor" /></a>

<br /><br />

<img src="docs/demo.gif" alt="ForgeDock demo — issue to merged PR in one command" width="900" />

<p><em>One command. Issue to merged PR — investigated, built, reviewed, and shipped.</em></p>

</div>

<br />

## Why ForgeDock

AI coding agents forget everything between sessions. They re-investigate the same bugs, miss context from past PRs, and make mistakes that were already caught and fixed last week. There's no institutional memory.

ForgeDock fixes this by using **GitHub itself** as the memory layer. Every pipeline stage writes structured `FORGE:` annotations to issues and PRs. Every downstream agent reads them. When a new session starts — even after compaction — the agent queries GitHub and picks up exactly where the last one left off.

**The result:** agents that follow structured data instead of guessing.

---

## What You Get

| Capability | How it works |
|---|---|
| **Full-lifecycle automation** | `/work-on #42` — investigates the issue, architects a fix, builds it, runs quality gates, opens a PR, and reviews it. You click merge. |
| **Persistent agent memory** | Structured `FORGE:` annotations on GitHub issues/PRs survive compaction and session boundaries. Agents never start blind. |
| **9 specialist review agents** | Security, billing, database, concurrency, auth, frontend, API, performance, infrastructure — every PR gets domain-expert review. |
| **Cross-issue knowledge graph** | Agent fixing issue #43 reads the investigation from #42 and applies the known pattern — no re-investigation. |
| **Self-improving pipeline** | False positive rate dropped from 44% to under 10% through automated feedback loops. |
| **Parallel orchestration** | `/orchestrate` decomposes milestones into waves and runs `/work-on` on each in parallel. |

---

## Install

**Requirements:** [Node.js 18+](https://nodejs.org/) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

```bash
# Install pipeline commands (symlinks into ~/.claude/commands/)
npx forgedock

# Generate config for your repo
npx forgedock init
```

That's it. Open Claude Code in your project and run `/work-on #42`.

<details>
<summary><strong>Other install methods & commands</strong></summary>

**Claude Code Plugin Marketplace** (v2.1.143+):
```
/plugin marketplace add RapierCraftStudios/ForgeDock
/plugin install forgedock@forgedock
```

**CLI commands:**
```bash
npx forgedock update       # Pull latest commands
npx forgedock uninstall    # Remove all ForgeDock commands from ~/.claude/commands/
npx forgedock help         # Show all available commands
```

**AI-powered setup** (inside Claude Code):
```
/forgedock-init            # Guided config walkthrough — scans your repo, queries GitHub, auto-fills forge.yaml
```

</details>

---

## How It Works

```
Issue → Investigate → Architect → Build → Quality Gate → Review → Merge
              ↓            ↓         ↓          ↓            ↓
        writes to     reads from  reads from  reads from   writes to
         GitHub        GitHub      GitHub      GitHub       GitHub
```

Each stage writes a structured annotation (`<!-- FORGE:INVESTIGATOR -->`, `<!-- FORGE:CONTRACT -->`, etc.) to the GitHub issue or PR. Each downstream stage reads what came before. The `gh` CLI is the query interface.

| Stage | What it does |
|---|---|
| **Investigate** | Traces root cause via `git blame`, related issues/PRs. Writes verdict, affected files, severity. |
| **Context** | Surfaces historical bugs and known pitfalls from the same module. Institutional memory. |
| **Architect** | Produces ordered implementation plan with exact file/function/line targets. |
| **Build** | Writes code, creates branch, makes commits. Follows the architect's plan. |
| **Quality Gate** | 14+ domain-specific checks (security, auth, DB, concurrency, etc.) |
| **Review** | 9 specialist agents review the PR diff with confidence-rated findings. |
| **Close** | Records full audit trail as `FORGE:TRAJECTORY`. |

Labels track workflow state (`workflow:investigating`, `workflow:building`, `workflow:in-review`, `workflow:merged`). The pipeline resumes from whatever state GitHub says it's in — restart-safe by design.

<details>
<summary><strong>Example: Full pipeline run</strong></summary>

Issue #42: *"POST /api/payments returns 500 for free-tier users."*

```
FORGE:INVESTIGATOR  →  Traced bug to commit e8f21a3 (PR #38). Payment validation
                        assumed all users have a billing profile — free-tier users don't.

FORGE:CONTEXT       →  Surfaced 2 historical bugs in the same module:
                        #29 (nil-check on subscription lookup) and
                        #34 (billing profile race condition). Known pitfall:
                        don't skip audit log write on early returns.

FORGE:ARCHITECT     →  2-file fix: nil-check in payment validator,
                        free-tier guard in the API router.

FORGE:BUILDER       →  Branch fix/payment-validation-free-tier-42, 2 files changed.

FORGE:REVIEW        →  4 review agents, 0 findings, auto-merged to staging.
```

The context phase caught the audit log pitfall from issue #34 — a completely different bug, months earlier, in the same module. That's institutional memory at work.

</details>

---

## Commands

| Command | What it does |
|---|---|
| **`/work-on #N`** | Full issue lifecycle: investigate → build → review → merge |
| `/issue` | Create a pipeline-ready GitHub issue |
| `/orchestrate` | Parallel execution across a milestone's issues |
| `/review-pr` | PR review with 9 domain-specialist agents |
| `/quality-gate` | Pre-commit checks across 14+ domains |
| `/milestone` | Plan and ship milestones |
| `/deploy-info` | Staging vs main diff with risk assessment |
| `/review-pr-staging` | Staging-to-main review gate |
| `/rollback` | Automated revert PR for production incidents |
| `/incident-response` | P0 coordination: hotfix, timeline, postmortem |
| `/autopilot` | Autonomous improvement: recon → triage → fix |
| `/pipeline-health` | Self-analysis and prompt tuning |
| `/security-audit` | 4-phase security posture audit |
| `/qa-sweep` | Full platform QA via browser automation |
| `/analytics` | Pull metrics from GSC, Clarity, Umami, Stripe |
| `/cleanup` | Sweep stale issues, branches, worktrees |

---

## Uninstall

```bash
npx forgedock uninstall
```

This removes all ForgeDock command symlinks from `~/.claude/commands/`. Your `forge.yaml` config and any `FORGE:` annotations on GitHub issues/PRs are left untouched.

To also remove the npm cache:
```bash
npx forgedock uninstall
npm cache clean --force
```

---

## Documentation

- [Getting Started in 5 Minutes](docs/site/getting-started.md) — install, configure, first pipeline run
- [How the Knowledge Graph Works](docs/site/how-it-works.md) — FORGE annotations, context relay, compaction resilience
- [ForgeDock vs. Manual Workflows](docs/site/vs-manual-workflows.md) — structured pipelines vs. ad-hoc prompting
- [FORGE Annotation Protocol](docs/site/forge-annotation-protocol.md) — open standard spec for AI context passing
- [Command Reference](docs/site/command-reference.md) — all 25+ commands with usage and examples

---

## Show Your Support

Add a badge to your README:

```markdown
[![Built with ForgeDock](https://img.shields.io/badge/Built_with-ForgeDock-blue?logo=github)](https://github.com/RapierCraftStudios/ForgeDock)
```

[![Built with ForgeDock](https://img.shields.io/badge/Built_with-ForgeDock-blue?logo=github)](https://github.com/RapierCraftStudios/ForgeDock)

---

## Contributing

PRs welcome. Every change goes through a PR, tested against 3+ scenarios, using conventional commits (`fix(command):`, `feat(command):`, `refactor(command):`).

## License

[AGPL-3.0](LICENSE) — free to use, modify, and distribute. If you modify ForgeDock and offer it as a service, you must open-source your modifications under the same license.

---

<div align="center">
<p>Built by <a href="https://github.com/RapierCraftStudios">RapierCraft Studios</a></p>
</div>
