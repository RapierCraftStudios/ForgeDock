<div align="center">

<img src="https://avatars.githubusercontent.com/in/3731547?s=200&u=b38eba537e011502c010d4b682d641f802591845&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>Give Claude Code a memory that survives every session.</strong></p>

<p>ForgeDock turns GitHub into a persistent knowledge graph for AI agents. Every pipeline stage writes structured annotations to issues and PRs — so the next agent always knows what happened, why the code looks this way, and what to do next.</p>

<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/dm/forgedock?label=npm%20downloads&style=flat-square&color=CB3837" alt="npm downloads/month" /></a>&nbsp;
<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/v/forgedock?style=flat-square&color=CB3837" alt="npm version" /></a>&nbsp;
<a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/forgedock?style=flat-square&color=339933" alt="node version" /></a>&nbsp;
<a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Built%20for-Claude%20Code-7C3AED?style=flat-square" alt="Claude Code" /></a>
<br />
<a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat-square" alt="License: AGPL-3.0" /></a>&nbsp;
<a href="https://github.com/RapierCraftStudios/ForgeDock/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs Welcome" /></a>&nbsp;
<a href="https://github.com/sponsors/RapierCraftStudios"><img src="https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa.svg?style=flat-square" alt="Sponsor" /></a>

<br /><br />

<img src="docs/demo.gif" alt="ForgeDock demo — parallel orchestration across 15+ issues" width="900" />

<p><em>15+ issues orchestrated in parallel — investigated, built, reviewed, and shipped autonomously.</em></p>

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
[![Built with ForgeDock](https://img.shields.io/badge/Built_with-ForgeDock-7C3AED?style=for-the-badge)](https://github.com/RapierCraftStudios/ForgeDock)
```

[![Built with ForgeDock](https://img.shields.io/badge/Built_with-ForgeDock-7C3AED?style=for-the-badge&logo=data:image/png;base64,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&logoColor=white)](https://github.com/RapierCraftStudios/ForgeDock)

---

## Contributing

PRs welcome. Every change goes through a PR, tested against 3+ scenarios, using conventional commits (`fix(command):`, `feat(command):`, `refactor(command):`).

## License

[AGPL-3.0](LICENSE) — free to use, modify, and distribute. If you modify ForgeDock and offer it as a service, you must open-source your modifications under the same license.

---

<div align="center">
<p>Built by <a href="https://github.com/RapierCraftStudios">RapierCraft Studios</a></p>
</div>
