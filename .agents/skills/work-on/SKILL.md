---
name: work-on
description: Pick up a GitHub issue and run the full investigate-build-review-merge pipeline for Forge from Codex.
---

# Forge Repo Adapter: work-on

Use `commands/work-on.md` as the authoritative state-machine source, but apply the Forge repo overrides below when running from Codex in this repository.

## Repo Resolution Override

Inside the Forge repo, resolve issue targets like this unless the user explicitly prefixes another project:

| Input | Repo |
|---|---|
| `123`, `#123`, `next`, empty | `RapierCraftStudios/forge` |
| `forge:123` | `RapierCraftStudios/forge` |
| `alterlab:123` | `RapierCraft/AlterLab` |
| `mcp:5` | `RapierCraft/alterlab-mcp-server` |
| `n8n:12` | `RapierCraft/n8n-nodes-alterlab` |

For Forge repo issues, set:
- `GH_REPO=RapierCraftStudios/forge`
- `GH_FLAG=--repo RapierCraftStudios/forge`
- `REPO_PATH=/home/mrdubey/projects/forge`
- `STAGING_BRANCH=staging`
- `DEFAULT_BRANCH=main`

## Codex Runtime Overrides

- Treat any `.claude/worktrees/...` example path in the shared command spec as `.codex/worktrees/...` for Codex execution in this repo.
- Create and reuse worktrees under `/home/mrdubey/projects/forge/.codex/worktrees`.
- Prefer `gh api repos/{GH_REPO}/issues/{NUMBER}/comments` for comment reads instead of `gh issue view --comments`.
- Treat GitHub Project-board sync as best-effort only for Forge issues. Do not block the pipeline if Forge-specific board/component mappings are absent.
- Create missing `workflow:*` labels on demand if the Forge repo does not already have them.

## Forge Repo File Scope

When the shared workflow says to inspect domain files, prioritize Forge repo files instead:
- `commands/**/*.md`
- `docs/**/*.md`
- `scripts/**/*.sh`
- `install.sh`, `install-codex.sh`, `update.sh`
- `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`
- `.agents/skills/**/*.md`

## Subcommand Mapping

When `commands/work-on.md` invokes nested skills, use these Codex adapters:
- `work-on:investigate` -> repo-local `.agents/skills/work-on/investigate/SKILL.md`
- `work-on:build` -> repo-local `.agents/skills/work-on/build/SKILL.md`
- `work-on:review` -> repo-local `.agents/skills/work-on/review/SKILL.md`
- `work-on:close` -> installed `forge-work-on-close`
- `work-on:decompose` -> installed `forge-work-on-decompose`

If an installed `forge-*` skill exists for the nested command, use it. Otherwise read the referenced shared command file directly and continue manually.

## Execution Rule

Preserve the shared Forge behavior from `commands/work-on.md`: GitHub state is the memory layer, `FORGE:*` comments remain machine-readable, and the routing loop continues until an explicit terminal condition is reached.
