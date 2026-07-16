# Pipeline Eval — Published Scorecards

Per-release pipeline evaluation results for ForgeDock. Every scorecard here was produced by the eval harness (#1285) running the seeded benchmark corpus (#1284) and aggregated by `scripts/bench-scorecard.mjs`. Scorecards are published following the model-release upgrade playbook (`docs/articles/model-release-playbook.md`).

---

## Current baseline

| Field | Value |
|-------|-------|
| Scorecard | [claude-sonnet-4-6-2026-07-04.json](published/claude-sonnet-4-6-2026-07-04.json) |
| Model | claude-sonnet-4-6 |
| Corpus | seed-v1 |
| Run date | 2026-07-04 |
| One-shot success rate | — (pending harness) |
| Human-intervention mean | — (pending harness) |

> **Note**: The baseline above is a format placeholder. The harness (#1285) and CI gate (#1286) must be operational before real scorecard values can be populated. When the first real run completes, update this table and remove this note.
>
> **Model upgrade**: Default model was updated from `claude-sonnet-4-5` to `claude-sonnet-5` in PR #1441 (issue #1248, committed 2026-07-04). The `--model` flag and `FORGEDOCK_MODEL` env var override the default at runtime. No `claude-sonnet-5` scorecard has been published yet — see the Published results table below.

---

## Published results

| Run ID | Model | Corpus | Date | One-shot success | Human interventions/issue | Scorecard |
|--------|-------|--------|------|-----------------|--------------------------|-----------|
| claude-sonnet-5-2026-07-04 | claude-sonnet-5 | seed-v1 | 2026-07-04 | pending | pending | not yet published |
| claude-sonnet-4-6-2026-07-04 | claude-sonnet-4-6 | seed-v1 | 2026-07-04 | pending | pending | [scorecard](published/claude-sonnet-4-6-2026-07-04.json) |

---

## Scorecard schema

Every file in `published/` is a JSON object with the following fields:

```jsonc
{
  // Run metadata
  "run_id": "claude-sonnet-5-2026-07-04",          // <model-slug>-<YYYY-MM-DD>
  "model": "claude-sonnet-5",                       // exact model identifier
  "claude_code_version": "1.x.x",                  // Claude Code version used
  "corpus_version": "seed-v1",                     // corpus tag from docs/eval/corpus/
  "run_date": "2026-07-04",                        // ISO 8601 date
  "n_issues": 20,                                  // total corpus issues attempted
  "n_completed": 20,                               // issues that reached a terminal state

  // Primary metrics — regression gate checks these
  "one_shot_success_rate": 0.75,                   // fraction of issues merged without human intervention
  "human_intervention_count": {
    "mean": 0.3,                                   // mean interventions per issue
    "median": 0.0,
    "p90": 1.0
  },
  "wall_clock_seconds": {
    "mean": 3420,                                  // mean wall-clock per issue (seconds)
    "median": 3180,
    "p90": 6000
  },
  "cost_per_issue_usd": {
    "mean": 0.85,
    "median": 0.72,
    "p90": 1.40
  },

  // Per-issue breakdown (array)
  "issues": [
    {
      "issue_id": "corpus-001",
      "difficulty": "easy",                        // easy | medium | hard
      "category": "bug",                           // bug | feature | refactor | perf | docs
      "outcome": "merged",                         // merged | needs-human | failed | timeout
      "human_interventions": 0,
      "wall_clock_seconds": 2980,
      "cost_usd": 0.63
    }
    // ... one entry per corpus issue
  ],

  // Comparison against previous baseline (populated at publish time)
  "vs_baseline": {
    "baseline_run_id": null,                       // null if this is the first run
    "one_shot_success_rate_delta": null,
    "human_intervention_delta": null,
    "regressions": []
  }
}
```

---

## Directory layout

```
docs/eval/
  README.md                     # this file — published results index
  corpus/
    seed-v1.json                # seeded benchmark corpus (20 issues, graded difficulty)
  published/
    <run-id>.json               # published scorecard per model release
  runs/
    <run-id>/
      raw.json                  # raw per-issue outcome data from the harness
      scorecard.json            # aggregated scorecard (bench-scorecard.mjs output)
```

Raw run data in `runs/` is the source of truth. Published scorecards in `published/` are the canonical record referenced in the playbook and README.

---

## Upgrade decision table

| One-shot success rate delta | Human intervention delta | Decision |
|-----------------------------|--------------------------|----------|
| > -5pp | <= +0.5 | Adopt |
| -5pp to -10pp | any | WARN — investigate |
| < -10pp | any | BLOCK — regression issue required |
| any | > +0.5 | BLOCK — regression issue required |

Full decision procedure: `docs/articles/model-release-playbook.md`.
