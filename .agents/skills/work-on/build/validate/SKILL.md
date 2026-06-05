---
name: work-on-build-validate
description: Validate Forge build changes from Codex with Forge-aware quality gate and installer checks.
---

# Forge Repo Adapter: work-on/build/validate

Use `commands/work-on/build/validate.md` for gate-loop semantics, but apply these Forge repo overrides when the changed files are in this repository:

## Quality Gate Mapping

- When the shared workflow invokes `Skill("quality-gate")`, use the repo-local Forge adapter at `.agents/skills/quality-gate/SKILL.md` or the installed `forge-quality-gate` skill.
- Keep the 3-iteration gate loop and `GATE_PASSED` contract unchanged.

## Forge Repo Validation Rules

For Forge repo changes:
- Run `bash -n` on every changed `*.sh` file.
- If `install-codex.sh` changed, always run `bash -n install-codex.sh`.
- If `install.sh` changed, always run `bash -n install.sh`.
- If the Codex layer changed (`AGENTS.md`, `docs/CODEX.md`, `.agents/skills/**`, `install-codex.sh`), verify naming/path consistency against `commands/**/*.md`.
- If behavior changed in commands, docs, or installers, verify `CHANGELOG.md` was updated.

## Skip/Format Override

If the changed files are only Markdown/docs/skill files with no executable shell changes, skip language-specific format/build steps from the shared workflow and treat the quality gate plus reference consistency checks as the required validation surface.

Return the same structured `VALIDATE_RESULT` block expected by the shared workflow.
