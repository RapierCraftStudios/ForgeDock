#!/usr/bin/env node
/**
 * scripts/eval-gate-scorecard.mjs — CI regression gate comparator (#1286)
 *
 * Deterministic, zero-network comparator invoked by `.github/workflows/eval-gate.yml`.
 * Compares a fresh scorecard (produced by scripts/eval-scorecard-aggregator.mjs, #1285)
 * against the committed baseline at scripts/eval-gate-baseline.json and fails CI when
 * the one-shot success rate regresses beyond a defined threshold.
 *
 * It does NOT call any model, network, or live SDK — it only diffs two scorecard
 * JSON objects. See docs/design/eval-gate-runbook.md for the full behavior spec.
 *
 * Usage:
 *   node scripts/eval-gate-scorecard.mjs <scorecard.json> <baseline.json>  # compare mode
 *   node scripts/eval-gate-scorecard.mjs <scorecard.json> --seed            # seed mode
 *
 * Compare mode: exits 0 (pass) unless the fresh success_rate_pct drops more than
 * RATE_THRESHOLD_PP percentage points below the baseline. The rate assertion is
 * skipped (still exits 0) when the fresh run has fewer than MIN_ISSUES_FOR_RATE_ASSERTION
 * issues — a subset run is too small for a meaningful rate comparison.
 *
 * Seed mode: overwrites scripts/eval-gate-baseline.json with the fresh scorecard.
 * Used after a deliberate, confirmed improvement (see runbook "Updating the baseline").
 *
 * Exit codes:
 *   0 = gate passed (or rate assertion skipped) / baseline seeded successfully
 *   1 = gate failed (regression) or invalid input (bad JSON, missing required field)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fields the fresh scorecard must have (matches eval-scorecard-aggregator.mjs's output). */
export const REQUIRED_FIELDS = [
  "schema_version",
  "issues_run",
  "successful_runs",
  "failed_runs",
  "success_rate_pct",
  "run_mode",
];

/** Regression threshold in percentage points (see docs/design/eval-gate-runbook.md). */
export const RATE_THRESHOLD_PP = 5;

/** Below this many issues, the rate assertion is skipped as statistically meaningless. */
export const MIN_ISSUES_FOR_RATE_ASSERTION = 8;

/** Round to 2 decimal places (matches eval-scorecard-aggregator.mjs's success_rate_pct rounding). */
function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * Validate a scorecard-shaped object. Throws a descriptive Error on any violation.
 *
 * @param {unknown} sc
 * @param {object} [opts]
 * @param {string[]} [opts.requiredFields] - Fields that must be present.
 * @param {string} [opts.label] - Label used in error messages (e.g. "fresh scorecard").
 * @returns {void}
 */
export function validateScorecard(sc, { requiredFields = REQUIRED_FIELDS, label = "scorecard" } = {}) {
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) {
    throw new Error(`${label} must be a JSON object`);
  }
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(sc, field)) {
      throw new Error(`${label} missing required field: "${field}"`);
    }
  }
  if (typeof sc.success_rate_pct !== "number" || !Number.isFinite(sc.success_rate_pct)) {
    throw new Error(
      `${label}.success_rate_pct must be a finite number (got ${JSON.stringify(sc.success_rate_pct)})`,
    );
  }
}

/**
 * Compare a fresh scorecard against the baseline and decide pass/fail.
 * Does NOT re-validate beyond what's needed to compute the diff — call
 * validateScorecard() first for full field validation (this function calls
 * it internally, so it is safe to call directly).
 *
 * @param {object} fresh - Scorecard from the current CI run.
 * @param {object} baseline - Committed baseline scorecard.
 * @param {object} [opts]
 * @param {number} [opts.thresholdPp] - Regression threshold in percentage points.
 * @param {number} [opts.minIssuesForAssertion] - Min issues before the rate assertion applies.
 * @returns {object} Scorecard-diff result — see docs/design/eval-gate-runbook.md
 *   "Reading the scorecard diff" for the field contract.
 */
export function evaluateGate(
  fresh,
  baseline,
  { thresholdPp = RATE_THRESHOLD_PP, minIssuesForAssertion = MIN_ISSUES_FOR_RATE_ASSERTION } = {},
) {
  validateScorecard(fresh, { requiredFields: REQUIRED_FIELDS, label: "fresh scorecard" });
  // Baseline may predate newer fields the aggregator emits — only success_rate_pct
  // is strictly required for the comparison itself.
  validateScorecard(baseline, { requiredFields: ["success_rate_pct"], label: "baseline" });

  const freshIssuesRun = typeof fresh.issues_run === "number" ? fresh.issues_run : null;
  const rateAssertionSkipped = freshIssuesRun !== null && freshIssuesRun < minIssuesForAssertion;

  const dropPp = round2(baseline.success_rate_pct - fresh.success_rate_pct);

  let pass;
  let reason;
  if (rateAssertionSkipped) {
    pass = true;
    reason =
      `rate assertion skipped: fresh run has ${freshIssuesRun} issue(s), below the minimum of ` +
      `${minIssuesForAssertion} required for a meaningful rate comparison`;
  } else if (dropPp > thresholdPp) {
    pass = false;
    reason =
      `REGRESSION: success rate dropped ${dropPp} pp (${fresh.success_rate_pct}% fresh vs ` +
      `${baseline.success_rate_pct}% baseline). Threshold is ${thresholdPp} pp.`;
  } else {
    pass = true;
    reason =
      `success rate delta ${dropPp} pp is within the ${thresholdPp} pp threshold ` +
      `(${fresh.success_rate_pct}% fresh vs ${baseline.success_rate_pct}% baseline).`;
  }

  return {
    pass,
    fresh_success_rate_pct: fresh.success_rate_pct,
    baseline_success_rate_pct: baseline.success_rate_pct,
    drop_pp: dropPp,
    threshold_pp: thresholdPp,
    rate_assertion_skipped: rateAssertionSkipped,
    fresh_issues_run: freshIssuesRun,
    fresh_run_mode: fresh.run_mode ?? null,
    fresh_run_id: fresh.run_id ?? null,
    baseline_run_id: baseline.run_id ?? null,
    reason,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Actionable next-steps text appended to a gate-failure message (see runbook). */
function actionableStepsText() {
  return (
    "\n" +
    "1. Review the diff in commands/ to identify what changed.\n" +
    "2. Re-run the full corpus locally:\n" +
    "   node scripts/eval-harness-runner.mjs --mode full\n" +
    "3. If the regression is real: fix the spec, re-run, update the baseline\n" +
    "   (see docs/design/eval-gate-runbook.md).\n" +
    "4. If the regression is a false positive: see the Override section in\n" +
    "   docs/design/eval-gate-runbook.md."
  );
}

/** Resolve scripts/eval-gate-baseline.json relative to this script's own directory,
 *  so seed mode is robust regardless of the invoking CWD. */
function defaultBaselinePath() {
  return join(dirname(fileURLToPath(import.meta.url)), "eval-gate-baseline.json");
}

function usageError() {
  process.stderr.write(
    "ERROR: usage: eval-gate-scorecard.mjs <scorecard.json> <baseline.json>\n" +
      "   or: eval-gate-scorecard.mjs <scorecard.json> --seed\n",
  );
  process.exit(1);
}

function main() {
  const [scorecardArg, secondArg] = process.argv.slice(2);

  if (!scorecardArg) usageError();

  let fresh;
  try {
    fresh = readJsonFile(scorecardArg);
  } catch (e) {
    process.stderr.write(`ERROR: cannot read scorecard "${scorecardArg}": ${e.message}\n`);
    process.exit(1);
  }

  if (secondArg === "--seed") {
    try {
      validateScorecard(fresh, { requiredFields: REQUIRED_FIELDS, label: "scorecard" });
    } catch (e) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      process.exit(1);
    }
    const baselinePath = defaultBaselinePath();
    try {
      writeFileSync(baselinePath, JSON.stringify(fresh, null, 2) + "\n");
    } catch (e) {
      process.stderr.write(`ERROR: cannot write baseline "${baselinePath}": ${e.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`Baseline updated: ${baselinePath}\n`);
    process.stdout.write(`New baseline success_rate_pct: ${fresh.success_rate_pct}\n`);
    return;
  }

  if (!secondArg) usageError();

  let baseline;
  try {
    baseline = readJsonFile(secondArg);
  } catch (e) {
    process.stderr.write(`ERROR: cannot read baseline "${secondArg}": ${e.message}\n`);
    process.exit(1);
  }

  let result;
  try {
    result = evaluateGate(fresh, baseline);
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (!result.pass) {
    process.stderr.write(`\neval-gate FAILED: ${result.reason}${actionableStepsText()}\n`);
    process.exit(1);
  }

  process.stdout.write(`\neval-gate PASSED: ${result.reason}\n`);
}

// Run as CLI only when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
