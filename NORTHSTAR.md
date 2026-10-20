# ForgeDock North Star

> Always loaded (via `CLAUDE.md` / `AGENTS.md`). Keep under 2k tokens (CI caps it at 8 KB). If something here conflicts with a command spec, this file wins. Fix the spec.

## What ForgeDock is

Point it at an issue and get a merged, reviewed PR. Point it at a milestone and get parallel pipelines. LLMs write the code. ForgeDock owns everything else: state, scheduling, recovery, review and memory, kept as durable, inspectable structure on GitHub.

**For:** solo builders and small teams who want production-grade software from AI agents without supervising every step.

## What "good" means

These are the numbers we optimize. A change that doesn't move one of them needs a reason.

1. **Correct merges per dollar and per minute.** Cost and wall time per merged issue, from FORGE:TELEMETRY.
2. **Human touches per issue.** `needs-human` rate and manual fixes after merge.
3. **Rework rate.** Remediation runs, reverts and drift-cleanup issues per merged issue.

## Non-negotiables

1. **Deterministic first.** Facts (paths, edges, sizes, labels, states, diffs) come from scripts and structured data. The LLM is used only for judgment, and only when a fact needs it.
2. **Cut waste before adding checks.** A new check must either cost no LLM calls or remove more cost than it adds, such as retries, rework or redone work. "Add an agent" is the last resort, not the default.
3. **GitHub is the register.** All state lives in issues, PRs, labels and FORGE annotations. Local files are caches that can be rebuilt. Any run can resume from GitHub alone.
4. **Gates must mean something.** A gate that almost always fires, or never fires, is a bug. Fix its inputs, don't ignore its output. Shadow mode is a calibration period with an exit criterion, not a permanent state.
5. **Never lose work.** Nothing destroys uncommitted work or a running agent's directory without first saving it and stopping the agent.
6. **Use the target repo's own truth.** Its toolchain pins, lint and boundary config, architecture docs and CI are authoritative. ForgeDock reads and runs them and doesn't reimplement them. "The lint allows it" is not "the design allows it".
7. **Specs stay small.** Procedure goes into scripts. Specs hold only judgment and routing. Every spec has a size budget.
8. **Open-core boundary.** This repo is AGPL. Never import, embed or copy code to or from `forgedock-platform`. They share only data contracts (HTTP, JSON, annotations, `forge.yaml`).

## Where a fix belongs (Pipeline Hardening Principles)

When something slips through, put the fix in the **earliest, cheapest** layer that would have stopped it:

| Layer | Use for | Cost |
|---|---|---|
| 1. Issue spec / plan rule | wrong instructions going in | zero, at write time |
| 2. Builder rule | simple, memorable "don't do X" | zero |
| 3. Deterministic check (script, quality gate) | anything a script can detect exactly | ~zero, milliseconds |
| 4. Domain detection | which judgment to call, decided from facts | ~zero |
| 5. Review prompt line | judgment that needs a fact in front of it | one line in an existing call |
| 6. New agent | judgment no existing call can cover | expensive: justify it with numbers |

Never put a reasoning problem in a grep, and never put a grep-able pattern in a prompt.

## Runtime map

| Path | Role | Status |
|---|---|---|
| `bin/lean/*` | lean engine: lanes, contract, conformance, merge (dossier: `devdocs/modules/lean.md`) | **canonical runtime** — `forgedock run-issue` defaults to the core path (`bin/engine-cli.mjs` `enginePath ?? "core"`) |
| `bin/engine*.mjs`, `bin/runner.mjs` | engine CLI, runner spawning, leases, outcome codes | canonical |
| `scripts/*` | deterministic layer (routing, dedup, checks) | canonical |
| `scripts/test-map.sh`, `scripts/repo-facts.sh` | regenerable repo caches `.forge/test-map.json` (picks the pre-PR checks for the changed files) and `.forge/repo-facts.json` (cited to the builder by path); deleting them restores `learned.test_commands` and today's prompts | canonical, optional (#4272) |
| `commands/*.md` | skill specs: interactive entrypoints and judgment prompts | specs; the lean engine does not load them |
| `commands/work-on/*` full path, `run-issue --path full` | multi-phase prose pipeline | **legacy** (opt-in only) |
| `packages/protocol/` | FORGE annotation library (MIT) | canonical |
| `devdocs/` | module dossiers and decisions | must match this map |

## Changing ForgeDock

1. Read this file, then `devdocs/index.yaml` → the dossier for the module you're touching.
2. A behaviour change in `bin/lean/` or `scripts/` updates its dossier, this runtime map or a new decision record in the same PR. CI enforces this (`scripts/check-devdocs-freshness.sh`; exempt with a `docs-not-needed: <reason>` line in the PR body).
3. Non-obvious choices get a short record in `devdocs/decisions/<issue>-<slug>.md` (context, choice, rejected options).
4. Prefer deleting and simplifying over adding. Report the cost delta of the change (tokens, wall time or calls) in the PR.

## Anti-goals

- More agents, longer prompts or extra review passes as the default fix.
- Shadow-forever gates, warnings nobody reads.
- Hidden local state that a fresh run can't rebuild from GitHub.
- Reimplementing a target repo's tooling (parsers, linters, test discovery) when it already has its own.
