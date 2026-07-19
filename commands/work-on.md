---
description: Pick up a GitHub issue and run the full investigate-build-review-merge pipeline
argument-hint: "[issue number or \"next\" to pick highest priority]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /work-on — Full Issue Pipeline

**Input**: $ARGUMENTS

Orchestrator for the full issue lifecycle: investigate → decompose (if needed) → build → review → merge → close. GitHub issues are the persistent context layer — read comments before starting, write structured reports back, use `workflow:*` labels to track state.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — from forge.yaml `agents.default_model`, else "sonnet". Fallback `model: "opus"` if rate-limited. Pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
Plan mode: see `commands/shared/agent-policies.md` § Plan mode ban if not already in context.
**NEVER use the Agent tool** for sub-phase dispatch — it spawns opaque subprocesses that skip FORGE annotations and phase protocols. Always use `Skill(skill="...", args="...")`.

<!-- FORGE:SPEC_LOADED — work-on.md loaded and active. Agent is bound by this spec. -->

## HARD RULES — READ BEFORE ANYTHING ELSE

1. **Every sub-phase MUST be invoked via `Skill(...)`.** Do NOT implement inline — invoke `Skill(skill="work-on/investigate", ...)`, `Skill(skill="work-on/build", ...)`, etc. This is what triggers label updates, FORGE annotations, and structured output; without it, the phase has no paper trail.

2. **Write to GitHub after EVERY phase.** Every FORGE annotation (HEARTBEAT, INVESTIGATOR, CONTRACT, BUILDER, etc.) must be posted before the next phase starts — a phase that completes without a GitHub write is invisible to the stall detector and future sessions.

3. **Follow the Universal Phase Dispatcher.** The phase sequence table is the SINGLE source of truth for transitions. Do NOT skip/reorder phases or treat intermediate completions as terminal — only the terminal states listed below allow stopping.

4. **PRs NEVER target `main`.** Target `staging` (fast lane) or `milestone/{slug}` (feature lane) regardless of what the issue description says.

### Compaction Resilience

1. Write state to GitHub after EVERY significant step.
2. Read full GitHub state (issue body + comments + labels) ONCE, in Phase 0B. Carry those values in-context for the rest of the run — do NOT re-fetch at later phase boundaries. Re-fetch ONLY a value genuinely absent from this session's visible context (compaction dropped it, or this is a fresh resume) — never the full state, just the missing piece.
3. After compaction: re-read issue (body + comments + labels) to reconstruct state.
4. Key principle: a NEW session running `/work-on {number}` picks up where the last left off by reading GitHub state alone.

**Session state cache convention**: reuse a value this session already produced (e.g. `ISSUE_BODY` from Phase 0B) instead of re-running `gh issue view`/`gh api .../comments` "for safety." Phase 6A's body read is a deliberate exception — it precedes a body-mutating write and Phase 5 can involve an external `/review-pr` process.

### Orchestration Flag

`UNDER_ORCHESTRATION` — resolved once in Phase 0A, from `--under-orchestration` in the invocation args (defaults `false`). This is how `/orchestrate` dispatches `/work-on` (see `commands/orchestrate/phase-4-execution.md`). It gates the 4 heartbeat comments (Phases 0/1/3/5) that feed `/orchestrate`'s Step 4B.5 stall detector — they have no consumer in a solo run.

### Universal Phase Dispatcher

<!-- FORGE:DISPATCHER — This is the SINGLE source of truth for phase transitions. Every phase boundary references this section. -->

**Phase sequence** (canonical order):

| Step | Phase | Entry Condition | Terminal? |
|------|-------|-----------------|-----------|
| 1 | Phase 0: Resolve Issue | Always first | No |
| 2 | Phase 1: Investigation | No `INVESTIGATION:COMPLETE` comment | No |
| 3 | Phase 1D: Route | Investigation complete | No |
| 4 | Phase 2: Decomposition | decompose: YES | Yes (spawns sub-issues) |
| 5 | Phase 3: Build (3A–3M) | `workflow:ready-to-build` or `workflow:building` | No |
| 6 | Phase 4: PR Creation | Builder comment posted, no PR exists | No |
| 7 | Phase 5: Auto-Review | PR exists, `workflow:in-review` | No |
| 8 | Phase 6: Close & Cleanup | PR merged | No |
| 9 | Phase 7: Trajectory | Issue closed | Yes |

**Phase 3 sub-phase sequence** (execute in order; 3C.5 and 3C.6 are conditional — see Phase 3B):

3A → 3B → [3C → 3C.5* → 3C.6*] → 3D → 3E → 3F → 3F.5 → 3G → 3H → 3I → 3I.5 → 3J → 3K → 3L → 3M

*3C.5 and 3C.6 are skipped for TRIVIAL tasks; 3C (Builder Contract) is still required. Investigation tasks exit at 3B before 3C.

**Universal continuation rule**: After ANY phase or sub-phase completes, check whether a terminal state has been reached. Terminal states are:
- `workflow:merged` label is set
- `workflow:invalid` label is set
- `needs-human` label is set
- `workflow:awaiting-merge` label is set (remediated + re-reviewed, awaiting a human merge decision — see #1810)
- `workflow:decomposed` label is set (sub-issues spawned)
- Issue state is CLOSED with terminal label

**If the current state is NOT terminal: proceed to the next phase immediately. Do NOT stop, emit a summary, or treat any intermediate completion as terminal.** Investigation done, quality gate passed, PR merged, review complete — all intermediate. Only the terminal states above allow stopping.

**Adding a new phase**: insert it into the phase sequence table (and sub-phase sequence, if it belongs to Phase 3). No per-boundary transition code needed — the universal continuation rule handles all transitions.

---

## Spawn-Decision Policy

<!-- FORGE:SPAWN_POLICY — Canonical spawn-decision table. Sibling specs (orchestrate.md, review-pr.md) link to this section. Sub-issues #1276–#1279 reference this table. -->

**Default: run inline.** Every skill, phase, and sub-agent runs inline unless one of the four criteria below applies. A sub-agent buys three things — parallelism, context isolation, prompt-cache preservation. If none is needed, forking is waste.

### Spawn-Decision Table

| Row | Criterion | Fork? | Example |
|-----|-----------|-------|---------|
| a | **Parallel fan-out** — independent work units can run concurrently and the time saved justifies the fork | YES — one sub-agent per unit | `/orchestrate` dispatching `/work-on` agents; `review-pr` spawning domain reviewers |
| b | **Fresh-context isolation** — a review/audit whose value depends on seeing the artefact without the builder's context bias, AND is load-bearing for the merge decision | YES — dedicated sub-agent | Phase 5C review-fork when build context is large (see Row c) |
| c | **Parent context near overflow** — ≥20 Skill invocations OR ≥10 files changed | YES — fresh sub-agent for review | Phase 5C: `Skill(skill="work-on/review", …)` instead of direct `review-pr` |
| d | **Prompt-cache TTL** — sub-op runs longer than the ~5min TTL, forcing **uncached** re-hydration next turn, independent of build size | YES — fresh sub-agent, **unconditionally** | Phase 5C review (always forks, Row d supersedes Row c); Phase 3G quality-gate loop |

**If none of the four rows match: run inline.** Do not fork for convenience — the spawn/reconstruct/aggregate cost is paid every time, even when it adds no value.

**Depth Budget**: 5 levels available (Claude Code v2.1.172+); target ≤3 for a standard run. Build phases (3A–3M) run inline at depth 2. Only the Phase 3G quality-gate loop and Phase 5C review fork to depth 3, unconditionally under Row (d). Depth 4–5 are reserved for exceptional cases and MUST log a justification comment when reached.

### Model and Effort Tiering — What Actually Applies

<!-- FORGE:MODEL_TIER_NOTE — Canonical explanation of the real vs. aspirational tiering mechanism. Every work-on/*.md "Agent model policy" line cross-references this section instead of restating it. -->

Every `work-on/*.md` sub-phase file carries an "Agent model policy" line naming a `model` and an `effort` — only one changes anything for an in-process `Skill()` call. **`effort` is real**: genuine reasoning-depth tuning on the already-running model, a legitimate no-fork cost reduction for sub-phase files that are mechanical end-to-end. **`model` is NOT functional for `Skill()`-dispatched sub-phases**: `Skill` runs within the main conversation with no model parameter; only `Agent(model=...)` has real override semantics, and HARD RULE #2 forbids `Agent` for sub-phase dispatch. Never claim `model: "haiku"` expecting effect — set `effort: low` only, and only on files mechanical end-to-end.

---

## Pipeline Rules

- **NEVER merge to main.** PRs target `staging` (fast lane) or `milestone/{slug}` (feature lane).
- **`Closes #N` does not auto-close for non-default-branch PRs.** You MUST explicitly `gh issue close`.
- **Review findings are NOT merge blockers.** They become separate issues.

---

## Phase Files

This file is the slim dispatcher. Detailed phase content lives in `commands/work-on/` — read
only the file for the current phase, not all of them.

| Step | Phase | File | Terminal? |
|------|-------|------|-----------|
| 0 | Resolve Issue & Load Context | `work-on/phase-0-resolve.md` | No |
| 1 | Investigation | `work-on/investigate.md` | No |
| 1D | Route | `work-on/investigate.md` (§1D) | No |
| 2 | Decomposition | `work-on/decompose.md` | Yes (spawns sub-issues) |
| 3 | Build (3A–3M) | `work-on/build.md` (+ `work-on/build/{context,architect,implement,validate}.md`) | No |
| 4 | PR Creation | `work-on/phase-4-pr.md` | No |
| 5 | Auto-Review | `work-on/review.md` | No |
| 6 | Close & Cleanup | `work-on/close.md` | No |
| 7 | Trajectory | `work-on/phase-7-trajectory.md` | Yes |
| — | Remediation (`--remediate` flag) | `work-on/remediate.md` | Varies |

The Universal Phase Dispatcher above remains the single source of truth for entry conditions
and terminal states; this table only maps each phase to the file that owns its detailed prose.
