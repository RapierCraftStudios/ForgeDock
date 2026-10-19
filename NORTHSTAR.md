<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ForgeDock North Star

> Always loaded. Keep under 2k tokens. If something here conflicts with a command spec, this file wins. Fix the spec.

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

## Where a fix belongs (hardening layers)

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
| `bin/lean/*` | lean engine: lanes, contract, conformance, merge | **canonical runtime** |
| `bin/engine*.mjs`, `bin/runner.mjs` | engine CLI, runner spawning, leases | canonical |
| `scripts/*` | deterministic layer (routing, dedup, checks) | canonical |
| `commands/*.md` | skill specs: interactive commands and judgment prompts | canonical for slash commands (`/issue`, `/audit`, `/review-pr`, …) |
| `commands/work-on/*` full path, `/orchestrate --path full` | multi-phase prose pipeline | **legacy**, superseded by `bin/lean/` |
| `packages/protocol/` | FORGE annotation library (MIT) | canonical |
| `devdocs/` | module dossiers and decisions | must match this map |

## Changing ForgeDock

1. Read this file, then `devdocs/index.yaml` → the dossier for the module you're touching.
2. A behaviour change in `bin/lean/` or `scripts/` updates its dossier and this runtime map in the same PR. CI enforces this.
3. Non-obvious choices get a short record in `devdocs/decisions/<issue>-<slug>.md` (context, choice, rejected options).
4. Prefer deleting and simplifying over adding. Report the cost delta of the change (tokens, wall time or calls) in the PR.

## Anti-goals

- More agents, longer prompts or extra review passes as the default fix.
- Shadow-forever gates, warnings nobody reads.
- Hidden local state that a fresh run can't rebuild from GitHub.
- Reimplementing a target repo's tooling (parsers, linters, test discovery) when it already has its own.
