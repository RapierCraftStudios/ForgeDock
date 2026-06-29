<div align="center">

<img src="https://avatars.githubusercontent.com/in/3731547?s=200&u=b38eba537e011502c010d4b682d641f802591845&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>Autonomous software development for Claude Code.</strong></p>

<p>ForgeDock turns every bug found, every fix shipped, and every review finding into structured context that makes the next agent smarter. It catches integration bugs that code review can't see — missing route registrations, env vars present in CI but absent in deploy, Docker permission mismatches, sibling code paths left unfixed. Every finding feeds back as a prevention rule for future builds. After thousands of issues on production codebases, the system catches bugs before they reach a testing branch.</p>

<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/dm/forgedock?label=npm%20downloads&style=flat-square&color=CB3837" alt="npm downloads/month" /></a>&nbsp;
<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/v/forgedock?style=flat-square&color=CB3837" alt="npm version" /></a>&nbsp;
<a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/forgedock?style=flat-square&color=339933" alt="node version" /></a>&nbsp;
<a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Built%20for-Claude%20Code-7C3AED?style=flat-square" alt="Claude Code" /></a>
<br />
<a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat-square" alt="License: AGPL-3.0" /></a>&nbsp;
<a href="https://github.com/RapierCraftStudios/ForgeDock/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs Welcome" /></a>

<br /><br />

<img src="docs/demo.gif" alt="ForgeDock demo — parallel orchestration across 15+ issues" width="900" />

<p><em>15+ issues orchestrated in parallel — investigated, built, reviewed, and shipped autonomously.</em></p>

</div>

<br />

## What ForgeDock Does

ForgeDock runs the full issue lifecycle inside Claude Code — **investigate, architect, build, quality-gate, review, and merge** — autonomously. You open an issue, run `/work-on #42`, and click merge. Every stage writes structured context back to GitHub, so the next agent starts smart, not blind.

```
You:        /work-on #42
ForgeDock:  Investigate → Architect → Build → Quality Gate → Review → open PR
You:        click merge
```

No new runtime, no separate process, no cloud service — just prompt-engineered command specs that run inside the Claude Code you already use.

---

## What You Get

| Capability | How it works |
|---|---|
| **Full-lifecycle automation** | `/work-on #42` — investigates the issue, architects a fix, builds it, runs quality gates, opens a PR, and reviews it. You click merge. |
| **Persistent agent memory** | Structured `FORGE:` annotations on GitHub issues/PRs survive context resets and session boundaries. Agents never start blind. |
| **9 specialist review agents** | Security, billing, database, concurrency, auth, frontend, API, performance, infrastructure — every PR gets domain-expert review. |
| **Institutional memory that compounds** | Agent fixing issue #43 reads the investigation from #42 and applies the known pattern — no re-investigation. |
| **Self-improving pipeline** | Review agents learn from past findings — recurring patterns automatically become new quality gate checks. |
| **Parallel orchestration** | `/orchestrate` decomposes milestones into waves and runs `/work-on` on each in parallel. |

> **Cost note:** ForgeDock itself is free and open-source. It orchestrates Claude Code sessions, so you pay your normal Anthropic API usage. A typical `/work-on` run on a straightforward bug uses roughly the same tokens as a 15–20 minute manual Claude Code session.

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

---

## Install

**Requirements:** [Node.js 18+](https://nodejs.org/), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [GitHub CLI (`gh`)](https://cli.github.com/), [`yq`](https://github.com/mikefarah/yq) (YAML parser used by pipeline commands to read `forge.yaml`), and **[Playwright MCP](https://github.com/microsoft/playwright-mcp)** (browser automation for `/qa-sweep` and visual testing commands)

> **Playwright MCP** is a guaranteed ForgeDock dependency for browser automation commands. Register it in Claude Code after installing ForgeDock:
> ```bash
> claude mcp add playwright npx @playwright/mcp@latest
> ```
> Verify with `npx forgedock doctor` — Check 9 confirms Playwright MCP is registered.

```bash
# Install pipeline commands
npx forgedock

# Generate config for your repo
npx forgedock init
```

This symlinks 25+ pipeline commands into `~/.claude/commands/` and generates a `forge.yaml` config in your project root. That's it — open Claude Code and run `/work-on #42`.

**Try it risk-free:** Follow the [5-minute Getting Started walkthrough](docs/site/getting-started.md) to install, configure, and run your first pipeline end-to-end. New to the commands? Start with the [Command Reference](docs/site/command-reference.md) for a guided tour of what each one does.

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

<details>
<summary><strong>See a real pipeline run</strong></summary>

Here's what a real run looks like on [issue #619](https://github.com/RapierCraftStudios/ForgeDock/issues/619) — a performance bug where command specs were burning ~200K tokens in context:

```
FORGE:INVESTIGATOR  →  CONFIRMED. All 27 command spec files (848KB) load into
                        context at session start via symlinks. ~200K tokens wasted.

FORGE:CONTRACT      →  Replace symlink-based install with stub-file pattern.
                        Installer parses frontmatter, writes minimal stubs.

FORGE:CONTEXT       →  Issue #577: install() had overly broad catch{} — fixed to
                        check err.code === 'ENOENT'. Issue #587: Windows writes
                        regular files, not symlinks — keep both paths working.

FORGE:ARCHITECT     →  3 new functions in bin/forgedock.mjs: parseFrontmatter(),
                        generateStubContent(), updated install() flow.

FORGE:BUILDER       →  Branch feat/stub-install-pattern-619, 1 file changed.

FORGE:REVIEW        →  Auto-merged to staging.

FORGE:TRAJECTORY    →  Full audit trail recorded.
```

The context phase surfaced two historical bugs (#577, #587) in the same module — preventing the builder from repeating known mistakes. [View the full issue →](https://github.com/RapierCraftStudios/ForgeDock/issues/619)

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

## Global Command Namespace

ForgeDock owns the **global** `~/.claude/commands/` namespace. When `npx forgedock` runs, it symlinks all pipeline commands there and writes a `.symlink-source` sentinel file so other installers can detect the owner:

```
~/.claude/commands/
  .symlink-source       ← sentinel: "ForgeDock owns this namespace"
  work-on.md            → /path/to/forgedock/commands/work-on.md
  review-pr.md          → /path/to/forgedock/commands/review-pr.md
  ...
```

**Project-specific commands** should install to the **project-local** `.claude/commands/` directory instead:

```
your-project/
  .claude/
    commands/
      my-custom-command.md   ← project-local — Claude Code merges these in
```

Claude Code merges global (`~/.claude/commands/`) and project-local (`.claude/commands/`) automatically. Project-local commands win on name collisions.

If another tool runs its own install script that targets `~/.claude/commands/`, it will silently repoint ForgeDock's symlinks to its own source path — breaking all ForgeDock commands globally. The `.symlink-source` sentinel is a machine-readable warning to other installers; ForgeDock also emits a per-command warning during `npx forgedock install` when it detects a collision.

---

## Why ForgeDock

AI coding agents forget everything between sessions. They re-investigate the same bugs, miss context from past PRs, and make mistakes that were already caught and fixed last week. There's no institutional memory.

ForgeDock fixes this by using **GitHub itself** as the memory layer. Every pipeline stage writes structured `FORGE:` annotations to issues and PRs. Every downstream agent reads them. When a new session starts — even after Claude's context resets — the agent queries GitHub and picks up exactly where the last one left off.

---

## How Is This Different

ForgeDock is **not another AI coding agent.** It's a set of prompt-engineered command specs (`.md` files) that run inside Claude Code. No new runtime, no separate process, no vendor lock-in beyond what you already use.

| | ForgeDock | Plain Claude Code | Cursor / Windsurf | Devin / Sweep |
|---|---|---|---|---|
| Memory across sessions | Structured annotations on GitHub | CLAUDE.md + manual notes | Per-project context | Proprietary cloud state |
| Autonomous pipeline | Full lifecycle: investigate → merge | Manual, step by step | Autocomplete + chat | Autonomous but opaque |
| Review quality | 9 domain-specialist agents | You review everything | Basic suggestions | Varies |
| Infrastructure needed | None — just `npx forgedock` | None | IDE-specific | Cloud service |
| Codebase visibility | Everything stays on GitHub | Local | Local + cloud sync | Cloud-only |

---

## FAQ — How is ForgeDock different from X?

**vs. DeepWiki (Devin)** — DeepWiki generates a read-only wiki from your codebase once. ForgeDock's FORGE annotations are written by pipeline agents during every issue run — capturing root causes, architectural decisions, and review findings as they happen, not as a snapshot of static code.

**vs. AGENTS.md / CLAUDE.md** — These files are written and maintained by you. They capture conventions and rules. ForgeDock annotations are written automatically by pipeline agents and capture execution history — what bugs were confirmed, what fixes were shipped, what review findings recurred. Use both: CLAUDE.md for conventions, ForgeDock for institutional memory.

**vs. Cursor Memories** — Cursor Memories are scoped to the Cursor IDE's backend and don't survive a Claude Code context reset. ForgeDock annotations live on GitHub — any agent, any tool, any human can read them. When Claude's context window compacts mid-session, a ForgeDock agent queries GitHub and resumes exactly where it left off.

**vs. Devin Knowledge Base** — Devin's KB is proprietary, opaque, and vendor-locked. ForgeDock context is plain GitHub issue comments — readable, editable, and queryable with `gh api`. No vendor lock-in, no black box.

[Full comparison →](docs/comparison.md)

---

## Uninstall

```bash
npx forgedock uninstall
```

Removes all ForgeDock command symlinks from `~/.claude/commands/`. Your `forge.yaml` config and any `FORGE:` annotations on GitHub issues/PRs are left untouched.

---

## Documentation

- [Getting Started in 5 Minutes](docs/site/getting-started.md) — install, configure, first pipeline run
- [How the Knowledge Graph Works](docs/site/how-it-works.md) — FORGE annotations, context relay, compaction resilience
- [What Are Those FORGE Comments?](docs/site/annotations-explained.md) — 2-minute newcomer explainer for the annotations on your issues
- [ForgeDock vs. Manual Workflows](docs/site/vs-manual-workflows.md) — structured pipelines vs. ad-hoc prompting
- [ForgeDock vs. DeepWiki, AGENTS.md, and Cursor Memories](docs/comparison.md) — structural differences between context tools
- [FORGE Annotation Protocol](docs/site/forge-annotation-protocol.md) — open standard spec for AI context passing
- [FORGE Annotation Protocol v1.0 (formal spec)](docs/spec/forge-protocol-v1.md) — standalone, versioned, CC-BY-4.0 specification you can implement in any agent pipeline
- [Command Reference](docs/site/command-reference.md) — all 25+ commands with usage and examples

---

## Star History

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

ForgeDock uses a **dual-licensing model**:

- **[AGPL-3.0](LICENSE)** — free to use, modify, and distribute for open-source and personal use. If you modify ForgeDock and offer it as a service (including over a network), you must open-source your modifications under AGPL-3.0.

- **[Commercial License](COMMERCIAL-LICENSE.md)** — for organizations that need to use ForgeDock in proprietary workflows or products without AGPL-3.0 copyleft obligations. [Contact RapierCraft Studios](mailto:licensing@rapiercraft.studio) to obtain a commercial license.

The open-source core remains free under AGPL-3.0. The commercial license is an exception for customers who cannot meet the copyleft requirements.

---

<div align="center">

<p>Built by <a href="https://github.com/RapierCraftStudios">RapierCraft Studios</a></p>

<a href="https://github.com/sponsors/RapierCraftStudios"><img src="https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa.svg?style=flat-square" alt="Sponsor" /></a>

</div>
