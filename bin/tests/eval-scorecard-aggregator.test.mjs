/**
 * bin/tests/eval-scorecard-aggregator.test.mjs
 *
 * Unit tests for scripts/eval-scorecard-aggregator.mjs — the pipeline eval-harness
 * scorecard aggregator (issue #1285).
 *
 * Verifies that the aggregator correctly converts per-run result arrays into
 * scorecard JSON compatible with scripts/eval-gate-scorecard.mjs (#1286).
 *
 * All tests are pure-function; no network, no live SDK calls, no fs writes.
 * Run with: node --test bin/tests/eval-scorecard-aggregator.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_RUNS,
  VALID_STATUSES,
  validateRuns,
  median,
  mean,
  aggregate,
} from "../../scripts/eval-scorecard-aggregator.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal valid run result. */
function makeRun(overrides = {}) {
  return {
    issue: 1001,
    status: "success",
    wallClockMs: 30000,
    interventionCount: 0,
    cost: null,
    ...overrides,
  };
}

/**
 * Build a minimal valid runs array of `n` success runs with distinct issue numbers.
 * All have cost: null by default.
 */
function makeRuns(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) =>
    makeRun({ issue: 1000 + i, ...overrides }),
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("MIN_RUNS is a positive integer", () => {
    assert.ok(typeof MIN_RUNS === "number" && Number.isInteger(MIN_RUNS) && MIN_RUNS > 0);
  });

  it("VALID_STATUSES contains the four documented values", () => {
    assert.ok(VALID_STATUSES.has("success"));
    assert.ok(VALID_STATUSES.has("failure"));
    assert.ok(VALID_STATUSES.has("incomplete"));
    assert.ok(VALID_STATUSES.has("error"));
    assert.equal(VALID_STATUSES.size, 4);
  });
});

// ---------------------------------------------------------------------------
// validateRuns
// ---------------------------------------------------------------------------

describe("validateRuns", () => {
  it("accepts a valid array of MIN_RUNS success runs", () => {
    assert.doesNotThrow(() => validateRuns(makeRuns(MIN_RUNS)));
  });

  it("throws when runs is not an array", () => {
    assert.throws(() => validateRuns(null), /"runs" must be a JSON array/);
    assert.throws(() => validateRuns({ issues: [] }), /"runs" must be a JSON array/);
  });

  it("throws when runs is an empty array", () => {
    assert.throws(() => validateRuns([]), /"runs" array is empty/);
  });

  it("throws when a run is missing the issue field", () => {
    const runs = makeRuns(MIN_RUNS);
    delete runs[0].issue;
    assert.throws(() => validateRuns(runs), /"issue" must be an integer/);
  });

  it("throws when issue is not an integer", () => {
    const runs = makeRuns(MIN_RUNS);
    runs[0].issue = "not-a-number";
    assert.throws(() => validateRuns(runs), /"issue" must be an integer/);
  });

  it("throws when status is not a valid value", () => {
    const runs = makeRuns(MIN_RUNS);
    runs[0].status = "unknown";
    assert.throws(() => validateRuns(runs), /"status" must be one of/);
  });

  it("throws when wallClockMs is negative", () => {
    const runs = makeRuns(MIN_RUNS);
    runs[0].wallClockMs = -1;
    assert.throws(() => validateRuns(runs), /"wallClockMs" must be a non-negative/);
  });

  it("throws when wallClockMs is not a number", () => {
    const runs = makeRuns(MIN_RUNS);
    runs[0].wallClockMs = "fast";
    assert.throws(() => validateRuns(runs), /"wallClockMs" must be a non-negative/);
  });

  it("throws when interventionCount is not an integer", () => {
    const runs = makeRuns(MIN_RUNS);
    runs[0].interventionCount = 1.5;
    assert.throws(() => validateRuns(runs), /"interventionCount" must be a non-negative integer/);
  });

  it("throws when interventionCount is negative", () => {
    const runs = makeRuns(MIN_RUNS);
    runs[0].interventionCount = -1;
    assert.throws(() => validateRuns(runs), /"interventionCount" must be a non-negative integer/);
  });

  it("throws when cost is a negative number", () => {
    const runs = makeRuns(MIN_RUNS);
    runs[0].cost = -0.01;
    assert.throws(() => validateRuns(runs), /"cost" must be a non-negative finite number or null/);
  });

  it("accepts cost as null", () => {
    const runs = makeRuns(MIN_RUNS, { cost: null });
    assert.doesNotThrow(() => validateRuns(runs));
  });

  it("accepts cost as a positive number", () => {
    const runs = makeRuns(MIN_RUNS, { cost: 0.005 });
    assert.doesNotThrow(() => validateRuns(runs));
  });

  it("accepts runs where cost field is absent (treated as null)", () => {
    const runs = makeRuns(MIN_RUNS).map((r) => {
      const copy = { ...r };
      delete copy.cost;
      return copy;
    });
    assert.doesNotThrow(() => validateRuns(runs));
  });

  it("enforces MIN_RUNS on scoreable (success/failure) runs", () => {
    // All error/incomplete — scoreable count is 0.
    const runs = makeRuns(MIN_RUNS + 2, { status: "error" });
    assert.throws(() => validateRuns(runs), new RegExp(`minimum is ${MIN_RUNS}`));
  });

  it("passes when scoreable count is exactly MIN_RUNS even if extra error runs exist", () => {
    const scoreable = makeRuns(MIN_RUNS, { status: "success" });
    const extras = makeRuns(3, { status: "error" }).map((r, i) => ({
      ...r,
      issue: 9000 + i,
    }));
    assert.doesNotThrow(() => validateRuns([...scoreable, ...extras]));
  });

  it("passes when there are MIN_RUNS failure runs (failure is scoreable)", () => {
    const runs = makeRuns(MIN_RUNS, { status: "failure" });
    assert.doesNotThrow(() => validateRuns(runs));
  });
});

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

describe("median", () => {
  it("returns null for an empty array", () => {
    assert.equal(median([]), null);
  });

  it("returns the single value for a length-1 array", () => {
    assert.equal(median([42]), 42);
  });

  it("returns the middle element for an odd-length array", () => {
    assert.equal(median([1, 3, 5]), 3);
  });

  it("returns the average of the two middle elements for an even-length array", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
});

// ---------------------------------------------------------------------------
// mean
// ---------------------------------------------------------------------------

describe("mean", () => {
  it("returns null for an empty array", () => {
    assert.equal(mean([]), null);
  });

  it("computes the arithmetic mean", () => {
    assert.equal(mean([2, 4, 6]), 4);
  });

  it("handles a single element", () => {
    assert.equal(mean([7]), 7);
  });
});

// ---------------------------------------------------------------------------
// aggregate — output schema compatibility with eval-gate-scorecard.mjs
// ---------------------------------------------------------------------------

describe("aggregate", () => {
  it("emits schema_version: '1' (required by eval-gate-scorecard.mjs)", () => {
    const sc = aggregate(makeRuns(5));
    assert.equal(sc.schema_version, "1");
  });

  it("emits issues_run matching the run array length", () => {
    const runs = makeRuns(7);
    const sc = aggregate(runs);
    assert.equal(sc.issues_run, 7);
  });

  it("emits successful_runs and failed_runs correctly", () => {
    const runs = [
      ...makeRuns(3, { status: "success" }),
      makeRun({ issue: 2001, status: "failure" }),
      makeRun({ issue: 2002, status: "failure" }),
    ];
    const sc = aggregate(runs);
    assert.equal(sc.successful_runs, 3);
    assert.equal(sc.failed_runs, 2);
  });

  it("computes success_rate_pct correctly (rounded to 2dp)", () => {
    // 4 success out of 5 → 80%
    const runs = [
      ...makeRuns(4, { status: "success" }),
      makeRun({ issue: 2001, status: "failure" }),
    ];
    const sc = aggregate(runs);
    assert.equal(sc.success_rate_pct, 80);
  });

  it("success_rate_pct matches successful_runs / issues_run * 100 (gate consistency)", () => {
    const runs = makeRuns(7, { status: "success" });
    runs.push(makeRun({ issue: 8000, status: "failure" }));
    runs.push(makeRun({ issue: 8001, status: "failure" }));
    // 7/9 ≈ 77.78%
    const sc = aggregate(runs);
    const computed = Math.round((sc.successful_runs / sc.issues_run) * 100 * 100) / 100;
    assert.ok(Math.abs(sc.success_rate_pct - computed) < 0.01, `rate mismatch: ${sc.success_rate_pct} vs computed ${computed}`);
  });

  it("emits mean_wall_clock_ms and median_wall_clock_ms", () => {
    const runs = [
      makeRun({ wallClockMs: 10000 }),
      makeRun({ issue: 1001, wallClockMs: 20000 }),
      makeRun({ issue: 1002, wallClockMs: 30000 }),
      makeRun({ issue: 1003, wallClockMs: 40000 }),
      makeRun({ issue: 1004, wallClockMs: 50000 }),
    ];
    const sc = aggregate(runs);
    assert.equal(sc.mean_wall_clock_ms, 30000);
    assert.equal(sc.median_wall_clock_ms, 30000);
  });

  it("emits total_intervention_count summed across all runs", () => {
    const runs = makeRuns(5);
    runs[0].interventionCount = 2;
    runs[1].interventionCount = 1;
    const sc = aggregate(runs);
    assert.equal(sc.total_intervention_count, 3);
  });

  it("sets cost to null when any run has cost null", () => {
    const runs = makeRuns(5, { cost: null });
    const sc = aggregate(runs);
    assert.equal(sc.cost, null);
  });

  it("sets cost to the sum when all runs have a real cost", () => {
    const runs = makeRuns(5, { cost: 0.01 });
    const sc = aggregate(runs);
    // 5 * 0.01 = 0.05
    assert.equal(sc.cost, 0.05);
  });

  it("sets cost to null if cost field is absent on any run", () => {
    const runs = makeRuns(5, { cost: 0.01 });
    delete runs[2].cost;
    const sc = aggregate(runs);
    assert.equal(sc.cost, null);
  });

  it("defaults run_mode to 'full'", () => {
    const sc = aggregate(makeRuns(5));
    assert.equal(sc.run_mode, "full");
  });

  it("accepts run_mode 'subset'", () => {
    const sc = aggregate(makeRuns(5), { run_mode: "subset" });
    assert.equal(sc.run_mode, "subset");
  });

  it("throws when run_mode is invalid", () => {
    assert.throws(() => aggregate(makeRuns(5), { run_mode: "turbo" }), /run_mode must be/);
  });

  it("passes through run_id and spec_sha from meta", () => {
    const sc = aggregate(makeRuns(5), { run_id: "run-001", spec_sha: "abc123" });
    assert.equal(sc.run_id, "run-001");
    assert.equal(sc.spec_sha, "abc123");
  });

  it("defaults corpus_size to issues_run when meta.corpus_size is absent", () => {
    const sc = aggregate(makeRuns(5));
    assert.equal(sc.corpus_size, sc.issues_run);
    assert.equal(sc.corpus_size, 5);
  });

  it("passes through an explicit corpus_size distinct from issues_run (subset aggregation)", () => {
    const sc = aggregate(makeRuns(5), { corpus_size: 20, run_mode: "subset" });
    assert.equal(sc.corpus_size, 20);
    assert.equal(sc.issues_run, 5);
    assert.notEqual(sc.corpus_size, sc.issues_run);
  });

  it("emits generated_at as an ISO-8601 timestamp", () => {
    const sc = aggregate(makeRuns(5));
    assert.match(sc.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("a deliberately degraded corpus (all failures) scores success_rate_pct: 0", () => {
    const runs = makeRuns(MIN_RUNS, { status: "failure" });
    const sc = aggregate(runs);
    assert.equal(sc.success_rate_pct, 0);
    assert.equal(sc.successful_runs, 0);
    assert.equal(sc.failed_runs, MIN_RUNS);
  });

  it("a perfect corpus scores success_rate_pct: 100", () => {
    const runs = makeRuns(MIN_RUNS, { status: "success" });
    const sc = aggregate(runs);
    assert.equal(sc.success_rate_pct, 100);
  });

  it("incomplete and error runs count against success_rate_pct", () => {
    // 3 success, 1 incomplete, 1 error → 3/5 = 60%
    const runs = [
      ...makeRuns(3, { status: "success" }),
      makeRun({ issue: 2001, status: "incomplete" }),
      makeRun({ issue: 2002, status: "error" }),
    ];
    const sc = aggregate(runs);
    assert.equal(sc.success_rate_pct, 60);
  });

  it("scorecard keys satisfy the eval-gate-scorecard.mjs REQUIRED_FIELDS", () => {
    // eval-gate-scorecard.mjs requires: schema_version, issues_run, successful_runs,
    // failed_runs, success_rate_pct, run_mode
    const sc = aggregate(makeRuns(5));
    const required = [
      "schema_version",
      "issues_run",
      "successful_runs",
      "failed_runs",
      "success_rate_pct",
      "run_mode",
    ];
    for (const key of required) {
      assert.ok(Object.prototype.hasOwnProperty.call(sc, key), `missing gate-required key: ${key}`);
    }
  });
});
