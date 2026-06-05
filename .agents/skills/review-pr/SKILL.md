---
name: review-pr
description: Review Forge pull requests from Codex with Forge-aware heuristics and the shared Forge verdict/merge model.
---

# Forge Repo Adapter: review-pr

Use `commands/review-pr.md` as the lifecycle source for review phases, GitHub outputs, and merge semantics, but override the AlterLab-specific repo assumptions when the PR belongs to `RapierCraftStudios/forge`.

## Forge Repo Review Override

For Forge repo PRs:
- Do not require AlterLab service paths like `services/api`, `services/worker`, or `web/`.
- Do not depend on `commands/review-pr-agents.md` as an authoritative domain catalog; it remains reference-only for the shared command system.
- Do not route Forge PRs into `review-pr-staging` solely because the base/head pair matches staging patterns. Continue in a Forge-aware full review flow in this adapter.

## Forge Review Categories

Replace the shared command’s service/domain classification with these categories:
- **Router / state machine**: `commands/work-on.md`, `commands/orchestrate.md`, `commands/milestone.md`, `commands/review-pr.md`
- **Nested pipeline modules**: `commands/work-on/**`
- **Runtime / installer layer**: `install.sh`, `install-codex.sh`, `AGENTS.md`, `CLAUDE.md`, `docs/CODEX.md`
- **Verification scripts**: `scripts/**`
- **Docs / changelog alignment**: `docs/**`, `CHANGELOG.md`

## Forge Review Checks

Run the shared review lifecycle, but use Forge-relevant checks:
- `bash -n` on changed shell scripts
- stale reference scan for outdated `.claude/commands`, `.claude/worktrees`, deleted docs, or wrong repo-local paths
- nested skill mapping sanity: `Skill("work-on:...")` / `Skill("review-pr...")` references touched by the PR still correspond to installed `forge-*` skills or repo-local adapters
- installer sanity: if `install-codex.sh` changed, verify it still generates namespaced skills and does not overwrite unrelated global skills
- changelog coverage for meaningful workflow behavior changes

## Review Fan-Out

Use Codex sub-agents only when the diff justifies it. Good fan-out slices for Forge PRs are:
- workflow/state-machine reviewer
- GitHub/CLI integration reviewer
- runtime/installer reviewer
- docs/changelog reviewer

## Output Contract

Keep the shared review-pr output behavior:
- evidence-based findings only
- structured findings when reporting issues
- GitHub comment summary
- issue creation for real findings
- merge/approve behavior compatible with `work-on/review`
