// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEfficiency, efficiencyLine, concurrencyOver, idleCause, operatorEvents } from "./efficiency.mjs";
import { evaluateSlo, DEFAULT_SLO } from "./slo.mjs";

const NOW = Date.parse("2026-11-24T12:00:00Z"), MIN = 60000;
const iso = (agoMin) => new Date(NOW - agoMin * MIN).toISOString();
const row = (agoMin, r) => ({ at: iso(agoMin), ...r });
const samples = (n, running, ceiling, ready) => Array.from({ length: n }, (_, i) => ({ t: NOW - (n - i) * MIN, running, ceiling, ready }));

// 11-20..11-24 batches: 3 of 12 lanes busy, one failure signature retried, retries before the merges, operator churn.
export const slowRows = () => [
  ...[1, 2, 3, 4].map((i) => row(300 - i, { issue: 7, outcome: "engine-error", code: "sandbox.capacity", minutes: 30, phases: { setup: { ms: 600000 } } })),
  row(200, { issue: 7, outcome: "merged", minutes: 20, cost_usd: 4 }),
  row(190, { issue: 8, outcome: "ci-failed", minutes: 10 }), row(180, { issue: 8, outcome: "merged", minutes: 10, cost_usd: 2 }),
  row(110, { issue: null, outcome: "added", detail: "9" }), row(105, { issue: 9, outcome: "deferred", code: "run.interrupted", detail: "interrupted: upgrade; requeued" }),
  ...Array.from({ length: 22 }, (_, i) => row(90 - i, { issue: 9, outcome: "recovering", detail: `recovering (ci), attempt ${i}/30` })),
];
// operator actions the daemon reads from the batch files (requeue entries, hold-info, parallel file)
export const slowOperator = () => Array.from({ length: 5 }, (_, i) => ({ at: NOW - (100 - i) * MIN, kind: i % 2 ? "requeue" : "hold" }));
export const healthyRows = () => [row(60, { issue: 1, outcome: "merged", minutes: 20, cost_usd: 2 }), row(30, { issue: 2, outcome: "merged", minutes: 20, cost_usd: 2 })];

describe("#5987 efficiency ledger", () => {
  it("time-weights concurrency over the window", () => {
    const s = [{ t: NOW - 10 * MIN, running: 0, ceiling: 4 }, { t: NOW - 5 * MIN, running: 4, ceiling: 4 }];
    assert.equal(concurrencyOver(s, NOW - 15 * MIN, NOW).ratio, 0.5);
  });

  it("slow batch: low concurrency, repeats, attempts, comments and interventions all breach", () => {
    const eff = computeEfficiency({ rows: slowRows(), operator: slowOperator(), prev: { samples: samples(40, 3, 12, 5) }, now: NOW, batchId: "b1", repo: "o/r" });
    assert.equal(eff.v, 1);
    assert.equal(eff.concurrency.ratio, 0.25);
    assert.ok(eff.concurrency.lowSinceMin >= 30);
    assert.equal(eff.attemptsPerMerged, 3.5);
    assert.equal(eff.interventionsPerDay, 7);
    assert.equal(eff.repeats[0].count, 4);
    assert.ok(eff.wastedLaneHours.laterMerged > 2);
    assert.equal(eff.usdPerMerge, 3);
    assert.equal(eff.limiters[0], "capacity");
    const codes = evaluateSlo(eff, DEFAULT_SLO, { repo: "o/r" }).map((b) => b.code);
    for (const c of ["concurrency", "repeat", "attempts", "interventions", "comments"]) assert.ok(codes.includes(c), `${c} in ${codes}`);
    assert.match(efficiencyLine({ ...eff, concurrency: { ...eff.concurrency, running: 3 }, breaches: [{ issue: 12 }] }), /^efficiency: 3\/12 lanes \(25%\) - limiter capacity.*; 1 SLO breach -> FD#12$/);
  });

  it("healthy batch: no breaches", () => {
    const eff = computeEfficiency({ rows: healthyRows(), prev: { samples: samples(40, 11, 12, 5) }, now: NOW, batchId: "b2", repo: "o/r" });
    assert.deepEqual(evaluateSlo(eff, DEFAULT_SLO, { repo: "o/r" }), []);
    assert.equal(eff.attemptsPerMerged, 1);
  });

  it("malformed rows and no samples never throw", () => {
    const eff = computeEfficiency({ rows: [null, "x", { at: "bad" }, { issue: 1, outcome: "merged", phases: { a: { ms: "q" } } }], now: NOW });
    assert.equal(eff.concurrency.ratio, null);
    assert.equal(efficiencyLine(eff), null);
  });

  it("idleCause reads breaker, lease-held, capacity and base.red from real rows; cleared breaker and old rows give none", () => {
    const r = (o, a = 1) => [row(a, o)];
    assert.equal(idleCause(r({ issue: null, outcome: "breaker", detail: "tripped" }), NOW), "breaker");
    assert.equal(idleCause(r({ issue: null, outcome: "breaker", detail: "circuit breaker cleared" }), NOW), undefined);
    assert.equal(idleCause(r({ issue: 3, outcome: "deferred", detail: "#3 has a live lane in batch b2; retried in 30s" }), NOW), "lease-held");
    assert.equal(idleCause(r({ issue: 3, outcome: "deferred", code: "sandbox.capacity" }), NOW), "capacity");
    assert.equal(idleCause(r({ issue: 3, outcome: "needs-human", code: "base.red" }), NOW), "base.red");
    assert.equal(idleCause(r({ issue: null, outcome: "breaker" }, 60), NOW), undefined);
  });

  it("operatorEvents reads requeue, hold-info and parallel files", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
    const d = mkdtempSync(join(tmpdir(), "opev-"));
    writeFileSync(join(d, "requeue"), JSON.stringify([{ issue: 4, at: iso(5) }, { issue: "x" }]));
    writeFileSync(join(d, "hold-info"), JSON.stringify({ 5: { owner: "operator", since: iso(4) }, 6: { owner: "engine", since: iso(3) } }));
    writeFileSync(join(d, "parallel"), "4\n");
    assert.deepEqual(operatorEvents(d).map((e) => e.kind).sort(), ["hold", "requeue", "set"]);
    assert.deepEqual(operatorEvents(join(d, "none")), []);
  });
});
