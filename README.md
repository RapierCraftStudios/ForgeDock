<div align="center">

<img src="https://avatars.githubusercontent.com/in/3731547?s=200&u=b38eba537e011502c010d4b682d641f802591845&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>Turn a GitHub issue into a merged, reviewed PR — autonomously.</strong></p>

<p>An autonomous development pipeline for Claude Code. Point it at an issue and it investigates, plans, builds, quality-gates, reviews with domain-specialist agents, and opens the PR — reasoning written back to GitHub at every step. Point it at a whole <strong>milestone</strong> and it runs the issues <strong>in parallel</strong>. Intent in, production-ready PRs out, in minutes.</p>

<a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
<a href="https://github.com/RapierCraftStudios/ForgeDock/stargazers"><img src="https://img.shields.io/github/stars/RapierCraftStudios/ForgeDock?style=social" alt="GitHub Stars" /></a>
<a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet" alt="Claude Code" /></a>
<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/v/forgedock?color=cb3837&logo=npm" alt="npm" /></a>
<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/dm/forgedock?color=cb3837&logo=npm&label=downloads" alt="npm downloads per month" /></a>
<a href="https://github.com/RapierCraftStudios/ForgeDock/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
<a href="https://github.com/sponsors/RapierCraftStudios"><img src="https://img.shields.io/badge/Sponsor-❤-ea4aaa.svg" alt="Sponsor" /></a>

</div>

<br />

<div align="center">

<img src="docs/demo.gif" alt="ForgeDock orchestrating multiple GitHub issues in parallel — agents investigate, build, review, and flip workflow labels through to merged" width="900" />

<p><em><strong>One <code>/orchestrate</code> runs a whole milestone.</strong> Agents pick up issues in parallel, drive each through investigate → build → review, and flip the GitHub labels to <code>merged</code> — live.</em></p>

</div>

<br />

**A single issue, up close:**

```console
$ /work-on #42          "POST /api/payments returns 500 for free-tier users"

  ✓ investigate    root cause → commit e8f21a3 (PR #38); free-tier users have no billing profile
  ✓ context        surfaced 2 past bugs in this module + a known audit-log pitfall
  ✓ architect      2-file plan: nil-guard in validator, free-tier check in the router
  ✓ build          branch fix/payment-validation-free-tier-42 · 2 files
  ✓ review         4 domain agents · 0 findings
  ✓ merged         7m 12s  →  staging

  every step is written back to GitHub. the next agent reads it. nothing is forgotten.
```

<div align="center">
<p><em><code>/work-on #42</code> — issue to reviewed PR, with the full reasoning chain written back to GitHub.</em></p>
</div>

### Try it in 30 seconds — on a throwaway repo, nothing to lose

```bash
npx forgedock demo     # spins up a risk-free demo repo and shows you the pipeline end to end
```

Ready to use it for real? **`npx forgedock`** walks you through one continuous setup: it checks your environment, installs the slash commands, reads your repo, and hands you a single annotated `forge.yaml` to review — you press Enter once.

> ⭐ **If ForgeDock saves you time, [star the repo](https://github.com/RapierCraftStudios/ForgeDock/stargazers)** — it's the whole marketing budget.

---

**Your AI coding agent forgets everything after every session.** It re-explores the codebase from scratch, re-makes mistakes that were already fixed, and has no idea why the code it's touching looks the way it does. ForgeDock fixes that by making **GitHub itself the memory** — every pipeline stage writes structured findings that every later agent reads.

## Without ForgeDock vs. With ForgeDock

| Without ForgeDock | With ForgeDock |
|---|---|
| Agent starts every session blind — no context from prior work | Agent reads structured investigation, root cause, and history straight from GitHub |
| The same bugs get reintroduced across PRs | Review agents surface known pitfalls from past PRs *before* you commit |
| Investigation is repeated after every compaction | GitHub is the memory — a new session resumes exactly where the last left off |
| You write the issue, plan the fix, open the PR, and review it | `/work-on #42` → investigated, built, reviewed, merged |
| Review depends on whoever has capacity | 9 domain-specialist agents (security, billing, DB, concurrency…) review every PR |
| One task at a time, serialized by your attention | `/orchestrate` runs a whole milestone — many issues in parallel, each its own full pipeline |

---

## The idea in one paragraph

AI agents have **no lookback**. They don't know a function was shaped by a bug fix in #347, that an approach was tried and reverted in PR #891, or that three other files need the same change. Context window isn't the bottleneck — **memory is.** But GitHub already stores everything an agent needs: commits, PRs, issues, blame, cross-references. It's a knowledge graph; agents just don't use it as one. ForgeDock makes every stage write **machine-readable annotations** to issues and PRs, and every downstream agent read them. The `gh` CLI becomes the query interface to institutional memory. The result: agents that follow structured data, not vibes.

```
┌──────────────────────────────────────────────────────────────┐
│                   GITHUB (Knowledge Graph)                   │
│                                                              │
│  Issues:  FORGE:INVESTIGATOR → FORGE:CONTRACT → FORGE:ARCHITECT│
│  PRs:     FORGE:BUILDER → FORGE:REVIEW → FORGE:TRAJECTORY     │
│  Links:   git blame → commit → PR → issue → related issues   │
│                                                              │
│  Every agent reads this. Every agent writes to it.           │
│  Nothing is lost between conversations.                      │
└──────────────────────────────────────────────────────────────┘
```

---

## See it working

**A cross-issue fix that used memory.** Issue #42 fixed a billing nil-check on `/payments`. The same bug exists on `/invoices` and `/subscriptions`, so the pipeline spawns #43. Its context phase reads #42's structured data — *"nil-check already fixed in `payment_validator.py` (#42); apply the same pattern"* — and doesn't re-investigate. It reads the knowledge graph and applies the known fix. Start to merge: 7 minutes.

**Review agents catching a cross-boundary bug.** On a staging→main deploy PR, the Billing Integrity agent found an `/invoices` query still referencing a column that a recent migration had renamed. That finding became a new issue, entered the same pipeline, and was fixed before it reached production.

**The pipeline catching its own false positive.** A review agent flagged "no input size cap on the key path." Investigation traced the full call chain, found the cap *already exists* downstream, and closed it `workflow:invalid` with an explanation of why the reviewer missed it. Self-correcting, with a full audit trail — no wasted work.

---

## Orchestrate an entire milestone

`/work-on` ships one issue. **`/orchestrate` ships a milestone.** It decomposes the milestone into dependency-ordered waves and runs a full `/work-on` pipeline on each issue **in parallel** — investigating, building, reviewing, and merging many at once, while GitHub labels track every agent's state live. Overlapping files are detected and serialized; independent work runs concurrently.

<div align="center">
<img src="assets/orchestration.svg" alt="One milestone fanned out into parallel work-on pipelines, each issue advancing through investigating, building, in-review, and merged" width="920" />
</div>

```bash
/orchestrate milestone/checkout-v2     # decompose → parallel waves → merged PRs
```

---

## How it works

Each stage reads the structured output of the stages before it and writes its own findings back:

```
Issue → Investigate → Context → Architect → Build → Quality Gate → Review → Merge
              └──────────── each stage reads & writes GitHub ────────────┘
```

| Stage | Reads | Writes |
| --- | --- | --- |
| **Investigate** | Issue body, `git blame`, related issues/PRs | `FORGE:INVESTIGATOR` — verdict, root cause, affected files, severity |
| **Context** | Historical findings from related PRs, known pitfalls | `FORGE:CONTEXT` — institutional memory for this module |
| **Architect** | Investigation + context | `FORGE:ARCHITECT` — ordered plan, code paths, risks |
| **Build** | Everything above | `FORGE:BUILDER` — branch, commits, files changed |
| **Quality Gate** | Builder output, domain-specific checks | `FORGE:QUALITY_GATE` — findings by domain |
| **Review** | PR diff, contract, gate results | `FORGE:REVIEW` — per-agent findings with evidence + confidence |
| **Close** | All of the above | `FORGE:TRAJECTORY` — full audit trail of the run |

**GitHub as the database.** Every annotation is wrapped in an HTML comment (`<!-- FORGE:INVESTIGATOR -->`) that makes it machine-parseable. When an agent starts — even in a brand-new conversation after compaction — it queries the issue via `gh` and reconstructs full context from these tags. Workflow labels (`workflow:investigating`, `workflow:in-review`, `workflow:merged`…) track state, and the pipeline resumes from whatever state GitHub reports. The annotation format is an open standard — see the [FORGE Annotation Protocol](docs/FORGE-PROTOCOL.md).

**Domain-specialist review.** Every PR is reviewed by agents with deep, narrow expertise — Billing Integrity, Auth & Access Control, Database, Security, Concurrency, Frontend, API, Performance, Infrastructure. Each posts findings with a confidence level (`CONFIRMED` traced the full path · `LIKELY` pattern match · `POSSIBLE` needs verification). Findings above a severity threshold become new issues that enter the same pipeline.

**It improves itself.** Review findings from real PRs feed back in: `/pipeline-health` correlates findings with prompt changes and failures, and recurring patterns become new quality-gate checks. In production use on our own codebase, this loop took the review false-positive rate from ~44% down to under 10%. `/autopilot` goes further — pulling production signals (errors, CI failures, stale issues, analytics), filing issues from them, and optionally running `/work-on` on the top ones.

> Numbers above come from dogfooding ForgeDock on our own production codebase. A public, reproducible benchmark is in progress — track it in the [issues](https://github.com/RapierCraftStudios/ForgeDock/issues).

---

## Commands

| Command | What it does |
| --- | --- |
| **`/work-on`** | Full issue lifecycle: investigate → build → quality gate → review → merge |
| `/orchestrate` | Parallel execution — decomposes a milestone into waves, runs `/work-on` on each |
| `/issue` | Creates pipeline-ready GitHub issues |
| `/review-pr` | Context-aware PR review with 9 specialist agents |
| `/quality-gate` | Pre-commit checks across 14+ domains |
| `/milestone` | Create, manage, and ship milestones |
| `/deploy-info` | Staging vs. main diff with risk assessment |
| `/rollback` | Automated revert PR for production incidents |
| `/incident-response` | P0 coordination: hotfix, timeline, postmortem |
| `/pipeline-health` | Self-analysis — measures performance, proposes improvements |
| `/autopilot` | Autonomous improvement cycle: recon → triage → fix |
| `/security-audit` | Multi-phase security posture audit |
| `/cleanup` | Sweeps stale issues, branches, worktrees |
| `/analytics` | Pull metrics from GSC, Clarity, Umami, Stripe, and more |

[Full command reference →](docs/site/command-reference.md)

---

## Install

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [GitHub CLI](https://cli.github.com/) (authenticated) · Node.js ≥ 18.

```bash
npx forgedock          # checks your environment, installs the commands, detects your repo, and hands you a reviewed forge.yaml
```

One command does everything: it checks your environment, installs the slash commands into Claude Code, detects your repo (owner, branches, paths), and hands you a single annotated `forge.yaml` to review — press Enter to accept. Run `npx forgedock init` any time afterward to re-generate the config only.

Installing also registers a SessionStart hook, so every Claude Code session
in a forge-managed directory starts already knowing ForgeDock runs it.
Per-directory control: `npx forgedock enable` / `disable` / `status`.

Then just open Claude Code and run `/work-on <issue>`.

<details>
<summary><strong>Other install options & commands</strong></summary>

**Claude Code plugin marketplace** (Claude Code v2.1.143+):

```
/plugin marketplace add RapierCraftStudios/ForgeDock
/plugin install forgedock@forgedock
```

Commands then appear as `/forgedock:work-on`, etc. You still run `npx forgedock init` to generate `forge.yaml`.

**Maintenance:**

```bash
npx forgedock update      # relink commands + refresh the SessionStart hook
npx forgedock enable      # turn ForgeDock on for this directory
npx forgedock disable     # turn ForgeDock off for this directory
npx forgedock status      # show ForgeDock's state for this directory
npx forgedock uninstall   # remove commands, the hook, and tracked copies
npx forgedock help        # show everything
```

> Running `npx forgedock` from *inside* this repo uses the local working tree. From your own project, use `npx forgedock@latest` to pin the published release.

</details>

---

## Where it's going

ForgeDock uses GitHub as its knowledge graph today, and it works. But GitHub wasn't built for this — comments are text blobs, labels are flat strings, and every annotation costs tokens to parse. The roadmap is a **durable execution engine** with a purpose-built, token-efficient knowledge store where relationships are queryable edges, an **outcome-based verification gate** that makes correctness machine-checkable, **per-codebase learning** that compounds over time, and a **provider-agnostic runtime** that can route each task to the right model. Each piece ships independently — follow [the five-foundations epic](https://github.com/RapierCraftStudios/ForgeDock/issues) to see it land.

---

## Show your support

Using ForgeDock in your pipeline? Add the badge — each one is a backlink and a signal to other developers:

```markdown
[![Built with ForgeDock](https://raw.githubusercontent.com/RapierCraftStudios/ForgeDock/main/assets/built-with-forgedock.svg)](https://github.com/RapierCraftStudios/ForgeDock)
```

[![Built with ForgeDock](assets/built-with-forgedock.svg)](https://github.com/RapierCraftStudios/ForgeDock)

---

## Star History

<div align="center">

<a href="https://star-history.com/#RapierCraftStudios/ForgeDock&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=RapierCraftStudios/ForgeDock&type=Date&theme=dark" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=RapierCraftStudios/ForgeDock&type=Date" width="600" />
  </picture>
</a>

</div>

---

## Docs & community

- [Getting Started in 5 Minutes](docs/site/getting-started.md)
- [How the Knowledge Graph Works](docs/site/how-it-works.md)
- [FORGE Annotation Protocol](docs/FORGE-PROTOCOL.md) — the open standard for AI context passing
- [ForgeDock vs. Manual Claude Code Workflows](docs/site/vs-manual-workflows.md)
- [Complete Command Reference](docs/site/command-reference.md)

**Contributing:** PRs welcome — every change goes through a PR, tested against 3+ scenarios, using conventional commits (`fix(command):`, `feat(command):`). **License:** [AGPL-3.0](LICENSE) — free to use, modify, and distribute; network use of modifications must be open-sourced under the same license.

<div align="center">
<br />
<p>Built and dogfooded in production by <a href="https://github.com/RapierCraftStudios">RapierCraft Studios</a>.</p>
</div>
