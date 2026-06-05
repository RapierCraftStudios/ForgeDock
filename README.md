<div align="center">

<img src="https://avatars.githubusercontent.com/in/3731547?s=200&u=b38eba537e011502c010d4b682d641f802591845&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>GitHub as a knowledge graph for AI agents.</strong></p>

<p>An autonomous development pipeline for Claude Code that uses GitHub issues, PRs, commits, and blame as structured memory — so every agent knows what happened before it, why the code looks the way it does, and what to do next.</p>

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

The best way to understand ForgeDock is to look at real pipeline runs. Every issue below was investigated, built, reviewed, and merged by AI agents — with full context flowing between stages via GitHub comments.

### Example 1: Bug fix with full context chain

**[AlterLab #20256](https://github.com/RapierCraftStudios/AlterLab/issues/20256)** — `extraction_schema` broke for non-BYOK users. 7 minutes, start to merge.

```
FORGE:INVESTIGATOR  →  Traced bug to commit a4eafb07b, identified the PR that introduced it (#4487),
                        quantified impact (88 errors across 5 users)

FORGE:CONTRACT      →  2-file fix: decouple extraction_schema from BYOK gate in API,
                        restore system key fallback in worker

FORGE:CONTEXT       →  Surfaced 3 historical bugs in the same module (#20072, #19852, #20039)
                        and a known pitfall about spend reservation reversal from #17086

FORGE:ARCHITECT     →  Ordered implementation plan with exact file/function/line table

FORGE:BUILDER       →  Branch fix/extraction-schema-byok-20256, commit b19ec393f, 2 files changed

FORGE:REVIEW        →  4 review agents, 0 findings, auto-merged to staging
```

The context phase knew about spend reservation reversal from issue #17086 — a completely different bug, months earlier, in the same module. That's institutional memory.

### Example 2: Cross-issue knowledge graph

**[AlterLab #20263](https://github.com/RapierCraftStudios/AlterLab/issues/20263)** — spawned because the fix for #20256 only covered one of three callers.

The context phase read the previous fix and said: *"BYOK gate pattern was already fixed in scrape_unified.py (#20256) — same pattern must be applied consistently."* It didn't re-investigate. It read structured data from the knowledge graph and applied the known fix to `batch.py` and `crawl.py`. 7 minutes, start to merge.

### Example 3: Review agents catch bugs across service boundaries

**[AlterLab PR #20265](https://github.com/RapierCraftStudios/AlterLab/pull/20265)** — staging-to-main deploy. Four specialized review agents analyzed the deploy:

- **Concurrency agent** — verified idempotency keys through PostgreSQL advisory locks across 8 scenarios
- **Security agent** — flagged `force_https` default change blast radius and unbounded LLM cost exposure
- **Scraper Logic agent** — verified BYOK decoupling consistency across all 3 endpoints
- **Billing Integrity agent** — found that the `/invoices` endpoint still used the old `cs.metadata` column name (the deposits fix in #20259 missed it)

That billing finding became **[#20266](https://github.com/RapierCraftStudios/AlterLab/issues/20266)** — a new issue that entered the pipeline, got fixed, and merged. Bug caught before it hit production.

### Example 4: The pipeline catches its own false positives

**[AlterLab #20267](https://github.com/RapierCraftStudios/AlterLab/issues/20267)** — a review agent flagged "no input size cap on system key extraction." The investigation phase traced the full call chain and found the cap *already existed* in `quality_gate.py` (`CONTENT_MAX_CHARS = 30_000`). Closed as `workflow:invalid` with an explanation of why the review agent missed it. The trajectory recorded: *"Investigation revealed fix already present."*

> Browse **[AlterLab's closed issues](https://github.com/RapierCraftStudios/AlterLab/issues?q=is%3Aissue+is%3Aclosed+sort%3Acreated-desc)** to see thousands of pipeline runs — every one with investigation, context, architect, builder, and trajectory comments.

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

```bash
git clone https://github.com/RapierCraftStudios/forgedock.git
cd forgedock
./install.sh
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [GitHub CLI](https://cli.github.com/). ForgeDock reads your project's `CLAUDE.md` for conventions — no extra config needed.

---

## Contributing

PRs welcome. Every change goes through a PR, tested against 3+ scenarios, using conventional commits (`fix(command):`, `feat(command):`, `refactor(command):`).

## License

[MIT](LICENSE)

---

<div align="center">

<p>Built by <a href="https://github.com/RapierCraftStudios">RapierCraft Studios</a></p>

</div>
