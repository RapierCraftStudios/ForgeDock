# Economic Self-Governance — Design Spec

**Date:** 2026-07-04
**Status:** Design — ready to build
**Tracking:** #1317 (economics layer), epic #1320 (five foundations of autonomy)
**Scope:** Risk×cost go/no-go scoring function, budget-aware scheduler, and backpressure model. Unifies #1313 (preserve `needs-human`) and #1314 (autopilot `--yes` for low-risk) into a single decision model.

---

## 1. Motivation

Safety Rule 3 in `/orchestrate` today reads: "no artificial concurrency limit — spawn as many agents as there are issues." That is the opposite of autonomy. Autonomy is **knowing when not to act**.

The current decision surface has three static switches:

| Surface | Policy | Problem |
|---------|--------|---------|
| `/work-on` solo | Ask human at every ambiguity | Over-asks on clear issues |
| `/orchestrate` | "NEVER ask… merge anyway" | Under-asks on high-risk changes |
| `/autopilot` | Gate every fix | Blocks low-risk wins behind human review |

None of these is a decision — they are static switches baked into prose. The result: an agent either burns compute on issues it should not touch, or stalls on issues it could safely auto-run. Neither is economic.

The fix is a **self-governing scheduler** that treats compute as a budget and makes an explicit go/no-go per issue before spawning any agent.

---

## 2. Goals / Non-goals

**Goals**
- A scoring function `(expected_cost, risk_tier, confidence) → {auto, escalate, defer}` runs before each issue is dispatched.
- Per-run and per-wave budget caps with backpressure replace the "no artificial concurrency limit" rule.
- `#1313` (preserve `needs-human` for high-risk) and `#1314` (autopilot `--yes` for low-risk) both fall out of the single model as threshold configurations — not separate flags.
- The decision and its inputs are recorded in `FORGE:ECONOMICS` so runs are auditable.

**Non-goals**
- Real-time token streaming cost measurement (post-run accounting only, fed by #1255/#1295).
- The durable engine state machine (#1256) — assumed as a substrate but not implemented here.
- Per-turn interruption of in-flight agents (this spec is pre-dispatch).

---

## 3. Locked Decisions

1. **Decision granularity: per-issue, pre-dispatch.** The go/no-go is computed once before an agent is spawned. Mid-run escalation is a separate concern.
2. **Three-outcome model: `auto | escalate | defer`.** `auto` = spawn with no human gate. `escalate` = post a comment and wait for human approval. `defer` = place back in queue with lower priority, do not block the wave.
3. **Budget authority: the orchestrator holds the budget, not individual agents.** Agents report estimated cost; the orchestrator decides whether to spend it.
4. **Score inputs are observable.** Every input to the scoring function is logged in `FORGE:ECONOMICS` before any agent runs — so a human can audit why an issue was auto-run or escalated.
5. **Thresholds are configurable in `forge.yaml`.** Default thresholds ship with the spec; operators can tighten or loosen them without editing command files.

---

## 4. Architecture

### 4.1 Scoring Function

```
score(issue) → { decision, reasoning, estimated_cost, risk_tier, confidence }
```

**Inputs:**

| Input | Source | Type |
|-------|--------|------|
| `expected_cost` | Historical cost-per-issue data (#1255/#1295) or heuristic (label + size estimate) | USD float |
| `risk_tier` | Domain risk tag on issue label (`risk:low`, `risk:medium`, `risk:high`) or inferred from affected paths | `low \| medium \| high` |
| `confidence` | FORGE:INVESTIGATOR confidence field, or `0.5` if no investigation comment exists | 0.0–1.0 |
| `budget_remaining` | Current wave budget minus committed spend | USD float |
| `needs_human` | Issue has `needs-human` label | bool |

**Decision matrix (defaults):**

| risk_tier | confidence | expected_cost | decision |
|-----------|-----------|---------------|----------|
| `low` | ≥ 0.7 | ≤ $0.50 | `auto` |
| `low` | ≥ 0.7 | > $0.50 | `escalate` |
| `low` | < 0.7 | any | `escalate` |
| `medium` | ≥ 0.8 | ≤ $0.30 | `auto` |
| `medium` | any other | any | `escalate` |
| `high` | any | any | `escalate` |
| any | any | > budget_remaining | `defer` |
| `needs_human=true` | any | any | `escalate` (always) |

Thresholds are overridable via `forge.yaml → economics`:

```yaml
economics:
  auto_cost_ceiling_usd: 0.50       # max cost for auto-run (low risk)
  medium_auto_cost_ceiling_usd: 0.30
  auto_confidence_floor: 0.70
  medium_confidence_floor: 0.80
  wave_budget_usd: 5.00             # per-wave budget cap
  run_budget_usd: 20.00             # per-run (session) budget cap
```

### 4.2 Budget Tracker

A simple stateful accumulator maintained by the orchestrator across the wave:

```
budget_tracker = {
  wave_limit: float,        # from forge.yaml or --budget flag
  wave_committed: float,    # sum of expected_cost for auto-dispatched issues
  wave_actual: float,       # sum of reported actual cost from completed agents
  run_limit: float,
  run_committed: float,
}
```

`defer` fires when `wave_committed + expected_cost > wave_limit * 0.90` (10% buffer to absorb cost overruns).

Backpressure: when the wave budget is exhausted, remaining issues are set to `workflow:deferred` label and the orchestrator reports a budget summary. They are the first candidates in the next wave.

### 4.3 FORGE:ECONOMICS Annotation

Written to the issue before the agent is spawned (or before posting the escalation comment):

```html
<!-- FORGE:ECONOMICS
decision: auto
risk_tier: low
confidence: 0.82
expected_cost_usd: 0.18
budget_remaining_usd: 3.47
wave: 1
rationale: "low-risk label, high investigation confidence, well within budget"
timestamp: 2026-07-04T12:00:00Z
-->
```

Downstream stages (verification gate, provenance) can read this annotation to understand the economic context of the decision.

### 4.4 Integration Points

**`/orchestrate`**: Phase 2B (issue selection) gains a `score_issues()` step before dispatching agents. Issues that score `escalate` are held; `auto` issues proceed; `defer` issues are re-queued.

**`/autopilot`**: The `--fix` phase queries the scoring function instead of the current "gate every fix" heuristic. `--yes` flag sets `auto_confidence_floor: 0.0` and raises cost ceilings — effectively the current `--yes` behavior, but explicit and auditable.

**`/work-on`**: Solo interactive use is unaffected. The scoring function is opt-in via `forge.yaml → economics.solo_mode: enabled`.

---

## 5. Implementation Plan

### Increment 1: Scoring function + FORGE:ECONOMICS (no budget tracking)
- Add `score_issue()` logic to `/orchestrate` Phase 2B.
- Read domain risk labels and FORGE:INVESTIGATOR confidence.
- Emit `FORGE:ECONOMICS` annotation.
- `escalate` path posts a comment and adds `needs-human` label; agent is not spawned.
- `defer` path is treated as `escalate` in this increment.

### Increment 2: Budget tracker + backpressure
- Add `budget_tracker` state to orchestrator.
- Read `forge.yaml → economics` thresholds.
- `defer` path sets `workflow:deferred` label and skips the issue.
- Post wave budget summary at end of orchestrator run.

### Increment 3: Unify #1313 and #1314
- Remove hard-coded "NEVER ask" language from `/orchestrate`.
- Remove hard-coded "gate every fix" from `/autopilot`.
- Both commands delegate to the scoring function with appropriate threshold profiles (`orchestrate` uses `medium_confidence_floor`, `autopilot --yes` raises ceilings).

---

## 6. Open Questions

- **Cost estimation without history**: For issues with no historical data, the default heuristic is label-based (`bug` → $0.20, `feat` → $0.40, `epic` → $1.00). This needs calibration once #1255 data is available.
- **Risk tag inference**: If no `risk:*` label exists, infer from affected paths (e.g., changes to `bin/`, `commands/quality-gate.md`, or CI workflows → `risk:high`). Path-based inference is a follow-on to Increment 1.
- **Wave vs. run budget interaction**: A "run" spans multiple waves in `/autopilot`. The run budget should be the outer limit; wave budget is the inner pacing mechanism.

---

## 7. References

- #1317 — this issue
- #1255, #1295, #1296, #1297 — cost-per-issue accounting (feeds `expected_cost`)
- #1249 — per-agent model/effort tiering (feeds `expected_cost`)
- #1313 — preserve `needs-human` for high-risk (subsumed by this spec)
- #1314 — autopilot `--yes` for low-risk (subsumed by this spec)
- #1320 — five foundations epic (economics layer)
- #1256 — durable engine (substrate for stateful budget tracking)
