<div align="center">

<img src="https://avatars.githubusercontent.com/in/3731547?s=200&u=b38eba537e011502c010d4b682d641f802591845&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>GitHub as a knowledge graph for AI agents.</strong></p>

<p>An autonomous development pipeline for Claude Code that uses GitHub issues, PRs, commits, and blame as structured memory — so every agent knows what happened before it, why the code looks the way it does, and what to do next.</p>

<a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
<a href="https://github.com/RapierCraftStudios/ForgeDock/stargazers"><img src="https://img.shields.io/github/stars/RapierCraftStudios/ForgeDock?style=social" alt="GitHub Stars" /></a>
<a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet" alt="Claude Code" /></a>
<a href="https://github.com/RapierCraftStudios/ForgeDock/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
<a href="https://github.com/sponsors/RapierCraftStudios"><img src="https://img.shields.io/badge/Sponsor-❤-ea4aaa.svg" alt="Sponsor" /></a>

</div>

<br />

```
You:        /work-on #42
ForgeDock:  Investigates → Architects → Builds → Quality gates → Reviews → Opens PR
You:        *click merge*
```

---

## The Problem

AI coding agents have **no lookback.** They don't know why the code they're touching was written. They can't tell that a function was shaped by a bug fix in issue #347, that a similar approach was tried and reverted in PR #891, or that three other files use the same pattern and need the same fix. They start every task blind — even within a single session.

Context window isn't the bottleneck. **Memory is.** When an agent compacts or a conversation ends, everything it learned is gone. The next agent starts from scratch. The investigation gets repeated. The same mistakes get made. There's no institutional knowledge.

## The Insight

GitHub already stores everything an agent needs to know — commits, PRs, issues, blame, cross-references. It's a knowledge graph. But AI agents don't use it that way.

ForgeDock changes that. Every pipeline stage writes **structured, machine-readable annotations** to GitHub issues and PRs. Every downstream agent reads what came before. The `gh` CLI becomes the query interface to institutional memory.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     GITHUB (Knowledge Graph)                        │
│                                                                     │
│  Issues:  FORGE:INVESTIGATOR → FORGE:CONTRACT → FORGE:ARCHITECT     │
│  PRs:     FORGE:BUILDER → FORGE:REVIEW → FORGE:TRAJECTORY           │
│  Links:   git blame → commit → PR → issue → related issues          │
│                                                                     │
│  Every agent reads this. Every agent writes to it.                  │
│  Nothing is lost between conversations.                             │
└─────────────────────────────────────────────────────────────────────┘
```

When the builder agent starts, it doesn't explore the codebase from scratch. It reads the investigation comment that already traced the root cause, identified affected files, and referenced the commit that introduced the bug. When the architect agent plans the implementation, it reads historical findings from related PRs so it doesn't repeat known mistakes. When a review agent flags a finding, that finding becomes a new issue that enters the same pipeline — investigated, built, reviewed, and merged.

The result: agents that are **deterministic**, not guessing. They follow structured data, not vibes.

---

## See It Working

Here's what a real pipeline run looks like. A user reports that an API endpoint is returning 500 errors — the pipeline takes it from there.

### Example 1: Bug fix with full context chain

A user opens issue #42: *"POST /api/payments returns 500 for free-tier users."*

```
FORGE:INVESTIGATOR  →  Traced bug to commit e8f21a3 (PR #38). The payment validation
                        gate assumed all users have a billing profile — free-tier users don't.
                        Quantified impact: 12 affected users, 94 failed requests in the last 24h.

FORGE:CONTRACT      →  2-file fix: add nil-check in payment validator,
                        add free-tier guard in the API router

FORGE:CONTEXT       →  Surfaced 2 historical bugs in the same module:
                        #29 (missing nil-check on subscription lookup) and
                        #34 (billing profile race condition on signup).
                        Known pitfall: don't skip the audit log write on early returns.

FORGE:ARCHITECT     →  Ordered implementation plan with exact file/function/line table

FORGE:BUILDER       →  Branch fix/payment-validation-free-tier-42, 2 files changed

FORGE:REVIEW        →  4 review agents, 0 findings, auto-merged to staging
```

The context phase knew about the audit log pitfall from issue #34 — a completely different bug, months earlier, in the same module. That's institutional memory.

### Example 2: Cross-issue knowledge graph

The fix for #42 only covered the `/payments` endpoint. But the same nil-check bug exists in `/invoices` and `/subscriptions`. The pipeline spawns issue #43.

The context phase reads the structured data from #42 and says: *"Billing profile nil-check was already fixed in payment_validator.py (#42) — same pattern must be applied consistently."* It doesn't re-investigate. It reads the knowledge graph and applies the known fix to the remaining endpoints. 7 minutes, start to merge.

### Example 3: Review agents catch bugs across service boundaries

A staging-to-main deploy PR gets reviewed by four specialized agents:

- **Concurrency agent** — verified idempotency keys through PostgreSQL advisory locks
- **Security agent** — flagged a `force_https` default change with broad blast radius
- **API agent** — verified route registration consistency across all endpoints
- **Billing Integrity agent** — found that the `/invoices` query still referenced an old column name that was renamed in a recent migration

That billing finding becomes a new issue — enters the same pipeline, gets investigated, built, reviewed, and merged. Bug caught before it hits production.

### Example 4: The pipeline catches its own false positives

A review agent flags "no input size cap on the system key path." The investigation phase traces the full call chain and finds the cap *already exists* in a downstream quality gate module. Closed as `workflow:invalid` with an explanation of why the review agent missed it (it only inspected the text-building logic, not the downstream gate). The trajectory recorded: *"Investigation revealed fix already present."*

The pipeline self-corrects. No wasted work. Full audit trail.

---

## How It Works

### The Pipeline

```
Issue → Investigate → Architect → Build → Quality Gate → Review → Merge
                ↓           ↓         ↓          ↓            ↓
          writes to    reads from  reads from  reads from   writes to
           GitHub       GitHub      GitHub      GitHub       GitHub
```

Each stage reads the structured output of previous stages and writes its own findings back:

| Stage | Reads | Writes |
| --- | --- | --- |
| **Investigate** | Issue body, `git blame`, related issues/PRs | `FORGE:INVESTIGATOR` — verdict, root cause, affected files, severity |
| **Context** | Historical findings from related PRs, known pitfalls | `FORGE:CONTEXT` — institutional memory for this module |
| **Architect** | Investigation + context findings | `FORGE:ARCHITECT` — ordered implementation plan, code paths, risks |
| **Build** | Investigation + context + architect plan | `FORGE:BUILDER` — branch, commits, files changed, checklist |
| **Quality Gate** | Builder output, 14+ domain-specific checks | `FORGE:QUALITY_GATE` — findings by domain (security, auth, DB, etc.) |
| **Review** | PR diff, builder contract, quality gate results | `FORGE:REVIEW` — per-agent findings with evidence and confidence |
| **Close** | All of the above | `FORGE:TRAJECTORY` — full audit trail of the entire run |

### GitHub as Database

Every annotation is wrapped in an HTML comment tag (`<!-- FORGE:INVESTIGATOR -->`, `<!-- FORGE:CONTRACT -->`, etc.) that makes it machine-parseable. When an agent starts — even in a brand new conversation after compaction — it queries the issue via `gh` and reconstructs full context from these tags. Nothing depends on conversation history.

Labels track workflow state (`workflow:investigating`, `workflow:building`, `workflow:in-review`, `workflow:merged`, `workflow:invalid`). The pipeline resumes from whatever state GitHub says it's in.

### Review Agents

PRs are reviewed by domain-specific agents, each with deep expertise:

| Agent | Focus |
| --- | --- |
| Billing Integrity | Payment flows, credit debit paths, column renames |
| Auth & Access Control | Endpoint auth dependencies, resource ownership |
| Database | Migrations, unbounded queries, NOT NULL without DEFAULT |
| Security | SQL injection, SSRF, XSS, hardcoded secrets |
| Concurrency | Idempotency, advisory locks, race conditions |
| Frontend | useEffect cleanup, error states, hook dependencies |
| API | Route registration, proxy paths, response contracts |
| Performance | N+1 queries, unbounded loops, missing indexes |
| Infrastructure | Dockerfile changes, volume permissions, CI/CD |

Each agent posts structured findings with confidence levels — `CONFIRMED` (traced full code path), `LIKELY` (pattern match), or `POSSIBLE` (needs verification). Findings above a severity threshold become new GitHub issues that enter the same pipeline.

### The Self-Improvement Loop

Review findings from real PRs feed back into the pipeline:

1. Review agents flag patterns (e.g., "async code keeps missing cleanup")
2. `/pipeline-health` correlates findings with prompt changes and build failures
3. The quality gate evolves — new domain checks get added from recurring patterns
4. False positive rate dropped from 44% to under 10% through this loop

`/autopilot` takes this further: it pulls production signals (errors, CI failures, stale issues, analytics), creates issues from findings, and optionally runs `/work-on` on the top issues. Each cycle's fixes compound into the next.

---

## Commands

| Command | What it does |
| --- | --- |
| **`/work-on`** | Full issue lifecycle: investigate → build → quality gate → review → merge |
| `/issue` | Creates pipeline-ready GitHub issues |
| `/orchestrate` | Parallel execution: decomposes milestones into waves, runs `/work-on` on each |
| `/review-pr` | Context-aware PR review with 9 specialized agents |
| `/quality-gate` | Pre-commit checks across 14+ domains |
| `/milestone` | Create, manage, and ship milestones |
| `/deploy-info` | Staging vs main diff with risk assessment |
| `/review-pr-staging` | Comprehensive staging-to-main review gate |
| `/rollback` | Automated revert PR for production incidents |
| `/incident-response` | P0 coordination: hotfix, timeline, postmortem |
| `/pipeline-health` | Self-analysis: measures performance, proposes improvements |
| `/autopilot` | Autonomous improvement cycle: recon → triage → fix |
| `/security-audit` | 4-phase security posture audit |
| `/cleanup` | Sweeps stale issues, branches, worktrees |
| `/analytics` | Pull metrics from GSC, Clarity, Umami, Stripe, and more |
| `/qa-sweep` | Full platform QA via browser automation |

---

## Vision

ForgeDock today uses GitHub as its knowledge graph. It works — 20,000+ issues processed, real production codebases shipping autonomously. But GitHub wasn't designed for this. Issue comments are append-only text blobs. Labels are flat strings. Cross-references are implicit links, not queryable edges. Every annotation costs tokens to parse because it's wrapped in markdown meant for humans, not machines.

The end state is a **purpose-built knowledge graph** — a structured, token-efficient store designed from the ground up for AI agents to read and write. Not a GitHub overlay. Not a vector database bolted on the side. A first-class system where:

**In-house knowledge layer.** Replace GitHub comments with a native graph store where relationships are edges, not hyperlinks. An agent asking "what bugs has this module had in the last 30 days?" should be a graph query returning structured data — not parsing 50 issue comment bodies hoping to find `<!-- FORGE:INVESTIGATOR -->` tags. Annotations become nodes with typed relationships (caused-by, fixed-in, blocks, related-to) instead of flat text.

**Token-efficient by design.** Today, an agent reads a 3,000-character investigation comment to extract 5 fields. A purpose-built store returns those 5 fields directly — 50 tokens instead of 800. At pipeline scale (investigation + context + architect + builder + review), this compresses the context budget dramatically. Agents get more lookback within the same window.

**Self-improving feedback loops, closed tighter.** Right now, the improvement loop runs through `/pipeline-health` — a command a human invokes. In the end state, the pipeline continuously measures its own accuracy (false positive rates, investigation-to-build time, review-finding recurrence), identifies degrading patterns, and adjusts its own prompts, quality gate checks, and review focus areas without human intervention. Not "suggest improvements" — actually ship them, validate them, and roll back if metrics regress.

**Fully autonomous development cycles.** Today, `/autopilot` runs recon and creates issues, but a human gates every fix. The vision is a pipeline that can run continuously — detecting production issues, creating issues, investigating, building, reviewing, deploying to staging, validating, and promoting to production — with human oversight moving from "approve every action" to "set policy and review outcomes." The human becomes the architect, not the operator.

**Provider-agnostic agent runtime.** ForgeDock currently runs on Claude Code. The pipeline logic — the state machine, the annotation protocol, the review agent catalog — is model-agnostic. The goal is an agent runtime that can orchestrate any LLM (Claude, GPT, Gemini, open-source models) as specialized workers, choosing the right model for each task based on capability, cost, and latency.

The path from here to there is incremental. Each piece — the knowledge store, the tighter feedback loop, the autonomous deploy gate — can ship independently and compound with the others.

---

## Install

**Step 1: Install commands**

```bash
npx forgedock
```

This symlinks all pipeline commands into your Claude Code environment (`~/.claude/commands/`).

**Step 2: Generate config**

```bash
npx forgedock init         # Auto-detects your repo, owner, and branches
```

Creates `forge.yaml` in your project root — the config file that makes ForgeDock work with your repo instead of a hardcoded one. Edit it to fill in your project details.

**Step 3: AI-powered setup (optional)**

```
/forgedock-init            # Inside Claude Code — guided full config walkthrough
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [GitHub CLI](https://cli.github.com/).

**Other commands:**

```bash
npx forgedock update      # Pull latest commands
npx forgedock uninstall   # Remove all commands
npx forgedock help        # Show all commands
```

---

## Show Your Support

If you're using ForgeDock to power your development pipeline, add a badge to your README to let the community know:

```markdown
[![Built with ForgeDock](https://img.shields.io/badge/Built_with-ForgeDock-blue?logo=github)](https://github.com/RapierCraftStudios/ForgeDock)
```

Rendered: [![Built with ForgeDock](https://img.shields.io/badge/Built_with-ForgeDock-blue?logo=github)](https://github.com/RapierCraftStudios/ForgeDock)

This creates a discovery channel — each badge is a backlink and a signal to other developers that the project is AI-pipeline driven.

### Star History

<a href="https://star-history.com/#RapierCraftStudios/ForgeDock&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=RapierCraftStudios/ForgeDock&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=RapierCraftStudios/ForgeDock&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=RapierCraftStudios/ForgeDock&type=Date" />
  </picture>
</a>

---

## Contributing

PRs welcome. Every change goes through a PR, tested against 3+ scenarios, using conventional commits (`fix(command):`, `feat(command):`, `refactor(command):`).

## License

[AGPL-3.0](LICENSE) — free to use, modify, and distribute. If you modify ForgeDock and offer it as a service (including over a network), you must open-source your modifications under the same license.

---

<div align="center">

<p>Built by <a href="https://github.com/RapierCraftStudios">RapierCraft Studios</a></p>

</div>
