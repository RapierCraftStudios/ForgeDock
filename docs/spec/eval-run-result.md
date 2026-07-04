# Eval Run-Result JSON Schema

**Spec version**: 1.0.0
**Stable since**: issue #1285

This document defines the machine-readable JSON shapes consumed and produced by
the ForgeDock pipeline eval harness:

- **Per-run result** — one object per issue, written by the batch driver
  (`bin/batch-runner.mjs`) after each headless `/work-on` run.
- **Scorecard** — aggregate computed by `scripts/eval-gate-scorecard.mjs` over
  an array of per-run results; consumed by CI and the publishing gate.

---

## Per-Run Result

Each headless run of a single corpus issue produces one JSON object:

```jsonc
{
  // Required fields
  "issue": 1234,                // integer — GitHub issue number
  "status": "success",          // "success" | "failure" | "incomplete" | "error"
  "wallClockMs": 42000,         // integer — wall-clock duration of the run (ms)
  "interventionCount": 0,       // integer — number of human interventions (see below)

  // Optional fields (nullable — do NOT block on missing upstream data)
  "cost": null,                 // null | number — token/USD cost; null until #1255 lands
  "iterations": 23,             // integer — tool-use loop iteration count
  "stopReason": "end_turn",     // string — Anthropic stop_reason or "max_iterations"
  "error": null,                // null | string — error message when status === "error"
  "specVersion": "1.0.21",      // string — forgedock package version at run time
  "model": "claude-sonnet-4-5", // string — model used for the run
  "runAt": "2026-07-04T00:00:00.000Z" // ISO-8601 timestamp
}
```

### `status` values

| Value        | Meaning                                                                      |
|--------------|------------------------------------------------------------------------------|
| `success`    | Run completed, the issue reached `workflow:merged` or equivalent terminal state |
| `failure`    | Run completed but the issue did not reach a terminal success state           |
| `incomplete` | Run stopped due to `max_tokens` or `max_iterations` — result is unreliable  |
| `error`      | The runner threw an unhandled exception (network, API, crash)                |

### `interventionCount` definition

A human intervention is counted when **any** of the following occur during a run:

1. The `needs-human` label is applied to the issue by the pipeline.
2. A manual `gh` command is executed outside the automated runner loop.
3. A FORGE annotation comment is posted by a human (not the bot account) during the run window.

Runs where no human interaction occurs have `interventionCount: 0`.

---

## Corpus File

The batch driver accepts a corpus file (JSON) listing issues to run:

```jsonc
{
  "corpus_version": "v1",       // string — semver or label for the corpus snapshot
  "issues": [1001, 1002, 1003]  // integer[] — GitHub issue numbers
}
```

---

## Scorecard

`scripts/eval-gate-scorecard.mjs` reads an array of per-run results and emits:

```jsonc
{
  "corpus_version": "v1",          // string | null — from the input metadata
  "spec_version": "1.0.21",        // string | null — forgedock version at run time
  "model": "claude-sonnet-4-5",    // string | null — model used (first non-null value seen)
  "n_runs": 20,                    // integer — total runs in the input
  "n_success": 17,                 // integer — runs with status === "success"
  "n_failure": 2,                  // integer — runs with status === "failure"
  "n_incomplete": 1,               // integer — runs with status === "incomplete" | "error"
  "one_shot_success_rate": 0.85,   // number [0,1] — n_success / n_runs
  "wall_clock_ms": {
    "mean": 38200,                 // number — arithmetic mean across all runs
    "median": 35000,               // number — median wall-clock
    "min": 12000,                  // number
    "max": 95000                   // number
  },
  "intervention": {
    "total": 1,                    // integer — sum of interventionCount across all runs
    "mean_per_run": 0.05           // number — total / n_runs
  },
  "cost": null                     // null | number — sum of per-run cost; null if any run has cost: null
}
```

### Methodology rules (enforced by the scorecard aggregator)

1. **Minimum sample size**: fewer than `MIN_RUNS` (currently **5**) valid runs
   causes the aggregator to exit non-zero rather than emit a misleading rate.
   Mirrors `bench-scorecard.mjs`'s `MIN_RUNS` rule.
2. **Malformed input**: missing required fields (`issue`, `status`,
   `wallClockMs`, `interventionCount`) or non-integer/non-string values cause
   exit code 1 (validation error).
3. **Cost is nullable**: if any run has `cost: null`, the scorecard's top-level
   `cost` is `null`. The field becomes numeric only when every run reports a
   real cost value (post-#1255).

---

## Stability contract

- Field names are stable. New **optional** fields may be added at any time
  without a version bump.
- Removing or renaming a field is a breaking change and requires a spec version
  bump and a GitHub issue.
- Consumers **must** treat unknown fields as ignorable (forward-compatibility).
- The CI gate sub-issue and publishing sub-issue may depend on this schema
  without waiting for upstream changes.
