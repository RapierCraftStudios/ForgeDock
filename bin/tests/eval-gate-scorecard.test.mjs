/**
 * bin/tests/eval-gate-scorecard.test.mjs
 *
 * Unit tests for scripts/eval-gate-scorecard.mjs — the pipeline eval CI
 * regression gate comparator (issue #1286, fix for #1518).
 *
 * Verifies the fresh-vs-baseline success-rate comparison, the regression
 * threshold boundary, the small-subset rate-assertion carve-out, and required
 * field validation described in docs/design/eval-gate-runbook.md.
 *
 * All tests are pure-function; no network, no live SDK calls, no fs writes
 * (the --seed CLI mode's file-write side effect is intentionally not exercised
 * here to avoid mutating the committed baseline — its validation path is
 * covered via validateScorecard()).
 *
 * Run with: node --test bin/tests/eval-gate-scorecard.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_FIELDS,
  RATE_THRESHOLD_PP,
  MIN_ISSUES_FOR_RATE_ASSERTION,
  validateScorecard,
  evaluateGate,
} from "../../scripts/eval-gate-scorecard.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal valid fresh scorecard (matches eval-scorecard-aggregator.mjs output). */
function makeScorecard(overrides = {}) {
  return {
    schema_version: "1",
    run_id: "run-fresh-001",
    generated_at: "2026-07-05T00:00:00.000Z",
    corpus_size: 20,
    issues_run: 20,
    successful_runs: 16,
    failed_runs: 4,
    success_rate_pct: 80,
    run_mode: "full",
    ...overrides,
  };
}

/** Build a minimal valid baseline scorecard. */
function makeBaseline(overrides = {}) {
  return {
    schema_version: "1",
    run_id: "seed-placeholder",
    success_rate_pct: 80,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("REQUIRED_FIELDS is a non-empty array including success_rate_pct and run_mode", () => {
    assert.ok(Array.isArray(REQUIRED_FIELDS) && REQUIRED_FIELDS.length > 0);
    assert.ok(REQUIRED_FIELDS.includes("success_rate_pct"));
    assert.ok(REQUIRED_FIELDS.includes("run_mode"));
    assert.ok(REQUIRED_FIELDS.includes("issues_run"));
  });

  it("RATE_THRESHOLD_PP is 5 (per docs/design/eval-gate-runbook.md)", () => {
    assert.equal(RATE_THRESHOLD_PP, 5);
  });

  it("MIN_ISSUES_FOR_RATE_ASSERTION is 8 (per docs/design/eval-gate-runbook.md subset carve-out)", () => {
    assert.equal(MIN_ISSUES_FOR_RATE_ASSERTION, 8);
  });
});

// ---------------------------------------------------------------------------
// validateScorecard
// ---------------------------------------------------------------------------

describe("validateScorecard", () => {
  it("passes for a well-formed fresh scorecard", () => {
    assert.doesNotThrow(() => validateScorecard(makeScorecard()));
  });

  it("passes for a minimal baseline requiring only success_rate_pct", () => {
    assert.doesNotThrow(() =>
      validateScorecard({ success_rate_pct: 80 }, { requiredFields: ["success_rate_pct"], label: "baseline" }),
    );
  });

  it("throws when input is not an object", () => {
    assert.throws(() => validateScorecard(null), /must be a JSON object/);
    assert.throws(() => validateScorecard("nope"), /must be a JSON object/);
    assert.throws(() => validateScorecard([1, 2, 3]), /must be a JSON object/);
  });

  it("throws when a required field is missing", () => {
    const sc = makeScorecard();
    delete sc.run_mode;
    assert.throws(() => validateScorecard(sc), /missing required field: "run_mode"/);
  });

  it("throws when success_rate_pct is not a finite number", () => {
    assert.throws(
      () => validateScorecard(makeScorecard({ success_rate_pct: "80" })),
      /success_rate_pct must be a finite number/,
    );
    assert.throws(
      () => validateScorecard(makeScorecard({ success_rate_pct: NaN })),
      /success_rate_pct must be a finite number/,
    );
  });

  it("includes the provided label in error messages", () => {
    const sc = makeScorecard();
    delete sc.schema_version;
    assert.throws(() => validateScorecard(sc, { label: "fresh scorecard" }), /fresh scorecard missing required field/);
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — threshold boundary
// ---------------------------------------------------------------------------

describe("evaluateGate — threshold boundary", () => {
  it("PASSes when the drop is exactly 5pp (runbook worked example: 75% fresh vs 80% baseline)", () => {
    const result = evaluateGate(makeScorecard({ success_rate_pct: 75 }), makeBaseline({ success_rate_pct: 80 }));
    assert.equal(result.pass, true);
    assert.equal(result.drop_pp, 5);
  });

  it("FAILs when the drop is 6pp (runbook worked example: 74% fresh vs 80% baseline)", () => {
    const result = evaluateGate(makeScorecard({ success_rate_pct: 74 }), makeBaseline({ success_rate_pct: 80 }));
    assert.equal(result.pass, false);
    assert.equal(result.drop_pp, 6);
    assert.match(result.reason, /^REGRESSION:/);
  });

  it("PASSes when the fresh rate matches the baseline exactly (0pp delta)", () => {
    const result = evaluateGate(makeScorecard({ success_rate_pct: 80 }), makeBaseline({ success_rate_pct: 80 }));
    assert.equal(result.pass, true);
    assert.equal(result.drop_pp, 0);
  });

  it("PASSes on an improvement (negative drop_pp)", () => {
    const result = evaluateGate(makeScorecard({ success_rate_pct: 90 }), makeBaseline({ success_rate_pct: 80 }));
    assert.equal(result.pass, true);
    assert.equal(result.drop_pp, -10);
  });

  it("respects a custom thresholdPp override", () => {
    const result = evaluateGate(makeScorecard({ success_rate_pct: 78 }), makeBaseline({ success_rate_pct: 80 }), {
      thresholdPp: 1,
    });
    assert.equal(result.pass, false);
    assert.equal(result.drop_pp, 2);
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — subset rate-assertion carve-out
// ---------------------------------------------------------------------------

describe("evaluateGate — subset carve-out", () => {
  it("skips the rate assertion (and passes) when fresh.issues_run < 8, even on a big drop", () => {
    const result = evaluateGate(
      makeScorecard({ issues_run: 5, success_rate_pct: 20, run_mode: "subset" }),
      makeBaseline({ success_rate_pct: 80 }),
    );
    assert.equal(result.pass, true);
    assert.equal(result.rate_assertion_skipped, true);
    assert.match(result.reason, /rate assertion skipped/);
  });

  it("does NOT skip the assertion when fresh.issues_run is exactly 8 (boundary)", () => {
    const result = evaluateGate(
      makeScorecard({ issues_run: 8, success_rate_pct: 20, run_mode: "subset" }),
      makeBaseline({ success_rate_pct: 80 }),
    );
    assert.equal(result.rate_assertion_skipped, false);
    assert.equal(result.pass, false);
  });

  it("applies the assertion normally when fresh.issues_run >= 8", () => {
    const result = evaluateGate(
      makeScorecard({ issues_run: 20, success_rate_pct: 74 }),
      makeBaseline({ success_rate_pct: 80 }),
    );
    assert.equal(result.rate_assertion_skipped, false);
    assert.equal(result.pass, false);
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — validation passthrough
// ---------------------------------------------------------------------------

describe("evaluateGate — validation", () => {
  it("throws when the fresh scorecard is missing a required field", () => {
    const fresh = makeScorecard();
    delete fresh.successful_runs;
    assert.throws(() => evaluateGate(fresh, makeBaseline()), /fresh scorecard missing required field/);
  });

  it("throws when the baseline is missing success_rate_pct", () => {
    const baseline = { schema_version: "1" };
    assert.throws(() => evaluateGate(makeScorecard(), baseline), /baseline missing required field/);
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — output schema
// ---------------------------------------------------------------------------

describe("evaluateGate — output schema", () => {
  it("emits all fields documented in docs/design/eval-gate-runbook.md", () => {
    const result = evaluateGate(makeScorecard(), makeBaseline());
    const expectedKeys = [
      "pass",
      "fresh_success_rate_pct",
      "baseline_success_rate_pct",
      "drop_pp",
      "threshold_pp",
      "rate_assertion_skipped",
      "fresh_issues_run",
      "fresh_run_mode",
      "fresh_run_id",
      "baseline_run_id",
      "reason",
    ];
    for (const key of expectedKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), `missing key: ${key}`);
    }
  });

  it("passes through fresh_run_id and baseline_run_id", () => {
    const result = evaluateGate(
      makeScorecard({ run_id: "fresh-42" }),
      makeBaseline({ run_id: "baseline-7" }),
    );
    assert.equal(result.fresh_run_id, "fresh-42");
    assert.equal(result.baseline_run_id, "baseline-7");
  });

  it("defaults fresh_run_id and baseline_run_id to null when absent", () => {
    const fresh = makeScorecard();
    delete fresh.run_id;
    const baseline = makeBaseline();
    delete baseline.run_id;
    const result = evaluateGate(fresh, baseline);
    assert.equal(result.fresh_run_id, null);
    assert.equal(result.baseline_run_id, null);
  });

  it("threshold_pp reflects the default RATE_THRESHOLD_PP", () => {
    const result = evaluateGate(makeScorecard(), makeBaseline());
    assert.equal(result.threshold_pp, RATE_THRESHOLD_PP);
  });
});
