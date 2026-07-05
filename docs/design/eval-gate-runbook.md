# Eval Gate Runbook

> Companion to issue #1286, workflow `.github/workflows/eval-gate.yml`, and
> `scripts/eval-gate-scorecard.mjs`.

The pipeline eval gate automatically runs the eval harness (#1285) against
`commands/` changes and fails CI if the one-shot success rate drops more than
the defined threshold. This runbook explains how to interpret a gate failure,
override when necessary, and update the baseline.

---

## What the gate checks

The gate compares a fresh scorecard (produced by `scripts/eval-harness-runner.mjs`)
against the committed baseline at `scripts/eval-gate-baseline.json`.

**Regression threshold**: 5 percentage points.

A drop of **more than 5 pp** in `success_rate_pct` vs the baseline is a
regression and fails CI with exit code 1.

Example:
- Baseline: `success_rate_pct: 80`
- Fresh: `success_rate_pct: 74` → drop = 6 pp → **FAIL** (6 > 5)
- Fresh: `success_rate_pct: 75` → drop = 5 pp → **PASS** (5 = 5, not strictly greater)

**Subset run carve-out**: When the fresh run has fewer than 8 issues, the rate
assertion is skipped. Rationale: on n=5, one failure is 20 pp — always failing
the gate even with no spec changes. The gate still validates structural
correctness and emits a non-blocking summary.

---

## Trigger conditions

| Event | What runs | Rate assertion applied |
|-------|-----------|----------------------|
| PR / push with substantive `commands/**` changes | Subset run | Only if n >= 8 |
| `workflow_dispatch` (default) | Full corpus run | Yes |
| `workflow_dispatch` with `run_mode: subset` | Subset run | Only if n >= 8 |
| Non-substantive `commands/**` changes (typos, comments) | Nothing | N/A |

A non-substantive change is one where every changed line in `commands/` is a
blank line, HTML comment (`<!-- ... -->`), or Markdown heading (`# ...`).

---

## Interpreting a gate failure

When the gate fails, the CI step prints:

```
eval-gate FAILED: REGRESSION: success rate dropped N pp
(X% fresh vs Y% baseline). Threshold is 5 pp.
A deliberate spec degradation or a real pipeline regression caused this failure.
```

Followed by actionable steps:
1. Review the diff in `commands/` to identify what changed.
2. Re-run the full corpus locally:
   ```bash
   node scripts/eval-harness-runner.mjs --mode full
   ```
3. If the regression is real: fix the spec, re-run, update the baseline (see below).
4. If the regression is a false positive: see Override below.

The structured JSON result is also printed and uploaded as a CI artifact
(`eval-scorecard-subset-<sha>.json` or `eval-scorecard-full-<sha>.json`).

---

## Reading the scorecard diff

The scorecard artifact contains:

```json
{
  "pass": false,
  "fresh_success_rate_pct": 74,
  "baseline_success_rate_pct": 80,
  "drop_pp": 6,
  "threshold_pp": 5,
  "rate_assertion_skipped": false,
  "fresh_issues_run": 20,
  "fresh_run_mode": "full",
  "reason": "REGRESSION: ..."
}
```

- `drop_pp`: positive = regression, negative = improvement.
- `rate_assertion_skipped`: true means the run was too small for a meaningful rate.
- `fresh_run_id` / `baseline_run_id`: link back to the specific runs for debugging.

---

## Updating the baseline

After a deliberate improvement is confirmed (full corpus run passes with a
higher success rate), update the baseline:

```bash
# Re-seed the baseline from the latest full run scorecard:
node scripts/eval-gate-scorecard.mjs scorecard.json --seed

# Commit the updated baseline:
git add scripts/eval-gate-baseline.json
git commit -m "chore(bench): update eval-gate baseline to vN.N"
```

The `--seed` flag overwrites the baseline file with the fresh scorecard regardless
of the current baseline content.

**Rule**: never lower the baseline. Only update it upward (higher success rate) or
after a deliberate scope change to the corpus.

---

## Override / force-merge (false positive procedure)

A false positive is a gate failure where the spec did not regress but the eval run
produced a low score due to:
- Flaky sandbox or network issues during the harness run
- Corpus issue that was already broken before the PR
- Known harness limitation (#1285 tracking)

**Override procedure**:

1. Confirm the false positive by running the harness locally:
   ```bash
   node scripts/eval-harness-runner.mjs --mode full
   ```
   If the local run passes, it is likely a CI flake.

2. Re-trigger the workflow from the PR UI: **Re-run failed jobs**.

3. If it still fails and you have confirmed the spec change is safe:
   - Add a PR comment documenting why the failure is a false positive.
   - Get a second approver.
   - Merge with the label `eval-gate:override` on the PR.

4. File a follow-up issue to investigate the false positive root cause.

**Never** skip the gate entirely by editing the workflow YAML in the same PR
that contains the spec change. That defeats the purpose.

---

## Running on demand (model release)

When a new Claude model is released, run the full corpus to establish a new
baseline for the model:

1. Trigger via GitHub Actions UI: **Actions → Pipeline Eval Gate → Run workflow**
2. Select `run_mode: full`.
3. Download the scorecard artifact.
4. If the success rate is acceptable, update the baseline:
   ```bash
   node scripts/eval-gate-scorecard.mjs <downloaded-scorecard.json> --seed
   git add scripts/eval-gate-baseline.json
   git commit -m "chore(bench): rebaseline for claude-<model-version>"
   ```

---

## Baseline storage rationale

The baseline is committed as `scripts/eval-gate-baseline.json` rather than stored
in a GitHub Actions cache or release asset. Reasons:

- **Auditable**: every baseline update appears in `git log` and `git blame`.
- **Reproducible**: a cold clone has everything needed to run the gate.
- **Diff-visible**: baseline changes show up in PRs, making ratcheting explicit.
- **No external dependencies**: no cache eviction, no release asset permissions.

The tradeoff is that updating the baseline requires a commit — which is
intentional. Baseline bumps should be deliberate human decisions, not
auto-ratcheted by CI.
