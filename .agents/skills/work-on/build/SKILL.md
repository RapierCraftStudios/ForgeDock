---
name: work-on-build
description: Build a Forge issue from Codex using Codex-native worktrees and Forge-aware subcommand routing.
---

# Forge Repo Adapter: work-on/build

Use `commands/work-on/build.md` as the authoritative build-phase workflow, with these Forge repo overrides:

- Default repo context is `RapierCraftStudios/forge`.
- Rewrite any `.claude/worktrees/...` path assumption to `/home/mrdubey/projects/forge/.codex/worktrees/...`.
- Ensure `/home/mrdubey/projects/forge/.codex/worktrees` exists before creating worktrees.
- Keep milestone/staging branch behavior from the shared workflow unless the issue explicitly says otherwise.

## Subcommand Mapping

Use these adapters when the shared workflow invokes nested skills:
- `work-on:build:context` -> installed `forge-work-on-build-context`
- `work-on:build:architect` -> installed `forge-work-on-build-architect`
- `work-on:build:implement` -> installed `forge-work-on-build-implement`
- `work-on:build:validate` -> repo-local `.agents/skills/work-on/build/validate/SKILL.md`
- `quality-gate` -> repo-local `.agents/skills/quality-gate/SKILL.md`

## Forge Repo Build Scope

For Forge issues, expected deliverables usually live in:
- `commands/**/*.md`
- `.agents/skills/**/*.md`
- `docs/**/*.md`
- `scripts/**/*.sh`
- `install.sh`, `install-codex.sh`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`

Preserve the shared builder contract, context, architect, implement, and validate sequencing from `commands/work-on/build.md`. Only the repo defaults, worktree root, and nested-skill mapping change here.

## Continuation Rule

Outputting `BUILD_RESULT:` does **NOT** terminate the pipeline. This result block is an intermediate signal for the `work-on.md` routing loop — not a final answer. After this subcommand completes, control returns to the routing loop in `commands/work-on.md`, which re-reads GitHub state and dispatches to the next phase (review). Do **not** treat the result block as a completion signal — the pipeline continues.
