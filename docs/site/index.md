---
title: "ForgeDock Documentation"
description: "Official documentation for ForgeDock — the autonomous AI development pipeline that uses GitHub as a structured knowledge graph for Claude Code agents."
keywords: ["forgedock docs", "claude code pipeline", "ai agent documentation", "forgedock guide"]
---

# ForgeDock Documentation

ForgeDock is an autonomous development pipeline for Claude Code. You open a GitHub issue, type `/work-on`, and an AI agent investigates the problem, architects a solution, builds it, runs quality checks, reviews it with 9 specialized agents, and merges the PR.

No more coordinating between agent sessions. No more lost context. No more starting from scratch.

---

## Get Started

**New to ForgeDock?** Start here:

- **[Getting Started in 5 Minutes](./getting-started.md)** — Install, configure, and run your first pipeline
- **[How It Works](./how-it-works.md)** — The knowledge graph architecture explained

---

## Guides

| Page | What You'll Learn |
|------|-------------------|
| [Getting Started](./getting-started.md) | Install ForgeDock, configure forge.yaml, run `/work-on` on your first issue |
| [How It Works](./how-it-works.md) | FORGE annotations, the pipeline relay, compaction resilience, workflow labels |
| [ForgeDock vs. Manual Workflows](./vs-manual-workflows.md) | Why structured pipelines beat ad-hoc Claude Code sessions |
| [FORGE Annotation Protocol](./forge-annotation-protocol.md) | Technical spec — annotation types, completion markers, querying |
| [Command Reference](./command-reference.md) | All 25+ commands with usage, options, and examples |

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

Symlinks all commands into `~/.claude/commands/`. No global install, no dependencies.

**Requirements**: Claude Code, Node.js 18+, `gh` CLI authenticated with GitHub.

---

## License

ForgeDock is open source under the [AGPL-3.0 license](https://github.com/RapierCraftStudios/ForgeDock/blob/main/LICENSE).
