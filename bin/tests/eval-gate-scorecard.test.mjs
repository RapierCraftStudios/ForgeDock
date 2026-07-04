/**
 * bin/tests/eval-gate-scorecard.test.mjs
 *
 * Unit tests for scripts/eval-gate-scorecard.mjs — the pipeline eval regression
 * gate aggregator (#1286).
 *
 * Covers (all without network or file I/O side effects):
 *   - validate: accepts valid scorecards, rejects missing fields, bad ranges,
 *     bad run_mode, computed rate mismatch, n < MIN_RUNS
 *   - compare: pass when drop <= threshold, fail when drop > threshold,
 *     skip rate assertion for small-n subset runs, handle improvements (negative drop)
 *
 * Run with: node --test bin/tests/eval-gate-scorecard.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validate,
  compare,
  MIN_RUNS,
  MIN_RUNS_FOR_RATE_ASSERTION,
  REGRESSION_THRESHOLD_PP,
} from "../../scripts/eval-gate-scorecard.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validScorecard(overrides = {}) {
  return {
    schema_version: "1",
    run_id: "test-run-001",
    generated_at: "2026-07-04T00:00:00.000Z",
    corpus_size: 20,
    issues_run: 20,
    successful_runs: 16,
    failed_runs: 4,
    success_rate_pct: 80,
    mean_wall_clock_ms: 45000,
    median_wall_clock_ms: 42000,
    total_intervention_count: 2,
    cost: null,
    run_mode: "full",
    spec_sha: "abc123",
    ...overrides,
  };
}

function subsetScorecard(overrides = {}) {
  return validScorecard({
    corpus_size: 5,
    issues_run: 5,
    successful_runs: 4,
    failed_runs: 1,
    success_rate_pct: 80,
    run_mode: "subset",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// validate() — acceptance cases
// ---------------------------------------------------------------------------

describe("validate: accepts valid scorecards", () => {
  test("full corpus scorecard", () => {
    assert.doesNotThrow(() => validate(validScorecard(), "fresh"));
  });

  test("subset scorecard", () => {
    assert.doesNotThrow(() => validate(subsetScorecard(), "fresh"));
  });

  test("100% success rate", () => {
    const sc = validScorecard({ successful_runs: 20, failed_runs: 0, success_rate_pct: 100 });
    assert.doesNotThrow(() => validate(sc, "fresh"));
  });

  test("0% success rate", () => {
    const sc = validScorecard({ successful_runs: 0, failed_runs: 20, success_rate_pct: 0 });
    assert.doesNotThrow(() => validate(sc, "fresh"));
  });

  test("nullable optional fields (cost, spec_sha)", () => {
    const sc = validScorecard({ cost: null, spec_sha: null });
    assert.doesNotThrow(() => validate(sc, "fresh"));
  });
});

// ---------------------------------------------------------------------------
// validate() — rejection cases
// ---------------------------------------------------------------------------

describe("validate: rejects invalid scorecards", () => {
  test("null input", () => {
    assert.throws(() => validate(null, "fresh"), /must be a JSON object/);
  });

  test("array input", () => {
    assert.throws(() => validate([], "fresh"), /must be a JSON object/);
  });

  test("missing schema_version", () => {
    const sc = validScorecard();
    delete sc.schema_version;
    assert.throws(() => validate(sc, "fresh"), /missing required field.*schema_version/);
  });

  test("missing issues_run", () => {
    const sc = validScorecard();
    delete sc.issues_run;
    assert.throws(() => validate(sc, "fresh"), /missing required field.*issues_run/);
  });

  test("missing success_rate_pct", () => {
    const sc = validScorecard();
    delete sc.success_rate_pct;
    assert.throws(() => validate(sc, "fresh"), /missing required field.*success_rate_pct/);
  });

  test("missing run_mode", () => {
    const sc = validScorecard();
    delete sc.run_mode;
    assert.throws(() => validate(sc, "fresh"), /missing required field.*run_mode/);
  });

  test("issues_run below MIN_RUNS", () => {
    const sc = validScorecard({
      issues_run: MIN_RUNS - 1,
      successful_runs: MIN_RUNS - 1,
      failed_runs: 0,
      success_rate_pct: 100,
    });
    assert.throws(() => validate(sc, "fresh"), /below minimum/);
  });

  test("issues_run = MIN_RUNS passes", () => {
    const sc = validScorecard({
      issues_run: MIN_RUNS,
      successful_runs: MIN_RUNS,
      failed_runs: 0,
      success_rate_pct: 100,
    });
    assert.doesNotThrow(() => validate(sc, "fresh"));
  });

  test("success_rate_pct out of range (>100)", () => {
    const sc = validScorecard({ success_rate_pct: 101 });
    assert.throws(() => validate(sc, "fresh"), /out of range/);
  });

  test("success_rate_pct out of range (<0)", () => {
    const sc = validScorecard({ success_rate_pct: -1 });
    assert.throws(() => validate(sc, "fresh"), /out of range/);
  });

  test("success_rate_pct does not match computed value", () => {
    // 15/20 = 75%, not 80%
    const sc = validScorecard({ successful_runs: 15, success_rate_pct: 80 });
    assert.throws(() => validate(sc, "fresh"), /does not match computed/);
  });

  test("invalid run_mode", () => {
    const sc = validScorecard({ run_mode: "turbo" });
    assert.throws(() => validate(sc, "fresh"), /run_mode must be/);
  });

  test("label is included in error messages", () => {
    const sc = validScorecard({ run_mode: "bad" });
    assert.throws(() => validate(sc, "baseline"), /baseline scorecard/);
  });
});

// ---------------------------------------------------------------------------
// compare() — pass cases
// ---------------------------------------------------------------------------

describe("compare: pass cases", () => {
  const baseline = validScorecard({ success_rate_pct: 80, successful_runs: 16, issues_run: 20 });

  test("no regression (same rate)", () => {
    const fresh = validScorecard({ success_rate_pct: 80, successful_runs: 16, issues_run: 20 });
    const result = compare(fresh, baseline);
    assert.equal(result.pass, true);
    assert.equal(result.drop_pp, 0);
  });

  test("improvement (rate went up)", () => {
    const fresh = validScorecard({ success_rate_pct: 85, successful_runs: 17, issues_run: 20 });
    const result = compare(fresh, baseline);
    assert.equal(result.pass, true);
    assert.ok(result.drop_pp < 0, "drop_pp should be negative for an improvement");
  });

  test("drop exactly at threshold passes (not strictly greater)", () => {
    // 80 - 75 = 5 pp = threshold → PASS
    const fresh = validScorecard({ success_rate_pct: 75, successful_runs: 15, issues_run: 20 });
    const result = compare(fresh, baseline);
    assert.equal(result.pass, true);
    assert.equal(result.drop_pp, REGRESSION_THRESHOLD_PP);
  });

  test("drop below threshold passes", () => {
    const fresh = validScorecard({ success_rate_pct: 76, successful_runs: 15.2, issues_run: 20 });
    // Adjust to valid: 15/20 = 75, already tested; use 76 → need 15.2 which is invalid
    // Use a larger corpus to get a fractional pp drop under threshold
    const bl = validScorecard({ success_rate_pct: 80, successful_runs: 80, issues_run: 100 });
    const fr = validScorecard({ success_rate_pct: 76, successful_runs: 76, issues_run: 100 });
    const res = compare(fr, bl);
    assert.equal(res.pass, true);
    assert.equal(res.drop_pp, 4);
  });
});

// ---------------------------------------------------------------------------
// compare() — fail cases
// ---------------------------------------------------------------------------

describe("compare: fail cases (regression detected)", () => {
  const baseline = validScorecard({ success_rate_pct: 80, successful_runs: 16, issues_run: 20 });

  test("drop above threshold fails", () => {
    // 80 - 74 = 6 pp > 5 pp threshold → FAIL
    const fresh = validScorecard({ success_rate_pct: 70, successful_runs: 14, issues_run: 20 });
    const result = compare(fresh, baseline);
    assert.equal(result.pass, false);
    assert.ok(result.drop_pp > REGRESSION_THRESHOLD_PP);
  });

  test("catastrophic drop (0% success)", () => {
    const fresh = validScorecard({ success_rate_pct: 0, successful_runs: 0, issues_run: 20 });
    const result = compare(fresh, baseline);
    assert.equal(result.pass, false);
    assert.equal(result.drop_pp, 80);
  });

  test("failure message mentions threshold and actionable hint", () => {
    const fresh = validScorecard({ success_rate_pct: 0, successful_runs: 0, issues_run: 20 });
    const result = compare(fresh, baseline);
    assert.match(result.reason, /REGRESSION/);
    assert.match(result.reason, /eval-gate-runbook/);
  });
});

// ---------------------------------------------------------------------------
// compare() — subset / small-n carve-out
// ---------------------------------------------------------------------------

describe("compare: subset run rate assertion skipped for n < MIN_RUNS_FOR_RATE_ASSERTION", () => {
  const baseline = subsetScorecard({ success_rate_pct: 80, successful_runs: 4, issues_run: 5 });

  test("large drop on small-n subset is NOT a failure", () => {
    // n=5 < MIN_RUNS_FOR_RATE_ASSERTION → rate assertion skipped → pass
    const fresh = subsetScorecard({ success_rate_pct: 40, successful_runs: 2, issues_run: 5 });
    const result = compare(fresh, baseline);
    assert.equal(result.pass, true);
    assert.equal(result.rate_assertion_skipped, true);
  });

  test("skipped assertion message explains the reason", () => {
    const fresh = subsetScorecard({ success_rate_pct: 40, successful_runs: 2, issues_run: 5 });
    const result = compare(fresh, baseline);
    assert.match(result.reason, /Subset run/);
    assert.match(result.reason, /rate assertion skipped/);
  });

  test("large corpus (n >= MIN_RUNS_FOR_RATE_ASSERTION) does apply threshold", () => {
    const bl = validScorecard({ success_rate_pct: 80, successful_runs: 16, issues_run: 20 });
    const fr = validScorecard({ success_rate_pct: 60, successful_runs: 12, issues_run: 20 });
    const result = compare(fr, bl);
    assert.equal(result.pass, false);
    assert.equal(result.rate_assertion_skipped, false);
  });

  test("boundary: n = MIN_RUNS_FOR_RATE_ASSERTION - 1 skips assertion", () => {
    const n = MIN_RUNS_FOR_RATE_ASSERTION - 1;
    const bl = validScorecard({ success_rate_pct: 100, successful_runs: n, issues_run: n });
    const fr = validScorecard({ success_rate_pct: 0, successful_runs: 0, issues_run: n });
    const result = compare(fr, bl);
    assert.equal(result.rate_assertion_skipped, true);
    assert.equal(result.pass, true);
  });

  test("boundary: n = MIN_RUNS_FOR_RATE_ASSERTION applies assertion", () => {
    const n = MIN_RUNS_FOR_RATE_ASSERTION;
    const bl = validScorecard({ success_rate_pct: 100, successful_runs: n, issues_run: n });
    const fr = validScorecard({ success_rate_pct: 0, successful_runs: 0, issues_run: n });
    const result = compare(fr, bl);
    assert.equal(result.rate_assertion_skipped, false);
    assert.equal(result.pass, false);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe("exported constants are sane", () => {
  test("MIN_RUNS is at least 3", () => {
    assert.ok(MIN_RUNS >= 3);
  });

  test("MIN_RUNS_FOR_RATE_ASSERTION is greater than MIN_RUNS", () => {
    assert.ok(MIN_RUNS_FOR_RATE_ASSERTION > MIN_RUNS);
  });

  test("REGRESSION_THRESHOLD_PP is between 1 and 20 inclusive", () => {
    assert.ok(REGRESSION_THRESHOLD_PP >= 1);
    assert.ok(REGRESSION_THRESHOLD_PP <= 20);
  });
});
