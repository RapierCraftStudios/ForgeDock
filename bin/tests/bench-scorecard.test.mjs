import { test } from "node:test";
import assert from "node:assert/strict";
import {
  winRate,
  meanStdev,
  rubricStats,
  validate,
  aggregate,
} from "../../scripts/bench-scorecard.mjs";

function rubricFor(scores) {
  // scores: [hierarchy, typography, color, whitespace, originality, mobile]
  const dims = ["hierarchy", "typography", "color", "whitespace", "originality", "mobile"];
  return Object.fromEntries(dims.map((d, i) => [d, scores[i]]));
}

function sampleRuns() {
  // C beats A and B every run; A beats B 2 of 3.
  return [
    { run: 1, pairwise: { A_vs_C: "C", B_vs_C: "C", A_vs_B: "A" }, slop: { A: 1, B: 4, C: 0 } },
    { run: 2, pairwise: { A_vs_C: "C", B_vs_C: "C", A_vs_B: "B" }, slop: { A: 2, B: 3, C: 0 } },
    { run: 3, pairwise: { A_vs_C: "C", B_vs_C: "C", A_vs_B: "A" }, slop: { A: 1, B: 5, C: 1 } },
  ];
}

test("winRate: A vs B counts wins and ignores other pairings", () => {
  assert.equal(winRate(sampleRuns(), "A", "B"), 2 / 3);
  assert.equal(winRate(sampleRuns(), "B", "A"), 1 / 3);
});

test("winRate: A loses every comparison to C", () => {
  assert.equal(winRate(sampleRuns(), "A", "C"), 0);
  assert.equal(winRate(sampleRuns(), "C", "A"), 1);
});

test("winRate: ties count as half a win", () => {
  const runs = [
    { pairwise: { A_vs_B: "tie" } },
    { pairwise: { A_vs_B: "A" } },
  ];
  assert.equal(winRate(runs, "A", "B"), 0.75);
});

test("winRate: returns null when no relevant comparisons exist", () => {
  assert.equal(winRate([{ pairwise: { A_vs_C: "C" } }], "A", "B"), null);
});

test("winRate: throws on an unknown winner token", () => {
  assert.throws(() => winRate([{ pairwise: { A_vs_B: "Z" } }], "A", "B"), /invalid pairwise winner/);
});

test("meanStdev: computes mean and sample stdev", () => {
  const { mean, stdev } = meanStdev([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5);
  assert.ok(Math.abs(stdev - 2.138) < 0.01);
});

test("meanStdev: single value has zero stdev", () => {
  assert.deepEqual(meanStdev([3]), { mean: 3, stdev: 0 });
});

test("validate: rejects n<3 (n=1 is a lie)", () => {
  assert.throws(
    () => validate({ products: [{ product: "Voltage", runs: [{ run: 1 }, { run: 2 }] }] }),
    /n=2 runs.*minimum is 3/,
  );
});

test("validate: rejects empty products array", () => {
  assert.throws(() => validate({ products: [] }), /non-empty `products`/);
});

test("validate: accepts n>=3", () => {
  assert.doesNotThrow(() => validate({ products: [{ product: "V", runs: sampleRuns() }] }));
});

test("rubricStats: aggregates per-arm per-dimension across runs", () => {
  const products = [
    {
      product: "V",
      runs: [
        { rubric: { A: rubricFor([4, 4, 4, 4, 4, 4]), B: rubricFor([2, 2, 2, 2, 2, 2]), C: rubricFor([5, 5, 5, 5, 5, 5]) } },
        { rubric: { A: rubricFor([2, 2, 2, 2, 2, 2]), B: rubricFor([2, 2, 2, 2, 2, 2]), C: rubricFor([5, 5, 5, 5, 5, 5]) } },
        { rubric: { A: rubricFor([3, 3, 3, 3, 3, 3]), B: rubricFor([2, 2, 2, 2, 2, 2]), C: rubricFor([5, 5, 5, 5, 5, 5]) } },
      ],
    },
  ];
  const stats = rubricStats(products);
  assert.equal(stats.A.hierarchy.mean, 3); // (4+2+3)/3
  assert.equal(stats.C.typography.mean, 5);
  assert.equal(stats.B.color.stdev, 0);
});

test("aggregate: produces win-rates, harness delta, slop, and calibration ok", () => {
  const data = {
    corpus_version: "2026.2",
    generation_model: "model-x",
    judge_model: "judge-y",
    products: [{ product: "Voltage", reference: "modal.com", runs: sampleRuns() }],
  };
  const sc = aggregate(data);
  assert.equal(sc.n_products, 1);
  assert.equal(sc.n_runs_per_product, 3);
  assert.equal(sc.win_rate_vs_C.A.mean, 0); // A never beats C
  assert.equal(sc.win_rate_vs_C.A.by_product.Voltage, 0);
  assert.equal(sc.a_vs_b_win_rate, 2 / 3 === 0.667 ? 0.667 : Math.round((2 / 3) * 1000) / 1000);
  assert.equal(sc.slop.A, Math.round(((1 + 2 + 1) / 3) * 1000) / 1000);
  assert.equal(sc.slop.C, Math.round(((0 + 0 + 1) / 3) * 1000) / 1000);
  assert.equal(sc.judge_calibration.ok, true);
  assert.deepEqual(sc.judge_calibration.miscalibrated_runs, []);
});

test("aggregate: flags miscalibration when C loses to A or B", () => {
  const data = {
    products: [
      {
        product: "Plume",
        runs: [
          { run: 1, pairwise: { A_vs_C: "A", B_vs_C: "C", A_vs_B: "A" } }, // C lost to A
          { run: 2, pairwise: { A_vs_C: "C", B_vs_C: "C", A_vs_B: "A" } },
          { run: 3, pairwise: { A_vs_C: "C", B_vs_C: "B", A_vs_B: "B" } }, // C lost to B
        ],
      },
    ],
  };
  const sc = aggregate(data);
  assert.equal(sc.judge_calibration.ok, false);
  assert.equal(sc.judge_calibration.miscalibrated_runs.length, 2);
});

test("aggregate: reports run spread when products differ in n", () => {
  const data = {
    products: [
      { product: "A1", runs: sampleRuns() },
      { product: "B1", runs: [...sampleRuns(), { run: 4, pairwise: { A_vs_C: "C", B_vs_C: "C", A_vs_B: "A" } }] },
    ],
  };
  const sc = aggregate(data);
  assert.deepEqual(sc.n_runs_per_product, { min: 3, max: 4 });
});
