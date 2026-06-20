#!/usr/bin/env node
/**
 * scripts/bench-scorecard.mjs — ABC benchmark scorecard aggregator (#878)
 *
 * Deterministic, zero-dependency aggregator for the UI Taste Harness ABC benchmark.
 * Takes a raw "runs" file (per-run blind-pairwise outcomes + 1-5 rubric scores + slop
 * counts for arms A/B/C across 3-5 products) and emits a scorecard: win-rates vs the
 * gold-standard arm C, the A-vs-B harness delta, rubric distributions (mean + stdev),
 * mean slop counts, and a judge-calibration check (C must beat A and B).
 *
 * It does NOT call any model, network, or render anything — it only aggregates the
 * judge output that the /design-bench command produces. See docs/design/abc-benchmark.md.
 *
 * Usage:
 *   node scripts/bench-scorecard.mjs <runs.json>        # read file, print scorecard JSON
 *   node scripts/bench-scorecard.mjs -                  # read runs JSON from stdin
 *   cat runs.json | node scripts/bench-scorecard.mjs    # (no arg) read from stdin
 *
 * Methodology rule (enforced): n=1 is a lie. Any product with fewer than 3 runs is a
 * HARD ERROR — the script exits non-zero rather than emit a misleading point estimate.
 *
 * Exit codes:
 *   0 = scorecard emitted successfully
 *   1 = invalid input (bad JSON, n<3, missing fields, unknown winner token)
 *   2 = aggregation produced a miscalibrated-judge warning (scorecard still emitted to stdout)
 */

const ARMS = ["A", "B", "C"];
const RUBRIC_DIMS = ["hierarchy", "typography", "color", "whitespace", "originality", "mobile"];
const PAIRWISE_KEYS = ["A_vs_C", "B_vs_C", "A_vs_B"];
const VALID_WINNERS = new Set(["A", "B", "C", "tie"]);
const MIN_RUNS = 3;

/** Win-rate of `arm` against `opponent` across an array of pairwise outcome objects.
 *  Ties count as half a win. Comparisons not involving `arm`-vs-`opponent` are ignored. */
export function winRate(runs, arm, opponent) {
  const key = `${arm}_vs_${opponent}`;
  const flipped = `${opponent}_vs_${arm}`;
  let wins = 0;
  let total = 0;
  for (const r of runs) {
    const pw = r.pairwise || {};
    let outcome;
    let flip = false;
    if (Object.prototype.hasOwnProperty.call(pw, key)) {
      outcome = pw[key];
    } else if (Object.prototype.hasOwnProperty.call(pw, flipped)) {
      outcome = pw[flipped];
      flip = true;
    } else {
      continue;
    }
    if (!VALID_WINNERS.has(outcome)) {
      throw new Error(`invalid pairwise winner "${outcome}" for ${flip ? flipped : key}`);
    }
    total += 1;
    if (outcome === "tie") wins += 0.5;
    else if (outcome === arm) wins += 1;
  }
  return total === 0 ? null : wins / total;
}

/** Mean and sample standard deviation of a numeric array. */
export function meanStdev(values) {
  const n = values.length;
  if (n === 0) return { mean: null, stdev: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean: round(mean), stdev: 0 };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean: round(mean), stdev: round(Math.sqrt(variance)) };
}

/** Per-arm, per-dimension rubric distribution across all runs of all products. */
export function rubricStats(products) {
  const out = {};
  for (const arm of ARMS) {
    out[arm] = {};
    for (const dim of RUBRIC_DIMS) {
      const vals = [];
      for (const p of products) {
        for (const r of p.runs) {
          const score = r.rubric?.[arm]?.[dim];
          if (typeof score === "number") vals.push(score);
        }
      }
      out[arm][dim] = meanStdev(vals);
    }
  }
  return out;
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

/** Validate the runs file shape and the n>=3 rule. Throws on any violation. */
export function validate(data) {
  if (!data || typeof data !== "object") throw new Error("runs file must be a JSON object");
  if (!Array.isArray(data.products) || data.products.length === 0) {
    throw new Error("runs file must contain a non-empty `products` array");
  }
  for (const p of data.products) {
    if (!p.product) throw new Error("each product must have a `product` name");
    if (!Array.isArray(p.runs)) throw new Error(`product "${p.product}" must have a runs array`);
    if (p.runs.length < MIN_RUNS) {
      throw new Error(
        `product "${p.product}" has n=${p.runs.length} runs; n=1 is a lie — minimum is ${MIN_RUNS}`,
      );
    }
  }
}

/** Aggregate validated runs data into a scorecard object. */
export function aggregate(data) {
  validate(data);
  const products = data.products;

  // Primary metric: win-rate vs C, per arm, overall and per-product.
  const winVsC = {};
  for (const arm of ["A", "B"]) {
    const perProduct = {};
    const allRuns = [];
    for (const p of products) {
      const wr = winRate(p.runs, arm, "C");
      perProduct[p.product] = wr;
      allRuns.push(...p.runs);
    }
    winVsC[arm] = { mean: winRate(allRuns, arm, "C"), by_product: perProduct };
  }

  // Harness delta: A vs B across all runs.
  const allRuns = products.flatMap((p) => p.runs);
  const aVsB = winRate(allRuns, "A", "B");

  // Slop: mean negatives present per arm (lower is better).
  const slop = {};
  for (const arm of ARMS) {
    const vals = [];
    for (const p of products) {
      for (const r of p.runs) {
        const s = r.slop?.[arm];
        if (typeof s === "number") vals.push(s);
      }
    }
    slop[arm] = vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }

  // Judge calibration: C must win A_vs_C and B_vs_C. Any run where C loses is miscalibrated.
  const miscalibrated = [];
  for (const p of products) {
    p.runs.forEach((r, i) => {
      const pw = r.pairwise || {};
      for (const key of ["A_vs_C", "B_vs_C"]) {
        if (Object.prototype.hasOwnProperty.call(pw, key) && pw[key] !== "C" && pw[key] !== "tie") {
          miscalibrated.push({ product: p.product, run: r.run ?? i + 1, comparison: key, winner: pw[key] });
        }
      }
    });
  }

  const nRunsCounts = products.map((p) => p.runs.length);
  const minRuns = Math.min(...nRunsCounts);
  const maxRuns = Math.max(...nRunsCounts);

  return {
    corpus_version: data.corpus_version ?? null,
    generation_model: data.generation_model ?? null,
    judge_model: data.judge_model ?? null,
    n_products: products.length,
    n_runs_per_product: minRuns === maxRuns ? minRuns : { min: minRuns, max: maxRuns },
    win_rate_vs_C: {
      A: { mean: round0(winVsC.A.mean), by_product: roundMap(winVsC.A.by_product) },
      B: { mean: round0(winVsC.B.mean), by_product: roundMap(winVsC.B.by_product) },
    },
    a_vs_b_win_rate: round0(aVsB),
    rubric: rubricStats(products),
    slop,
    judge_calibration: {
      miscalibrated_runs: miscalibrated,
      ok: miscalibrated.length === 0,
    },
  };
}

function round0(x) {
  return x === null ? null : round(x);
}
function roundMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = round0(v);
  return out;
}

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
  let scorecard;
  try {
    scorecard = aggregate(data);
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(scorecard, null, 2) + "\n");
  if (!scorecard.judge_calibration.ok) {
    process.stderr.write(
      `WARNING: judge miscalibrated — C lost in ${scorecard.judge_calibration.miscalibrated_runs.length} comparison(s). ` +
        `A real reference page should not lose to a generated arm; treat affected runs as suspect.\n`,
    );
    process.exit(2);
  }
}

// Run as CLI only when invoked directly, not when imported by tests.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
