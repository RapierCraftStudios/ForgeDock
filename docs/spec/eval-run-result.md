# Eval Run-Result JSON Schema

**Spec version**: 1.0.0
**Stable since**: issue #1285

This document defines the machine-readable JSON shapes consumed and produced by
the ForgeDock pipeline eval harness:

- **Per-run result** — one object per issue, written by the batch driver
  (`bin/batch-runner.mjs`) after each headless `/work-on` run.
- **Scorecard** — aggregate computed by `scripts/eval-scorecard-aggregator.mjs`
  from an array of per-run results; consumed by the CI regression gate
  (`scripts/eval-gate-scorecard.mjs`, issue #1286) and the publishing pipeline.

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
| `success`    | Run completed; the issue reached `workflow:merged` or equivalent terminal state |
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

## Batch Driver Output File

`bin/batch-runner.mjs` writes a JSON object containing the per-run array plus
top-level metadata:

```jsonc
{
  "corpus_version": "v1",        // string | null — corpus version label
  "spec_version": "1.0.21",      // string | null — forgedock version at run time
  "model": "claude-sonnet-4-5",  // string | null — model used
  "generated_at": "2026-07-04T00:00:00.000Z",
  "runs": [ ...PerRunResult ]
}
```

---

## Corpus File

The batch driver accepts a corpus file (JSON) listing issues to run:

```jsonc
{
  "corpus_version": "v1",        // string — semver or label for the corpus snapshot
  "run_id": "run-2026-07-04-1",  // string — optional unique run identifier
  "run_mode": "full",            // "full" | "subset" — passed through to scorecard
  "spec_sha": "abc123",          // string | null — git SHA of commands/ at run time
  "issues": [1001, 1002, 1003]   // integer[] — GitHub issue numbers
}
```

---

## Scorecard

`scripts/eval-scorecard-aggregator.mjs` reads the batch driver output and emits
a scorecard in the format consumed by `scripts/eval-gate-scorecard.mjs` (#1286):

```jsonc
{
  "schema_version": "1",          // string — always "1" (schema identifier)
  "run_id": "run-2026-07-04-1",   // string | null — from corpus metadata
  "generated_at": "2026-07-04T00:00:00.000Z",
  "corpus_size": 20,              // integer — from corpus metadata (defaults to issues_run)
  "issues_run": 20,               // integer — total runs in the input
  "successful_runs": 17,          // integer — runs with status === "success"
  "failed_runs": 2,               // integer — runs with status === "failure"
  "success_rate_pct": 85,         // number [0,100] — successful_runs / issues_run * 100 (2dp)
  "mean_wall_clock_ms": 38200,    // number | null — arithmetic mean wall-clock
  "median_wall_clock_ms": 35000,  // number | null — median wall-clock
  "total_intervention_count": 1,  // integer — sum of interventionCount across all runs
  "cost": null,                   // null | number — sum of per-run cost; null if any run has cost: null
  "run_mode": "full",             // "full" | "subset"
  "spec_sha": "abc123"            // string | null — git SHA of commands/ at run time
}
```

**Important**: `incomplete` and `error` status runs count against `success_rate_pct`
(they reduce `issues_run` denominator's numerator). This ensures the gate catches
hangs and crashes, not just logic failures.

### Methodology rules (enforced by the scorecard aggregator)

1. **Minimum sample size**: fewer than `MIN_RUNS` (currently **5**) scoreable
   (`success` or `failure`) runs causes the aggregator to exit non-zero rather
   than emit a misleading rate. Mirrors `bench-scorecard.mjs`'s `MIN_RUNS` rule.
2. **Malformed input**: missing required fields (`issue`, `status`,
   `wallClockMs`, `interventionCount`) or non-integer/non-string values cause
   exit code 1 (validation error).
3. **Cost is nullable**: if any run has `cost: null`, the scorecard's
   `cost` is `null`. The field becomes numeric only when every run reports a
   real cost value (post-#1255).
4. **Rate consistency**: `success_rate_pct` is always computed as
   `round(successful_runs / issues_run * 100, 2)`. The CI gate (#1286) validates
   this computed value matches the reported value.

---

## Stability contract

- Field names are stable. New **optional** fields may be added at any time
  without a version bump.
- Removing or renaming a field is a breaking change and requires a spec version
  bump and a GitHub issue.
- Consumers **must** treat unknown fields as ignorable (forward-compatibility).
- The CI gate sub-issue (#1286) and publishing sub-issue (#1287) may depend on
  this schema without waiting for upstream changes.
