---
name: work-on-review
description: Push a Forge worktree branch, create a PR, and delegate review through the Forge Codex review adapter.
---

# Forge Repo Adapter: work-on/review

Use `commands/work-on/review.md` as the authoritative PR-creation workflow, with these Forge repo overrides:

- Default repo context is `RapierCraftStudios/forgedock`.
- After push/PR creation, route review to the repo-local Forge review adapter instead of assuming the project’s external review environment.
- Preserve `FORGE:REVIEW_STARTED`, `REVIEW_RESULT`, merge verification, and issue-closing behavior from the shared workflow.

## Review Delegation Override

When the shared workflow says:
- `Skill(skill="review-pr", args="...")`

Route that to:
- repo-local `.agents/skills/review-pr/SKILL.md`
- or installed `forge-review-pr` if the local adapter has been wrapped by the installer

## Review Focus for Forge PRs

For Forge repo pull requests, prioritize:
- pipeline state-machine correctness
- nested skill routing correctness
- `gh` / `git` command correctness
- installer side effects and namespace safety
- stale `.claude`-only assumptions when Codex-layer files changed
- docs and changelog coverage

Keep the shared workflow’s PR creation, auto-merge handoff, and post-merge verification behavior unchanged.

## Continuation Rule

Outputting `REVIEW_RESULT:` does **NOT** terminate the pipeline. This result block is an intermediate signal for the `work-on.md` routing loop — not a final answer. After this subcommand completes, control returns to the routing loop in `commands/work-on.md`, which re-reads GitHub state and dispatches to the next phase (close). Do **not** treat the result block as a completion signal — the pipeline continues.
