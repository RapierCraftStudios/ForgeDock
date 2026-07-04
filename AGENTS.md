# Forge for Codex

Forge is a workflow-spec repository. The shared source of truth lives in `commands/`.

Claude Code support remains intact:
- `install.sh` installs slash-command symlinks into `~/.claude/commands`
- `CLAUDE.md` remains the Claude-oriented project reference

Codex support is additive:
- `install-codex.sh` installs Codex-native, namespaced Forge skills into `~/.codex/skills`
- `docs/CODEX.md` explains the runtime mapping and usage model
- `.agents/skills/**/*.md` provides repo-local Codex overrides for workflows that need Forge-specific defaults

## Codex Entry Model

After running `./install-codex.sh`, Codex gets:
- `forge` — high-level router/overview skill
- `forge-<command>` — one installed skill per shared command spec
- `forge-work-on-investigate`, `forge-work-on-build`, etc. for nested command files under `commands/work-on/`

Skill names are generated from command paths by:
- prefixing with `forge-`
- replacing `/` with `-`
- removing `.md`

Examples:
- `commands/work-on.md` -> `forge-work-on`
- `commands/review-pr.md` -> `forge-review-pr`
- `commands/work-on/investigate.md` -> `forge-work-on-investigate`

## Runtime Rules

- Treat `commands/**/*.md` as the authoritative workflow spec.
- Preserve GitHub labels, structured comments, branch conventions, and changelog discipline across runtimes.
- Prefer Codex-native tools for shell, file, git, and web work rather than emulating Claude-specific mechanics.
- Translate `Skill(...)`, `Agent(...)`, and `Task(...)` semantics into Codex-native continuation and sub-agent behavior instead of skipping phases.
- Do not modify or overwrite existing Claude install paths when working on the Codex layer unless the shared workflow spec itself is changing.

## Scope Boundaries

- This repo is not an app service; it is the Forge pipeline itself.
- `commands/review-pr-agents.md` is a catalog read by other workflows, not a primary user entrypoint.
- The Codex layer should wrap the existing command system, not fork it into a separate copy.
- Repo-local Codex skills may override repo defaults from shared command specs when Forge-specific behavior differs from project-specific upstream assumptions.

## First References

Read these first when operating Forge from Codex:
- `docs/CODEX.md`
- `CLAUDE.md`
- the relevant file in `commands/`

Notable commands for security work:
- `commands/security-audit.md` — periodic security posture audit (4-phase checklist against repo files, not diffs)
