---
name: quality-gate
description: Run a Forge-aware pre-commit quality gate from Codex.
---

# Forge Repo Adapter: quality-gate

Use `commands/quality-gate.md` as the source for gate semantics and PASS/FAIL behavior, but replace app-specific domain checks with Forge repo checks when the changed files belong to this repository.

## Forge Domain Classification

Classify changed files like this:
- `commands/**/*.md` -> `COMMANDS`
- `.agents/skills/**/*.md` -> `SKILLS`
- `docs/**/*.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md` -> `DOCS`
- `install*.sh`, `scripts/**/*.sh`, `update.sh` -> `SHELL`

Always include `CONSISTENCY` for Forge repo changes.

## Forge Checks

### COMMANDS / SKILLS
- stale path/reference scan for obsolete `.claude/commands`, `.claude/worktrees`, or deleted file references
- verify nested `Skill("...")` references still map cleanly to `forge-*` adapters or repo-local skills
- verify changed workflow text does not silently bypass labels, `FORGE:*` comments, or routing-loop continuation

### SHELL
- run `bash -n` on every changed shell script
- if installer scripts changed, verify namespacing and non-destructive behavior are preserved

### DOCS
- if runtime behavior changed, ensure `CHANGELOG.md` was updated
- if Codex adapter behavior changed, ensure `AGENTS.md` and `docs/CODEX.md` remain aligned

## PASS / FAIL Rule

Return PASS only when the changed Forge files are internally consistent, shell scripts parse, and no high-severity workflow regression is visible from the diff.

Keep the shared quality-gate contract: HIGH/MEDIUM findings are blocking, LOW findings are advisory.
