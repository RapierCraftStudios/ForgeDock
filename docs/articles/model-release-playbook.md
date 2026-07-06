# Model-Release Upgrade Playbook

> **Status**: Active — applies to every new Claude or Claude Code version before it is adopted as the project default.
> **Depends on**: Pipeline eval harness (#1285) and CI regression gate (#1286) — both must be operational before this playbook can be executed in full.

---

## Purpose

ForgeDock is a prose-heavy, prompt-engineering product running on a fast-moving platform. A model upgrade that looks like a free improvement can silently drop one-shot success rates, inflate human-intervention counts, or break deterministic routing — exactly the failure modes that are hardest to spot in code review. This playbook is the gate that prevents unvalidated upgrades from reaching users.

**Do not adopt a new model or Claude Code release without completing every step below and publishing the resulting scorecard.**

---

## Trigger Conditions

Run this playbook when any of the following occur:

- A new Claude model version is released (e.g., claude-sonnet-X, claude-opus-X)
- A new Claude Code version ships (major or minor)
- A substantive `commands/` change is merged that may affect pipeline behavior
- The baseline scorecard is more than 90 days old and a refresh is due

---

## Step 1 — Prepare the eval environment

1. Pin the **current production model** in your `.env` or `forge.yaml` (do not change it yet). This is your control arm.
2. Confirm the benchmark corpus is at its current version (check `docs/eval/README.md` for the active corpus tag).
3. Confirm `scripts/bench-scorecard.mjs` exits 0 against the current baseline scorecard:
   ```bash
   node scripts/bench-scorecard.mjs docs/eval/runs/<latest-baseline-run>/raw.json
   ```
4. Record the current baseline scorecard path in your run log (the file you will compare against in Step 5).

---

## Step 2 — Run the full corpus suite on the candidate model

1. Set `FORGE_MODEL` (or equivalent config) to the **candidate model** version.
2. Run the full pipeline eval suite against the seeded benchmark corpus:
   ```bash
   # Full run — all corpus issues, all pipeline phases
   node bin/runner.mjs --corpus docs/eval/corpus/seed-v1.json --model <candidate> --out docs/eval/runs/<run-id>/
   ```
   Where `<run-id>` follows the convention `<model-slug>-<YYYY-MM-DD>` (e.g., `claude-sonnet-4-7-2026-09-01`).
3. The runner emits per-issue outcome files into the run directory. Do not post-process them yet.
4. Minimum corpus coverage: every issue in the active corpus must complete (pass or fail) before scoring. Partial runs are not valid baselines.

---

## Step 3 — Score the run

```bash
node scripts/bench-scorecard.mjs docs/eval/runs/<run-id>/raw.json > docs/eval/runs/<run-id>/scorecard.json
```

Review the exit code:
- `0` — scorecard emitted, proceed to Step 4
- `1` — invalid input (bad JSON, n<3 runs, missing fields) — fix the run data before proceeding
- `2` — judge-calibration warning — review miscalibrated runs before accepting results

---

## Step 4 — Compare against the baseline

Open `docs/eval/runs/<run-id>/scorecard.json` alongside the current baseline scorecard. Check every metric in the table below. A regression is defined as any metric that moves outside its regression threshold.

| Metric | Regression threshold | Action if regressed |
|--------|---------------------|---------------------|
| One-shot success rate | Drop > 5 percentage points vs baseline | BLOCK upgrade — file regression issue |
| Human-intervention count (mean) | Increase > 0.5 interventions/issue | BLOCK upgrade — file regression issue |
| Wall-clock time (median) | Increase > 20% | WARN — investigate before proceeding |
| Cost per issue (median) | Increase > 15% | WARN — investigate before proceeding |

If **any BLOCK-level regression** is present: do not proceed to Step 5. File a regression issue (label `priority:P0`, link to both scorecards), and return to the current model until the regression is explained and either fixed or accepted as a known trade-off with sign-off.

If only WARN-level regressions are present: document the regression and its explanation in the scorecard commit message. Proceed with caution.

---

## Step 5 — Publish the scorecard

1. Copy the scorecard to the published results directory:
   ```bash
   cp docs/eval/runs/<run-id>/scorecard.json docs/eval/published/<run-id>.json
   ```
2. Update `docs/eval/README.md` — add a row to the results table pointing to the new scorecard.
3. Commit with the message:
   ```
   docs(eval): publish scorecard for <model-slug> — <YYYY-MM-DD>
   ```
4. Open a PR targeting `staging`. The PR body must include: model version, corpus version, all headline metrics, and a link to the diff against the previous baseline.

---

## Step 6 — Adopt or reject

**Adopt**: If no BLOCK-level regressions and all WARN-level regressions are documented, update the project default model in `forge.yaml` and `docs/eval/README.md` (update the "current baseline" pointer). Merge the PR.

**Reject**: If any BLOCK-level regression is unresolved, close the PR without merging, leave the model pin unchanged, and ensure the regression issue is open and assigned.

---

## Scorecard format

Every published scorecard is a JSON file at `docs/eval/published/<run-id>.json`. See `docs/eval/README.md` for the schema and field definitions. The scorecard must be machine-readable (for the CI gate) and human-readable (for the published results table).

---

## What counts as a "real" scorecard

A scorecard is valid when:
- It was produced by the harness from at least 3 runs per corpus issue (n=1 is not a valid result — see `bench-scorecard.mjs` methodology note)
- It covers the full active corpus (no skipped issues)
- The raw run data is committed alongside the scorecard in `docs/eval/runs/<run-id>/`
- The `bench-scorecard.mjs` exits 0 (or 2 with documented calibration notes) against the raw data

Template-only scorecards (no raw run data) do not satisfy acceptance criteria.

---

## See also

- `docs/eval/README.md` — published results index and scorecard schema
- `docs/eval/corpus/` — seeded benchmark corpus (issues + graded difficulty)
- `scripts/bench-scorecard.mjs` — scorecard aggregator
- Issue #1259 — parent epic: eval regression gate
- Issue #1285 — pipeline eval harness (prerequisite)
- Issue #1286 — CI regression gate (prerequisite)
