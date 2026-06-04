<div align="center">

<img src="https://avatars.githubusercontent.com/u/186507793?v=4" alt="ForgeDock" width="120" />

# ForgeDock

**Autonomous AI development pipeline for Claude Code.**

Issue in. PR out. Merged.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/RapierCraftStudios/forgedock?style=social)](https://github.com/RapierCraftStudios/forgedock/stargazers)
[![Claude Code](https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet)](https://docs.anthropic.com/en/docs/claude-code)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/RapierCraftStudios/forgedock/pulls)

[Get Started](#get-started) · [Commands](#commands) · [How It Works](#how-it-works) · [Contributing](#contributing)

</div>

---

## What is ForgeDock?

ForgeDock turns Claude Code from an AI assistant into an **autonomous engineering team**.

Point it at a GitHub issue. Get back a production-ready, reviewed PR. That's it.

```
You:          "work on issue #42"
ForgeDock:     Investigates → Architects → Builds → Quality gates → Reviews → Opens PR
You:          *click merge*
```

### Without ForgeDock

You write ad-hoc prompts. You manually check the output. You copy-paste context between conversations. You review everything yourself. The AI helps, but **you** are the pipeline.

### With ForgeDock

You point at an issue and walk away. ForgeDock decomposes the problem, investigates the codebase, plans the architecture, writes the code, runs quality checks, spawns specialized review agents, and opens a PR with structured comments. **You just review and merge.**

---

## How It Works

ForgeDock is a collection of **slash commands** that orchestrate Claude Code agents through a structured pipeline.

### GitHub as a Context Layer

Most AI coding tools treat GitHub as a place to push code. ForgeDock treats it as a **secondary context layer** — a persistent, structured memory that agents read from and write to across every stage of the pipeline.

```
GitHub Issue                    GitHub PR
┌────────────────────┐          ┌────────────────────────────┐
│ Issue body          │          │ PR description              │
│ ├─ structured spec  │          │ ├─ implementation summary   │
│ ├─ acceptance criteria│        │ ├─ architecture decisions   │
│ └─ labels/metadata  │          │ └─ linked issue context     │
│                     │          │                              │
│ Comments:           │          │ Comments:                    │
│ ├─ FORGE:INVESTIGATION│        │ ├─ FORGE:REVIEW (per agent) │
│ │  └─ root cause    │          │ │  └─ domain findings       │
│ ├─ FORGE:CONTRACT   │          │ ├─ FORGE:QUALITY_GATE       │
│ │  └─ build plan    │          │ │  └─ static analysis       │
│ ├─ FORGE:DECOMPOSED │          │ └─ FORGE:GATE_FAILURE       │
│ │  └─ sub-issues    │          │    └─ deploy blocker        │
│ └─ FORGE:BUILDER    │          │                              │
│    └─ implementation│          │ Review-finding issues:       │
│       notes         │          │ └─ linked, tracked, resolved │
└────────────────────┘          └────────────────────────────┘
```

**Every agent writes structured annotations.** The investigator posts `FORGE:INVESTIGATION` with root cause findings. The builder posts `FORGE:CONTRACT` with its implementation plan. Review agents post `FORGE:REVIEW` with domain-specific findings. Each annotation uses machine-readable markers (`<!-- FORGE:... -->`) so downstream agents can parse them — not just read them.

**Every agent reads prior context.** The builder doesn't start from scratch — it reads the investigation findings, the architecture plan, and the project's CLAUDE.md. The review agents read the PR diff *and* the original issue *and* the builder's contract comment. Context accumulates across the pipeline instead of being lost between conversations.

**This means:**
- No context is lost between pipeline stages — it's persisted on GitHub
- Any agent can be re-run and it picks up where others left off
- Humans can inspect every decision the pipeline made, in order, on the issue/PR
- The pipeline's own health analysis (`/pipeline-health`) reads these annotations to measure performance
- Failed runs leave a full audit trail — not a blank terminal

This is what makes ForgeDock fundamentally different from "run a prompt and hope." GitHub becomes the shared memory layer that ties autonomous agents into a coherent system.

### The Pipeline

```
┌─────────┐     ┌─────────────┐     ┌─────────┐     ┌──────────────┐     ┌──────────┐     ┌───────┐
│  Issue   │────▶│ Investigate │────▶│  Build  │────▶│ Quality Gate │────▶│  Review  │────▶│ Merge │
└─────────┘     └─────────────┘     └─────────┘     └──────────────┘     └──────────┘     └───────┘
     │                 ▲ │                ▲ │               ▲ │                ▲ │               │
     └── writes ───────┘ └── reads ──────┘ └── reads ─────┘ └── reads ──────┘ └── writes ─────┘
              GitHub comments flow context forward through the pipeline
```

1. **Investigate** — Reads the issue, explores the codebase, finds root cause, posts `FORGE:INVESTIGATION` to the issue
2. **Decompose** — Breaks complex issues into ordered sub-issues when needed, posts `FORGE:DECOMPOSED`
3. **Architect** — Reads investigation findings, traces all affected code paths, produces an implementation plan
4. **Build** — Reads the architecture plan, writes code, posts `FORGE:CONTRACT` and `FORGE:BUILDER` to the issue
5. **Quality Gate** — Pre-commit static analysis, posts `FORGE:QUALITY_GATE` to the PR
6. **Review** — Spawns domain-specific review agents that post `FORGE:REVIEW` findings (billing, auth, DB, API, security, and more)
7. **Merge** — Opens PR with full context linking back to every annotation, ready for human approval

### Self-Improving

ForgeDock measures its own performance. `/pipeline-health` correlates prompt changes with review findings, build failures, and merge rates — then proposes improvements. The pipeline gets better the more you use it.

---

## Commands

### Core Pipeline

| Command | What it does |
|---------|-------------|
| `/work-on` | **The main command.** Full issue lifecycle: investigate → build → review → merge |
| `/issue` | Creates well-structured GitHub issues the pipeline can consume |
| `/orchestrate` | Decomposes milestones into waves, runs `/work-on` in parallel |
| `/review-pr` | Context-aware PR review with 9 specialized review agents |
| `/quality-gate` | Pre-commit quality check — catches defects before review |
| `/milestone` | Create, manage, and ship milestones |

### Operations

| Command | What it does |
|---------|-------------|
| `/deploy-info` | Pre-deploy summary: staging vs main diff with risk assessment |
| `/review-pr-staging` | Comprehensive staging → main review gate |
| `/rollback` | Automated revert PR for production incidents |
| `/incident-response` | P0 coordination: hotfix validation, timeline, postmortem |

### Maintenance

| Command | What it does |
|---------|-------------|
| `/pipeline-health` | Self-analysis: measures performance, proposes improvements |
| `/autopilot` | Autonomous improvement cycle: recon, triage, fix |
| `/cleanup` | Sweeps stale issues, branches, worktrees |
| `/security-audit` | Periodic 4-phase security posture audit |
| `/failure-recon` | Production failure investigation |
| `/validate` | Independently verify if a reported issue is real |
| `/audit` | Trace pipeline failures end-to-end |

### Ecosystem

| Command | What it does |
|---------|-------------|
| `/analytics` | Pull production analytics from GSC, Clarity, Umami, Stripe, and more |
| `/geo-audit` | AI engine discoverability audit |
| `/qa-sweep` | Full platform QA via browser automation |
| `/sync-ecosystem` | SDK and satellite repo sync |

---

## Get Started

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (with an active subscription)
- Git and GitHub CLI (`gh`) installed and authenticated

### Install

```bash
# Clone the repo
git clone https://github.com/RapierCraftStudios/forgedock.git
cd forgedock

# Install commands globally (symlinks to ~/.claude/commands/)
./install.sh
```

That's it. ForgeDock commands are now available as slash commands in any Claude Code session.

### Your First Autonomous PR

```bash
# Navigate to your project
cd your-project

# Open Claude Code
claude

# Tell ForgeDock to work on an issue
> /work-on #42
```

ForgeDock will investigate the issue, plan the implementation, write the code, run quality checks, review its own work, and open a PR. You review and merge.

### Project Configuration

ForgeDock is **project-agnostic**. It reads your project's `CLAUDE.md` at runtime for project-specific conventions, paths, architecture, labels, and workflow configuration. No ForgeDock-specific config files needed.

---

## Architecture

```
commands/                    ← Slash commands (the pipeline)
├── work-on.md              ← Full issue lifecycle orchestrator
├── work-on/
│   ├── investigate.md      ← Root cause analysis
│   ├── decompose.md        ← Issue breakdown
│   ├── review.md           ← PR creation + review trigger
│   ├── close.md            ← Issue closure + cleanup
│   └── build/
│       ├── context.md      ← Pre-build context gathering
│       ├── architect.md    ← Implementation planning
│       ├── implement.md    ← Code writing
│       └── validate.md     ← Quality gate + verification
├── review-pr.md            ← Multi-agent PR review
├── review-pr-agents.md     ← 9 specialized review agents
├── quality-gate.md         ← Static analysis checks
├── orchestrate.md          ← Milestone decomposition
└── ...                     ← 20+ more commands
docs/                        ← Pipeline documentation
scripts/                     ← Verification scripts
install.sh                   ← One-command installer
```

---

## Agent Model Policy

- **Default:** `sonnet` — all sub-agents use the cost-efficient model
- **Fallback:** `opus` — automatic fallback when Sonnet is rate-limited
- **Override:** Pass `--model <name>` to any command to force a specific model

Prompts are engineered with explicit file hints, step-by-step instructions, and structured output formats so Sonnet operates effectively. Opus handles the same prompts without issue when used as fallback.

---

## Battle-Tested

ForgeDock has been used in production to ship features, fix bugs, and manage releases across real codebases. The pipeline has been refined through **370+ commits** of prompt engineering, with each change correlated against actual pipeline metrics.

Key stats from production use:
- **20+ orchestrated commands** in the pipeline
- **9 specialized review agents** (billing, auth, DB, API, security, and more)
- **Self-tuning** — false positive rate reduced from 44% to <10% through automated pipeline health analysis
- **Migration safety checklist** — added after analyzing 79+ DB-related findings

---

## Pipeline Hardening Principles

ForgeDock follows strict rules about where safety checks belong:

- **Quality Gate** → Static analysis (things grep can catch)
- **Review Agents** → Semantic reasoning (library contracts, cross-service logic)
- **Builder Rules** → Prevention at write time (simple rules followed during implementation)
- **Domain Detection** → Broad categories (DB, billing, auth) trigger the right review agents

This prevents one-incident-one-check proliferation and keeps the pipeline maintainable.

---

## Codex Support

ForgeDock also supports [OpenAI Codex](https://openai.com/index/openai-codex/) as a runtime:

```bash
# Install Codex-native skills
./install-codex.sh
```

`AGENTS.md` serves as the Codex-native entrypoint. The same command specs work across both runtimes.

---

## Contributing

We welcome contributions! ForgeDock improves through real-world use.

- **Every change goes through a PR** — no direct commits to main
- **Test prompt changes against 3+ scenarios** before merging
- **Never remove existing safety harnesses** — only add or tighten
- **Conventional commits:** `fix(command):`, `feat(command):`, `refactor(command):`

---

## License

[MIT](LICENSE) — use it, fork it, build on it.

---

<div align="center">

Built by [RapierCraft Studios](https://github.com/RapierCraftStudios)

**ForgeDock** — because your issues should ship themselves.

</div>
