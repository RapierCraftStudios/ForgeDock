---
title: "ForgeDock Documentation"
description: "Official documentation for ForgeDock — the autonomous AI development pipeline that uses GitHub as a structured knowledge graph for Claude Code agents."
keywords: ["forgedock docs", "claude code pipeline", "ai agent documentation", "forgedock guide"]
---

# ForgeDock Documentation

ForgeDock is an autonomous development pipeline for Claude Code. You open a GitHub issue, type `/work-on`, and an AI agent investigates the problem, architects a solution, builds it, runs quality checks, reviews it with 9 specialized agents, and merges the PR.

No more coordinating between agent sessions. No more lost context. No more starting from scratch.

---

## The core idea

**[GitHub Is Already Your Agents' Memory](./github-is-the-memory.md)** — Why agents re-derive everything from scratch every session, why sidecar stores duplicate what GitHub already records, and how FORGE annotations make the existing citation graph machine-readable. This is the canonical explanation of why ForgeDock works the way it does.

---

## Get Started

**New to ForgeDock?** Start here:

- **[Getting Started in 5 Minutes](./getting-started.md)** — Install, configure, and run your first pipeline
- **[How It Works](./how-it-works.md)** — The knowledge graph architecture explained

---

## Guides

| Page | What You'll Learn |
|------|-------------------|
| [GitHub Is Already Your Agents' Memory](./github-is-the-memory.md) | The memory problem, FORGE annotations, the knowledge graph argument, and the open protocol |
| [Getting Started](./getting-started.md) | Install ForgeDock, configure forge.yaml, run `/work-on` on your first issue |
| [How It Works](./how-it-works.md) | FORGE annotations, the pipeline relay, compaction resilience, workflow labels |
| [ForgeDock vs. Manual Workflows](./vs-manual-workflows.md) | Why structured pipelines beat ad-hoc Claude Code sessions |
| [FORGE Annotation Protocol](./forge-annotation-protocol.md) | Technical spec — annotation types, completion markers, querying |
| [Command Reference](./command-reference.md) | All 25+ commands with usage, options, and examples |
| [For Companies](./for-companies.md) | AGPL vs. commercial license, fleet layer, design-partner program, procurement facts |

---

## Quick Links

- [GitHub Repository](https://github.com/RapierCraftStudios/ForgeDock)
- [npm Package](https://www.npmjs.com/package/forgedock)
- [Configuration Reference](https://github.com/RapierCraftStudios/ForgeDock/blob/main/docs/CONFIG.md)
- [Report an Issue](https://github.com/RapierCraftStudios/ForgeDock/issues/new)

---

## Install

```bash
npx forgedock
```

Installs commands into `~/.claude/commands/`, available in every Claude Code session on this machine. `--global` is still accepted as a flag for backward compatibility, but install is always global — there's nothing to opt into.

**Requirements**: Claude Code, Node.js 18+, `gh` CLI authenticated with GitHub.

---

## License

ForgeDock is open source under the [AGPL-3.0 license](https://github.com/RapierCraftStudios/ForgeDock/blob/main/LICENSE).
