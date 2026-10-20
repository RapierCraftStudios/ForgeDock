---
issue: 4177
status: fresh
anchor: bin/bootstrap.mjs
created: 2026-10-20
---

# ADR: `forgedock bootstrap` is a thin headless entry with a deterministic plan mode

## Context

#4176 shipped `/bootstrap` (`commands/bootstrap.md`) and `scripts/bootstrap-create.mjs`, which does validation, the dry-run preview and resumable creation. The scripts could only be reached with `node scripts/...`. `forgedock run bootstrap --dry-run` couldn't stand in: `run` takes `--dry-run` as its own prompt-preview flag, so the spec never saw it. The dry-run preview had no cost estimate.

## Decision

- `bin/bootstrap.mjs` `runBootstrap` has two modes:
  - **Plan mode** (`--plan <plan.json>`) delegates to `bootstrap-create.mjs` `main()` and makes no LLM call.
  - **Idea mode** runs `commands/bootstrap.md` through `runCommand`. `--dry-run` and `--spike` are passed as spec arguments, never as the runner's `dryRun`. Headless, the spec takes each recommended option and lists it among the assumptions.
- **Resume means re-running against GitHub.** `createBacklog` already reuses the spike, milestones, branches, issues (title + `**Parent**`) and marker comments, so there is no local resume state (NORTHSTAR #3).
- **The cost estimate is a flat rate per build issue**: `plan.costPerIssueUsd`, then `--cost-per-issue`, then `DEFAULT_ISSUE_COST_USD` = 3. Needs-human issues and the spike are excluded. The preview labels the result as an estimate.

## Rejected

- Changing `forgedock run`'s `--dry-run` semantics. That would break the existing prompt preview.
- A per-diff-line cost model, or reading FORGE:TELEMETRY at preview time. Greenfield plans have no history, and a dry run must not touch GitHub.
