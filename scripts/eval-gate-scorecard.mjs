#!/usr/bin/env node
/**
 * scripts/eval-gate-scorecard.mjs — Pipeline eval-gate scorecard aggregator (#1285)
 *
 * Deterministic, zero-network aggregator for the ForgeDock headless eval harness.
 * Reads an array of per-run results (one per corpus issue) produced by
 * bin/batch-runner.mjs and emits a scorecard JSON: one-shot success rate,
 * mean/median wall-clock, human-intervention count, and (nullable) cost.
 *
 * It does NOT call any model, network, or live SDK — it only aggregates the
 * structured output that bin/batch-runner.mjs produces.
 * See docs/spec/eval-run-result.md for the JSON schema.
 *
 * Usage:
 *   node scripts/eval-gate-scorecard.mjs <runs.json>   # read file, print scorecard JSON
 *   node scripts/eval-gate-scorecard.mjs -             # read runs JSON from stdin
 *   cat runs.json | node scripts/eval-gate-scorecard.mjs
 *
 * Input format: a JSON object with a "runs" array of per-run result objects,
 * plus optional metadata fields (corpus_version, spec_version, model).
 *
 * Methodology rule (enforced): fewer than MIN_RUNS valid, scoreable runs is a
 * HARD ERROR — the script exits non-zero rather than emit a misleading rate.
 * Mirrors bench-scorecard.mjs's MIN_RUNS methodology rule.
 *
 * Exit codes:
 *   0 = scorecard emitted successfully
 *   1 = invalid input (bad JSON, n < MIN_RUNS, missing required fields)
 */

/** Minimum number of scoreable (non-error, non-incomplete) runs required. */
export const MIN_RUNS = 5;

/** Valid status values for a per-run result object. */
export const VALID_STATUSES = new Set(["success", "failure", "incomplete", "error"]);

/**
 * Validate an array of raw run-result objects.
 * Throws a descriptive Error on any violation.
 *
 * @param {unknown[]} runs
 * @returns {void}
 */
export function validateRuns(runs) {
  if (!Array.isArray(runs)) {
    throw new Error('"runs" must be a JSON array');
  }
  if (runs.length === 0) {
    throw new Error('"runs" array is empty — nothing to score');
  }
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (!r || typeof r !== "object") {
      throw new Error(`run[${i}]: must be an object`);
    }
    if (typeof r.issue !== "number" || !Number.isInteger(r.issue)) {
      throw new Error(`run[${i}]: "issue" must be an integer (got ${JSON.stringify(r.issue)})`);
    }
    if (!VALID_STATUSES.has(r.status)) {
      throw new Error(
        `run[${i}] (issue ${r.issue}): "status" must be one of ${[...VALID_STATUSES].join(", ")} (got ${JSON.stringify(r.status)})`,
      );
    }
    if (typeof r.wallClockMs !== "number" || !Number.isFinite(r.wallClockMs) || r.wallClockMs < 0) {
      throw new Error(
        `run[${i}] (issue ${r.issue}): "wallClockMs" must be a non-negative finite number (got ${JSON.stringify(r.wallClockMs)})`,
      );
    }
    if (typeof r.interventionCount !== "number" || !Number.isInteger(r.interventionCount) || r.interventionCount < 0) {
      throw new Error(
        `run[${i}] (issue ${r.issue}): "interventionCount" must be a non-negative integer (got ${JSON.stringify(r.interventionCount)})`,
      );
    }
    // cost is optional/nullable — validate only when present and non-null
    if (r.cost !== undefined && r.cost !== null) {
      if (typeof r.cost !== "number" || !Number.isFinite(r.cost) || r.cost < 0) {
        throw new Error(
          `run[${i}] (issue ${r.issue}): "cost" must be a non-negative finite number or null (got ${JSON.stringify(r.cost)})`,
        );
      }
    }
  }

  // Enforce minimum sample size on scoreable runs (excludes "error" / "incomplete").
  const scoreable = runs.filter((r) => r.status === "success" || r.status === "failure");
  if (scoreable.length < MIN_RUNS) {
    throw new Error(
      `only ${scoreable.length} scoreable run(s) (status "success" or "failure") found; ` +
        `minimum is ${MIN_RUNS}. Add more corpus issues or fix erroring/incomplete runs.`,
    );
  }
}

/**
 * Compute the median of a sorted numeric array.
 * Returns null for an empty array.
 *
 * @param {number[]} sorted - Must be pre-sorted ascending.
 * @returns {number|null}
 */
export function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Arithmetic mean of a numeric array.
 * Returns null for an empty array.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Round to 3 decimal places (avoids floating-point noise in output). */
function round(x) {
  return x === null ? null : Math.round(x * 1000) / 1000;
}

/**
 * Aggregate validated run-result objects into a scorecard.
 *
 * Does NOT re-validate — call validateRuns() first.
 *
 * @param {object[]} runs
 * @param {{corpus_version?: string|null, spec_version?: string|null, model?: string|null}} [meta]
 * @returns {object} Scorecard object (matches docs/spec/eval-run-result.md).
 */
export function aggregate(runs, meta = {}) {
  const nRuns = runs.length;
  const nSuccess = runs.filter((r) => r.status === "success").length;
  const nFailure = runs.filter((r) => r.status === "failure").length;
  const nIncomplete = runs.filter(
    (r) => r.status === "incomplete" || r.status === "error",
  ).length;

  const oneShotSuccessRate = round(nSuccess / nRuns);

  // Wall-clock stats — include ALL runs (errors and incompletes still have a
  // measured wall-clock duration and skewing them out would hide hangs).
  const wallClockValues = runs.map((r) => r.wallClockMs).sort((a, b) => a - b);
  const wallClockMean = mean(wallClockValues);
  const wallClockMedian = median(wallClockValues);

  // Intervention stats — sum across all runs.
  const totalInterventions = runs.reduce((sum, r) => sum + r.interventionCount, 0);

  // Cost: null if any run has cost === null or cost is absent; sum otherwise.
  let totalCost = null;
  const costValues = runs.map((r) => (r.cost !== undefined ? r.cost : null));
  if (costValues.every((c) => c !== null)) {
    totalCost = round(costValues.reduce((a, b) => a + b, 0));
  }

  // Model / spec_version: use first non-null value seen across runs (batch
  // driver should stamp each run; metadata header takes precedence).
  const resolvedModel =
    meta.model ??
    runs.map((r) => r.model ?? null).find((m) => m !== null) ??
    null;
  const resolvedSpecVersion =
    meta.spec_version ??
    runs.map((r) => r.specVersion ?? null).find((v) => v !== null) ??
    null;

  return {
    corpus_version: meta.corpus_version ?? null,
    spec_version: resolvedSpecVersion,
    model: resolvedModel,
    n_runs: nRuns,
    n_success: nSuccess,
    n_failure: nFailure,
    n_incomplete: nIncomplete,
    one_shot_success_rate: oneShotSuccessRate,
    wall_clock_ms: {
      mean: round(wallClockMean),
      median: round(wallClockMedian),
      min: wallClockValues.length > 0 ? wallClockValues[0] : null,
      max: wallClockValues.length > 0 ? wallClockValues[wallClockValues.length - 1] : null,
    },
    intervention: {
      total: totalInterventions,
      mean_per_run: round(totalInterventions / nRuns),
    },
    cost: totalCost,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function readInput(arg) {
  const { readFileSync } = await import("node:fs");
  if (!arg || arg === "-") {
    return readFileSync(0, "utf8"); // fd 0 = stdin
  }
  return readFileSync(arg, "utf8");
}

async function main() {
  const arg = process.argv[2];
  let raw;
  try {
    raw = await readInput(arg);
  } catch (e) {
    process.stderr.write(`ERROR: cannot read input: ${e.message}\n`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`ERROR: invalid JSON: ${e.message}\n`);
    process.exit(1);
  }

  if (!data || typeof data !== "object") {
    process.stderr.write(`ERROR: input must be a JSON object with a "runs" array\n`);
    process.exit(1);
  }

  const { runs, corpus_version, spec_version, model } = data;

  try {
    validateRuns(runs);
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exit(1);
  }

  const scorecard = aggregate(runs, { corpus_version, spec_version, model });
  process.stdout.write(JSON.stringify(scorecard, null, 2) + "\n");
}

// Run as CLI only when invoked directly, not when imported by tests.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
