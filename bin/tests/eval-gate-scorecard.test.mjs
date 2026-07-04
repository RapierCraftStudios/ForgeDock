/**
 * bin/tests/eval-gate-scorecard.test.mjs
 *
 * Unit tests for scripts/eval-gate-scorecard.mjs — the pipeline eval-gate
 * scorecard aggregator (issue #1285).
 *
 * All tests are pure-function; no network, no live SDK calls, no fs writes.
 * Run with: node --test bin/tests/eval-gate-scorecard.test.mjs
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
} from "../../scripts/eval-gate-scorecard.mjs";

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
// aggregate
// ---------------------------------------------------------------------------

describe("aggregate", () => {
  it("reports correct counts for a mixed-status corpus", () => {
    const runs = [
      ...makeRuns(3, { status: "success" }),
      makeRun({ issue: 2001, status: "failure" }),
      makeRun({ issue: 2002, status: "failure" }),
      makeRun({ issue: 2003, status: "incomplete" }),
      makeRun({ issue: 2004, status: "error" }),
    ];
    const sc = aggregate(runs);
    assert.equal(sc.n_runs, 7);
    assert.equal(sc.n_success, 3);
    assert.equal(sc.n_failure, 2);
    assert.equal(sc.n_incomplete, 2); // incomplete + error
  });

  it("computes one_shot_success_rate correctly", () => {
    // 4 success out of 5 → 0.8
    const runs = [
      ...makeRuns(4, { status: "success" }),
      makeRun({ issue: 2001, status: "failure" }),
    ];
    const sc = aggregate(runs);
    assert.equal(sc.one_shot_success_rate, 0.8);
  });

  it("computes wall_clock_ms mean and median", () => {
    const runs = [
      makeRun({ wallClockMs: 10000 }),
      makeRun({ issue: 1001, wallClockMs: 20000 }),
      makeRun({ issue: 1002, wallClockMs: 30000 }),
      makeRun({ issue: 1003, wallClockMs: 40000 }),
      makeRun({ issue: 1004, wallClockMs: 50000 }),
    ];
    const sc = aggregate(runs);
    assert.equal(sc.wall_clock_ms.mean, 30000);
    assert.equal(sc.wall_clock_ms.median, 30000);
    assert.equal(sc.wall_clock_ms.min, 10000);
    assert.equal(sc.wall_clock_ms.max, 50000);
  });

  it("computes intervention totals and mean_per_run", () => {
    const runs = makeRuns(5);
    runs[0].interventionCount = 2;
    runs[1].interventionCount = 1;
    const sc = aggregate(runs);
    assert.equal(sc.intervention.total, 3);
    assert.equal(sc.intervention.mean_per_run, 0.6);
  });

  it("sets cost to null when any run has cost null", () => {
    const runs = makeRuns(5, { cost: null });
    const sc = aggregate(runs);
    assert.equal(sc.cost, null);
  });

  it("sets cost to the sum when all runs have a real cost", () => {
    const runs = makeRuns(5, { cost: 0.01 });
    const sc = aggregate(runs);
    // 5 * 0.01 = 0.05 (rounded to 3dp)
    assert.equal(sc.cost, 0.05);
  });

  it("sets cost to null if cost field is absent on any run", () => {
    const runs = makeRuns(5, { cost: 0.01 });
    delete runs[2].cost;
    const sc = aggregate(runs);
    assert.equal(sc.cost, null);
  });

  it("passes through corpus_version and spec_version from meta", () => {
    const runs = makeRuns(5);
    const sc = aggregate(runs, {
      corpus_version: "v2",
      spec_version: "1.0.99",
      model: "claude-opus-4",
    });
    assert.equal(sc.corpus_version, "v2");
    assert.equal(sc.spec_version, "1.0.99");
    assert.equal(sc.model, "claude-opus-4");
  });

  it("picks model from runs when meta.model is absent", () => {
    const runs = makeRuns(5, { model: "claude-test-model" });
    const sc = aggregate(runs);
    assert.equal(sc.model, "claude-test-model");
  });

  it("a deliberately degraded corpus (all failures) scores 0 success rate", () => {
    const runs = makeRuns(MIN_RUNS, { status: "failure" });
    const sc = aggregate(runs);
    assert.equal(sc.one_shot_success_rate, 0);
    assert.equal(sc.n_success, 0);
    assert.equal(sc.n_failure, MIN_RUNS);
  });

  it("a perfect corpus scores a success rate of 1", () => {
    const runs = makeRuns(MIN_RUNS, { status: "success" });
    const sc = aggregate(runs);
    assert.equal(sc.one_shot_success_rate, 1);
  });

  it("scorecard keys match documented schema shape", () => {
    const sc = aggregate(makeRuns(5));
    const expectedKeys = [
      "corpus_version",
      "spec_version",
      "model",
      "n_runs",
      "n_success",
      "n_failure",
      "n_incomplete",
      "one_shot_success_rate",
      "wall_clock_ms",
      "intervention",
      "cost",
    ];
    for (const key of expectedKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(sc, key), `missing key: ${key}`);
    }
    const wallKeys = ["mean", "median", "min", "max"];
    for (const k of wallKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(sc.wall_clock_ms, k), `missing wall_clock_ms.${k}`);
    }
    assert.ok(Object.prototype.hasOwnProperty.call(sc.intervention, "total"));
    assert.ok(Object.prototype.hasOwnProperty.call(sc.intervention, "mean_per_run"));
  });
});
