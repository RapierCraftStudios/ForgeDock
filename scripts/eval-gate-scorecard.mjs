#!/usr/bin/env node
/**
 * scripts/eval-gate-scorecard.mjs — Pipeline eval regression gate (#1286)
 *
 * Deterministic, zero-network aggregator that compares a fresh eval run's
 * scorecard against a committed baseline and fails CI if the pipeline has
 * regressed beyond the defined threshold.
 *
 * This script DOES NOT invoke any model or network. It only consumes the
 * machine-readable scorecard JSON that the eval harness (#1285) produces and
 * compares it against the committed baseline in scripts/eval-gate-baseline.json.
 *
 * Usage:
 *   node scripts/eval-gate-scorecard.mjs <fresh-scorecard.json> [<baseline.json>]
 *   node scripts/eval-gate-scorecard.mjs -                         # fresh from stdin
 *
 * Positional arguments:
 *   1. fresh-scorecard  Path to the just-produced scorecard, or "-" for stdin.
 *   2. baseline         Path to the committed baseline (default:
 *                       scripts/eval-gate-baseline.json relative to cwd).
 *
 * Regression threshold (REGRESSION_THRESHOLD_PP):
 *   A drop in one-shot success rate of MORE THAN this many percentage points
 *   compared to the baseline constitutes a regression and causes a non-zero exit.
 *   Threshold is intentionally generous (5 pp) to avoid false positives from
 *   natural run-to-run variance in small corpora, while still catching real
 *   spec degradation.
 *
 *   Rationale: the harness (#1285) defines "success" as completing the target
 *   phase without human intervention. A 5 pp drop on a 20-issue corpus means
 *   one extra failure. On the 5-issue subset it means one failure (20 pp) —
 *   see MIN_RUNS_FOR_RATE_ASSERTION below for the subset carve-out.
 *
 * Minimum run count (MIN_RUNS):
 *   Mirrors bench-scorecard.mjs's methodology rule: n=1 is a lie. Any scorecard
 *   with fewer than MIN_RUNS is rejected as statistically meaningless.
 *
 * Baseline "seeding" mode:
 *   When the baseline file is absent or empty, the script writes the fresh
 *   scorecard as the new baseline and exits 0. This bootstraps CI on first run.
 *   To force a re-seed without deleting the file, pass --seed.
 *
 * Exit codes:
 *   0 = pass (no regression, or baseline seeded)
 *   1 = regression detected (delta exceeds threshold) — actionable message printed
 *   2 = invalid input (bad JSON, missing fields, n < MIN_RUNS)
 *   3 = internal error (file I/O, unexpected shape)
 *
 * <!-- forge#1286 -->
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants — all thresholds are documented here for CI runbook reference.
// ---------------------------------------------------------------------------

/** Minimum issues in a scorecard before reporting a rate. */
const MIN_RUNS = 3;

/**
 * Regression threshold in percentage points.
 * A drop in success_rate_pct exceeding this value vs the baseline fails the gate.
 * Value is exclusive: drop > THRESHOLD triggers failure.
 * Example: baseline=80, fresh=74 → drop=6 pp → FAIL (6 > 5).
 *          baseline=80, fresh=75 → drop=5 pp → PASS (5 = 5, not strictly greater).
 */
const REGRESSION_THRESHOLD_PP = 5;

/**
 * On very small subset runs (n < this value) the absolute pp threshold is not
 * asserted — only structural validity and the minimum run count are checked.
 * Rationale: with n=3 a single failure is a 33 pp drop, which would always fail
 * the gate even with zero spec changes. The gate still runs and emits a
 * non-blocking summary, alerting humans without blocking the PR.
 *
 * Full-corpus runs (n >= this value) always apply the threshold.
 */
const MIN_RUNS_FOR_RATE_ASSERTION = 8;

// ---------------------------------------------------------------------------
// Scorecard schema (produced by harness #1285)
// ---------------------------------------------------------------------------
//
// {
//   "schema_version": "1",
//   "run_id": "<string>",
//   "generated_at": "<ISO8601>",
//   "corpus_size": <number>,          // total issues in corpus
//   "issues_run": <number>,           // issues actually executed (subset or full)
//   "successful_runs": <number>,      // one-shot successes (no human intervention)
//   "failed_runs": <number>,
//   "success_rate_pct": <number>,     // successful_runs / issues_run * 100, rounded to 2dp
//   "mean_wall_clock_ms": <number|null>,
//   "median_wall_clock_ms": <number|null>,
//   "total_intervention_count": <number>,
//   "cost": <number|null>,            // nullable until #1255 lands
//   "run_mode": "subset" | "full",
//   "spec_sha": "<string|null>"       // git sha of commands/ tree at run time (optional)
// }

/** Required top-level fields in a valid scorecard. */
const REQUIRED_FIELDS = [
  "schema_version",
  "issues_run",
  "successful_runs",
  "failed_runs",
  "success_rate_pct",
  "run_mode",
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a scorecard object. Throws a descriptive Error on any violation.
 * @param {object} sc - parsed scorecard
 * @param {string} label - "fresh" or "baseline" for error messages
 */
function validate(sc, label) {
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) {
    throw new Error(`${label} scorecard must be a JSON object`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in sc)) {
      throw new Error(`${label} scorecard missing required field: "${field}"`);
    }
  }
  if (typeof sc.issues_run !== "number" || sc.issues_run < 0) {
    throw new Error(`${label} scorecard: issues_run must be a non-negative number`);
  }
  if (sc.issues_run < MIN_RUNS) {
    throw new Error(
      `${label} scorecard: issues_run=${sc.issues_run} is below minimum ${MIN_RUNS}. ` +
        `n=1 is a lie — run at least ${MIN_RUNS} issues before reporting a rate.`,
    );
  }
  if (typeof sc.success_rate_pct !== "number") {
    throw new Error(`${label} scorecard: success_rate_pct must be a number`);
  }
  if (sc.success_rate_pct < 0 || sc.success_rate_pct > 100) {
    throw new Error(
      `${label} scorecard: success_rate_pct=${sc.success_rate_pct} is out of range [0,100]`,
    );
  }
  const computed = sc.issues_run > 0 ? (sc.successful_runs / sc.issues_run) * 100 : 0;
  const rounded = Math.round(computed * 100) / 100;
  if (Math.abs(rounded - sc.success_rate_pct) > 0.1) {
    throw new Error(
      `${label} scorecard: success_rate_pct=${sc.success_rate_pct} does not match ` +
        `computed ${rounded} from successful_runs=${sc.successful_runs} / issues_run=${sc.issues_run}`,
    );
  }
  if (!["subset", "full"].includes(sc.run_mode)) {
    throw new Error(`${label} scorecard: run_mode must be "subset" or "full", got "${sc.run_mode}"`);
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare a fresh scorecard against the baseline.
 * Returns a result object describing pass/fail and the delta.
 *
 * @param {object} fresh
 * @param {object} baseline
 * @returns {{ pass: boolean, drop_pp: number, threshold_pp: number,
 *             rate_assertion_skipped: boolean, reason: string }}
 */
function compare(fresh, baseline) {
  const drop_pp = Math.round((baseline.success_rate_pct - fresh.success_rate_pct) * 100) / 100;
  const rate_assertion_skipped = fresh.issues_run < MIN_RUNS_FOR_RATE_ASSERTION;

  if (rate_assertion_skipped) {
    return {
      pass: true,
      drop_pp,
      threshold_pp: REGRESSION_THRESHOLD_PP,
      rate_assertion_skipped: true,
      reason:
        `Subset run (n=${fresh.issues_run} < ${MIN_RUNS_FOR_RATE_ASSERTION}): ` +
        `rate assertion skipped to avoid false positives. ` +
        `Success rate: ${fresh.success_rate_pct}% vs baseline ${baseline.success_rate_pct}% ` +
        `(delta: ${drop_pp >= 0 ? "-" : "+"}${Math.abs(drop_pp)} pp). ` +
        `Run with full corpus to assert regression threshold.`,
    };
  }

  const pass = drop_pp <= REGRESSION_THRESHOLD_PP;
  const sign = drop_pp >= 0 ? "-" : "+";
  const absDrop = Math.abs(drop_pp);

  const reason = pass
    ? `PASS: success rate ${fresh.success_rate_pct}% vs baseline ${baseline.success_rate_pct}% ` +
      `(delta: ${sign}${absDrop} pp, threshold: ${REGRESSION_THRESHOLD_PP} pp)`
    : `REGRESSION: success rate dropped ${absDrop} pp ` +
      `(${fresh.success_rate_pct}% fresh vs ${baseline.success_rate_pct}% baseline). ` +
      `Threshold is ${REGRESSION_THRESHOLD_PP} pp. ` +
      `A deliberate spec degradation or a real pipeline regression caused this failure. ` +
      `See docs/design/eval-gate-runbook.md for triage steps.`;

  return { pass, drop_pp, threshold_pp: REGRESSION_THRESHOLD_PP, rate_assertion_skipped: false, reason };
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function readInput(pathOrDash) {
  if (!pathOrDash || pathOrDash === "-") {
    return readFileSync(0, "utf8"); // fd 0 = stdin
  }
  return readFileSync(pathOrDash, "utf8");
}

function parseJSON(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label}: invalid JSON — ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const seed = args.includes("--seed");
  const filteredArgs = args.filter((a) => a !== "--seed");

  const freshArg = filteredArgs[0]; // path or "-" or undefined (stdin)
  const baselineArg = filteredArgs[1]; // path or undefined

  // Resolve baseline path: argument > default relative to cwd.
  const defaultBaselinePath = resolve(process.cwd(), "scripts/eval-gate-baseline.json");
  const baselinePath = baselineArg ? resolve(baselineArg) : defaultBaselinePath;

  // --- Read and validate fresh scorecard ---
  let freshRaw;
  try {
    freshRaw = readInput(freshArg);
  } catch (e) {
    process.stderr.write(`ERROR: cannot read fresh scorecard: ${e.message}\n`);
    process.exit(2);
  }

  let fresh;
  try {
    fresh = parseJSON(freshRaw, "fresh scorecard");
    validate(fresh, "fresh");
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exit(2);
  }

  // --- Seeding mode: no baseline yet or --seed forced ---
  const baselineExists = existsSync(baselinePath) && !seed;
  if (!baselineExists) {
    process.stdout.write(`Seeding baseline from fresh scorecard → ${baselinePath}\n`);
    try {
      writeFileSync(baselinePath, JSON.stringify(fresh, null, 2) + "\n");
    } catch (e) {
      process.stderr.write(`ERROR: cannot write baseline: ${e.message}\n`);
      process.exit(3);
    }
    process.stdout.write(
      `Baseline seeded. success_rate_pct=${fresh.success_rate_pct}%, ` +
        `issues_run=${fresh.issues_run}, run_mode=${fresh.run_mode}\n`,
    );
    process.stdout.write(`Commit ${baselinePath} to the repo to lock in this baseline.\n`);
    process.exit(0);
  }

  // --- Read and validate baseline ---
  let baselineRaw;
  try {
    baselineRaw = readFileSync(baselinePath, "utf8");
  } catch (e) {
    process.stderr.write(`ERROR: cannot read baseline at ${baselinePath}: ${e.message}\n`);
    process.stderr.write(`Hint: run with --seed to create the baseline from the fresh scorecard.\n`);
    process.exit(3);
  }

  let baseline;
  try {
    baseline = parseJSON(baselineRaw, "baseline scorecard");
    validate(baseline, "baseline");
  } catch (e) {
    process.stderr.write(`ERROR: baseline is invalid — ${e.message}\n`);
    process.stderr.write(
      `Hint: the baseline at ${baselinePath} is malformed. ` +
        `Fix it manually or re-seed with --seed.\n`,
    );
    process.exit(2);
  }

  // --- Compare ---
  const result = compare(fresh, baseline);

  // Emit structured result for CI log parsing.
  const output = {
    pass: result.pass,
    fresh_success_rate_pct: fresh.success_rate_pct,
    baseline_success_rate_pct: baseline.success_rate_pct,
    drop_pp: result.drop_pp,
    threshold_pp: result.threshold_pp,
    rate_assertion_skipped: result.rate_assertion_skipped,
    fresh_issues_run: fresh.issues_run,
    fresh_run_mode: fresh.run_mode,
    baseline_run_id: baseline.run_id ?? null,
    fresh_run_id: fresh.run_id ?? null,
    reason: result.reason,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  if (result.pass) {
    process.stdout.write(`\neval-gate: ${result.reason}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`\neval-gate FAILED: ${result.reason}\n`);
    process.stderr.write(
      `\nActionable steps:\n` +
        `  1. Review the diff in commands/ to identify what changed.\n` +
        `  2. Re-run the full corpus locally: node scripts/eval-harness-runner.mjs --mode full\n` +
        `  3. If the regression is real: fix the spec, re-run, update the baseline.\n` +
        `  4. If the regression is a false positive (e.g. flaky sandbox): ` +
        `see docs/design/eval-gate-runbook.md §Override.\n`,
    );
    process.exit(1);
  }
}

// Run as CLI only when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

// Named exports for unit tests.
export { validate, compare, MIN_RUNS, MIN_RUNS_FOR_RATE_ASSERTION, REGRESSION_THRESHOLD_PP };
