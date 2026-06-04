<div align="center">

<img src="https://avatars.githubusercontent.com/in/3731547?s=200&u=b38eba537e011502c010d4b682d641f802591845&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>Autonomous AI development pipeline for Claude Code.</strong></p>

<p>Issue in. PR out. Merged.</p>

<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
<a href="https://github.com/RapierCraftStudios/forgedock/stargazers"><img src="https://img.shields.io/github/stars/RapierCraftStudios/forgedock?style=social" alt="GitHub Stars" /></a>
<a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet" alt="Claude Code" /></a>
<a href="https://github.com/RapierCraftStudios/forgedock/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>

</div>

<br />

```
You:        /work-on #42
ForgeDock:  Investigates → Architects → Builds → Quality gates → Reviews → Opens PR
You:        *click merge*
```

<!-- GIF demo goes here -->

---

## Why ForgeDock?

Most AI coding tools are **assistants** — you prompt, they respond, you verify. You are the pipeline.

ForgeDock is a **pipeline** — you point it at an issue, it ships a reviewed PR. 20+ orchestrated commands, 9 specialized review agents, and a self-improving feedback loop. Battle-tested across 370+ commits on production codebases.

The key difference: **GitHub is the context layer.** Every pipeline stage writes structured annotations to issues and PRs. Every downstream agent reads what came before. Nothing is lost between conversations.

| GitHub Issue | GitHub PR |
| --- | --- |
| `FORGE:INVESTIGATION` — root cause analysis | `FORGE:REVIEW` — per-agent domain findings |
| `FORGE:CONTRACT` — build plan | `FORGE:QUALITY_GATE` — static analysis results |
| `FORGE:DECOMPOSED` — ordered sub-issues | `FORGE:GATE_FAILURE` — deploy blocker details |
| `FORGE:BUILDER` — implementation notes | **Review-finding issues** — linked, tracked, resolved |

Agents don't start from scratch. The builder reads the investigation. The reviewer reads the builder's contract. Context accumulates across the pipeline instead of being lost between conversations. Failed runs leave a full audit trail — not a blank terminal.

---

## Install

```bash
git clone https://github.com/RapierCraftStudios/forgedock.git
cd forgedock
./install.sh
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [GitHub CLI](https://cli.github.com/). ForgeDock reads your project's `CLAUDE.md` for conventions — no extra config needed.

---

## Commands

| Command | What it does |
| --- | --- |
| **`/work-on`** | Full issue lifecycle: investigate, build, quality gate, review, merge |
| `/issue` | Creates pipeline-ready GitHub issues |
| `/orchestrate` | Decomposes milestones into waves, runs `/work-on` in parallel |
| `/review-pr` | Context-aware PR review with 9 specialized agents |
| `/quality-gate` | Pre-commit static analysis |
| `/milestone` | Create, manage, and ship milestones |
| `/deploy-info` | Staging vs main diff with risk assessment |
| `/review-pr-staging` | Comprehensive staging-to-main review gate |
| `/rollback` | Automated revert PR for production incidents |
| `/incident-response` | P0 coordination: hotfix, timeline, postmortem |
| `/pipeline-health` | Self-analysis: measures performance, proposes improvements |
| `/autopilot` | Autonomous improvement cycle |
| `/security-audit` | 4-phase security posture audit |
| `/cleanup` | Sweeps stale issues, branches, worktrees |
| `/analytics` | Pull metrics from GSC, Clarity, Umami, Stripe, and more |
| `/qa-sweep` | Full platform QA via browser automation |

---

## How the Pipeline Works

```
Issue --> Investigate --> Build --> Quality Gate --> Review --> Merge
  |            ^  |         ^  |          ^  |         ^  |        |
  +-- writes --+  +- reads -+  +- reads --+  +- reads-+  +-writes-+
```

1. **Investigate** — explores codebase, finds root cause, posts findings to the issue
2. **Decompose** — breaks complex issues into ordered sub-issues when needed
3. **Architect** — traces affected code paths, produces implementation plan
4. **Build** — writes code, makes commits, posts contract to the issue
5. **Quality Gate** — static analysis catches defects before review
6. **Review** — domain-specific agents review billing, auth, DB, API, security
7. **Merge** — opens PR with full context, ready for human approval

The pipeline **self-improves**: `/pipeline-health` correlates prompt changes with review findings, build failures, and merge rates — then proposes its own fixes. False positive rate dropped from 44% to under 10% through this loop.

---

## Contributing

PRs welcome. Every change goes through a PR, tested against 3+ scenarios, using conventional commits (`fix(command):`, `feat(command):`, `refactor(command):`).

## License

[MIT](LICENSE)

---

<div align="center">

<p>Built by <a href="https://github.com/RapierCraftStudios">RapierCraft Studios</a></p>

</div>
