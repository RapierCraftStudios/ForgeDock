<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /work-on runtime architecture: phases, forks and nesting depth

This document defines how the `/work-on` router runs its phases on Claude Code, and why.
It is the source of truth for which skills fork, who may invoke them, and where sub-agents
can be spawned. `commands/work-on.md` (Hard Rules, Spawn-Decision Policy, Depth Budget) must
agree with it.

## 1. Runtime facts

| # | Fact | Source |
|---|------|--------|
| F1 | A sub-agent can spawn sub-agents up to **3 layers below the main conversation** (default since Claude Code 2.1.219). At the limit, the `Agent` tool is withheld. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` overrides the limit. Earlier defaults: 2.1.172–2.1.216 = 5 layers, 2.1.217–2.1.218 = 1 layer. | code.claude.com/docs/en/sub-agents |
| F2 | A skill with `context: fork` starts a **new sub-agent** (type from `agent:`, default `general-purpose`) with the skill body as its prompt. It counts as a layer, sees no caller history, and returns only its final reply. | code.claude.com/docs/en/skills |
| F3 | A forked skill runs **in the background by default**: the invoking turn does not wait and the result arrives later as a notification to the main conversation. `background: false` makes the invoking turn wait for the result. | code.claude.com/docs/en/skills |
| F4 | Measured on 2.1.294 with plain agents: layer 1 and layer 2 have `Agent`; layer 3 does not. | probe, 2026-10-08 (forge#3398) |
| F5 | Measured on 2.1.294 with forked skills: a fork **always runs**, at any layer (a fork invoked from layer 3 ran at layer 4). Only its `Agent` tool follows F1: a fork at layer 2 has `Agent`, a fork at layer 3 or deeper does not. | probe, 2026-10-08 (forge#3398) |

So the depth limit constrains exactly one thing: **where a sub-agent can be spawned**. Forking
for context isolation is free at any depth; spawning `Agent(...)` sub-agents only works from layer 2
or shallower (under the default limit of 3).

F3 explains two field symptoms: phases returning "running"/empty results to the router, and phase
completion notifications arriving in the orchestrator's root session instead of the worker.

## 2. Observed failure (forge#3391, AlterLab#34442)

```
orchestrator (main, L0)
 └─ worker Agent: /work-on router                L1
     └─ work-on:review (fork)                     L2
         └─ work-on:remediate (fork, nested)      L3  ← fork runs, but has no Agent tool
             └─ review-pr domain reviewers        L4  ← cannot be spawned
```

`commands/work-on/review.md` invoked `work-on:remediate` from inside the review fork (the CI-gate and
in-PR-fix paths). Remediation still ran, but at L3 its re-review could not spawn reviewers, so it
posted `REREVIEW-REQUIRED` and stranded the issue. The normal path (worker L1 → review L2 → reviewers
L3) works, which is why most PRs are reviewed normally.

## 3. Design rules

**R1 — Dispatching phases are invoked only by the router.** A *dispatching* phase is one that spawns
`Agent(...)` sub-agents directly or through `/review-pr`: `work-on:review` and `work-on:remediate`.
Only the router may invoke them, so they always run at router layer + 1 (L2 under `/orchestrate`,
L1 solo). When another phase needs one, it returns a handoff (`status: NEXT`, `next: <phase>`) and
the router invokes it. Concretely: review returns `next: remediate` instead of calling remediation.

**R2 — Non-dispatching forks may nest.** Phases and children that never spawn sub-agents may invoke
further forks at any depth (F5): build → context/architect/implement/validate → quality-gate,
review → quality-gate / missing-phase re-dispatch, remediate → close. Forking them keeps each
context small. If one of them ever needs to spawn sub-agents, it becomes a dispatching phase and
R1 applies.

**R3 — Phases run synchronously.** Every forked phase and child declares `background: false`, so a
`Skill(...)` call returns the `*_RESULT` block in the caller's turn. The "running/empty return"
handling in the router's Hard Rule 3a stays as a defensive fallback only.

**R4 — Depth preflight, fail loud.** Router Phase 0 checks that a dispatching phase will have the
`Agent` tool: router layer + 2 ≤ effective spawn depth (router layer 1 with `--under-orchestration`,
else 0; depth from `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, else the Claude Code version default).
If not, the router stops before any work with a clear blocker instead of discovering it after the
code is written (`scripts/spawn-depth-check.sh`).

**R5 — Fallbacks stay fallbacks.** `REREVIEW_REQUIRED` (forge#3240) and the stranded-handoff
handling from forge#3391 / PR #3395 remain as safety nets for an unexpected runtime, not as the
normal remediation path.

## 4. Layer map

| Skill | Fork | Dispatches sub-agents | Invoked by | Layer solo / orchestrated |
|-------|------|-----------------------|------------|---------------------------|
| `work-on` (router) | — | no | user / orchestrator worker | 0 / 1 |
| `work-on:investigate`, `work-on:decompose`, `work-on:build`, `work-on:close` | yes | no | router | 1 / 2 |
| `work-on:build:{context,architect,implement,validate}` | yes | no | `work-on:build` (R2) | 2 / 3 |
| `quality-gate` | yes | no | validate (R2) | 3 / 4 |
| `quality-gate` (stale-review re-gate) | yes | no | review (R2) | 2 / 3 |
| `work-on:review` → `/review-pr` | yes | **yes** | router only (R1) | 1 / 2 |
| `work-on:remediate` → `/review-pr` | yes | **yes** | router only (R1) | 1 / 2 |
| `/review-pr` domain reviewers | Agent | no (leaves) | `/review-pr` | 2 / 3 |

`/orchestrate` Step 4B item 6.4 dispatches a worker that runs `work-on <pr> --remediate`: worker L1,
remediate L2, reviewers L3, same as the table.

## 5. Router routing

| Phase result | Router action |
|--------------|---------------|
| `REVIEW_RESULT: status: NEXT, next: remediate` | Phase 4R: post the bound marker (`CI_REMEDIATION` / `INPR_REMEDIATION`) immediately before invoking `work-on:remediate`, so an interrupted handoff is retried, not counted. `AUTO-LANDED` → done (remediation already ran close). `REREVIEW_REQUIRED` → fallback re-review from the router. `ALREADY_DONE` (single-attempt guard) → `inpr-fix`: re-invoke review (waive); `ci-gate`: ensure `needs-human`, stop. `BLOCKED` → ensure `needs-human`, stop. Resume after an interrupted remediation (no `needs-human`, no later `REMEDIATION:COMPLETE`) re-adds `needs-human` and returns to 4R, not to review. Other outcome: `inpr-fix` → re-invoke review once (it waives the in-PR gate); `ci-gate` → terminal. |
| `REMEDIATE_RESULT` from `--remediate` entry | unchanged (Phase 0A.1) |

## 6. What does not change

- Build still sequences its own children; the headless engine (`bin/engine/phases.mjs`) is unaffected.
- `/orchestrate` still dispatches one worker `Agent` per issue (L1).
- Phases keep their specs, `*_RESULT` contracts and GitHub markers; phase-trail verification is unchanged.
- Solo `/work-on` gets one extra layer of headroom.
