---
name: work-on-investigate
description: Investigate a Forge GitHub issue from Codex and post a FORGE:INVESTIGATOR report.
---

# Forge Repo Adapter: work-on/investigate

Use `commands/work-on/investigate.md` as the authoritative investigation workflow, with these Forge repo overrides:

- Default repo context is `RapierCraftStudios/forgedock`.
- Read/write issue comments via `gh api repos/RapierCraftStudios/forgedock/issues/{NUMBER}/comments`.
- Use `FORGE:*` markers as the primary resume protocol.
- Treat missing workflow labels as normal in this repo; create them when needed instead of failing.

## Forge Repo Key Files

Prioritize these files when the issue is in the Forge repo:
- `commands/work-on.md`
- `commands/review-pr.md`
- `commands/quality-gate.md`
- `commands/orchestrate.md`
- `commands/milestone.md`
- `install.sh`, `install-codex.sh`
- `AGENTS.md`, `CLAUDE.md`, `docs/CODEX.md`, `docs/WORKFLOW.md`
- any changed or referenced file under `commands/`, `docs/`, `scripts/`, or `.agents/skills/`

## Investigation Rule

If the shared command’s domain table references project-specific paths that are not relevant to this repo, replace it with the Forge repo file set above and continue with the same output contract: post a `<!-- FORGE:INVESTIGATOR -->` comment, update labels best-effort, and return the structured investigate result.

## Continuation Rule

Outputting `INVESTIGATE_RESULT:` does **NOT** terminate the pipeline. This result block is an intermediate signal for the `work-on.md` routing loop — not a final answer. After this subcommand completes, control returns to the routing loop in `commands/work-on.md`, which re-reads GitHub state and dispatches to the next phase (build, decompose, or INVALID stop). Do **not** treat the result block as a completion signal — the pipeline continues.
