// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { phasesOf } from "./orchestrate.mjs";
import { aggregate } from "../stats/aggregate.mjs";
import { PHASES, createLedger, laneSum, withinWall, flattenPhases, unflattenPhases, summarizePhases, formatPhaseSummary } from "./phaseledger.mjs";

const clock = () => { let t = 1000; const f = () => t; f.tick = (ms) => { t += ms; }; return f; };

describe("phase ledger (#4908)", () => {
  it("lane phases sum to within 5% of wall and only reached phases appear", async () => {
    const now = clock(), t0 = now(), L = createLedger(now);
    now.tick(2000); L.enter("deps_install");
    now.tick(70000); L.enter("plan");
    now.tick(60000); L.enter("implement");
    now.tick(120000);
    await L.during("validate", async () => { now.tick(30000); });
    now.tick(10000); L.enter("ci_wait"); now.tick(5000); L.enter("merge"); now.tick(1000);
    L.addModel("implement", 100000, 1.5);
    const p = L.snapshot(), wall = now() - t0;
    assert.deepEqual(Object.keys(p), ["sandbox_start", "deps_install", "validate", "plan", "implement", "ci_wait", "merge"]);
    assert.equal(p.implement.ms, 130000);
    assert.deepEqual([p.implement.model_ms, p.implement.usd], [100000, 1.5]);
    assert.ok(withinWall(p, wall));
    assert.equal(laneSum(p), wall);
    assert.ok(!withinWall({ plan: { ms: 1000 } }, 100000));
  });

  it("queue_wait is outside the lane sum; unknown phases are ignored", () => {
    const now = clock(), L = createLedger(now);
    L.enter("nope"); now.tick(500);
    const p = { ...L.snapshot(), queue_wait: { ms: 99999 } };
    assert.equal(laneSum(p), 500);
  });

  it("flatten/unflatten round trip for FORGE:TELEMETRY scalars", () => {
    const p = { plan: { ms: 5, model_ms: 3, usd: 0.25 }, merge: { ms: 7 } };
    const flat = flattenPhases(p);
    assert.deepEqual(flat, { phase_plan_ms: 5, phase_plan_model_ms: 3, phase_plan_usd: 0.25, phase_merge_ms: 7 });
    assert.deepEqual(unflattenPhases(flat), p);
  });

  it("summary gives p50/p90 per phase and the largest phase; n/a without ledger data", () => {
    const rows = [{ phases: { plan: { ms: 60000 }, implement: { ms: 300000 } } }, { phases: { plan: { ms: 120000 }, implement: { ms: 900000 } } }, { issue: 3 }, { phases: {} }];
    const s = summarizePhases(rows.map((r) => r.phases));
    assert.equal(s.n, 2);
    assert.equal(s.phases.plan.p50, 90000);
    assert.equal(s.phases.implement.p90, 900000);
    assert.equal(s.largest.phase, "implement");
    const line = formatPhaseSummary(rows);
    assert.match(line, /implement 10\.0m\/15\.0m/);
    assert.match(line, /largest: implement/);
    assert.equal(formatPhaseSummary([{ issue: 1 }]), "phases (wall time): n/a");
    assert.equal(formatPhaseSummary(null), "phases (wall time): n/a");
    assert.equal(PHASES.length, 11);
  });

  it("the batch row adds queue_wait to the lane ledger and stays null without one (#4908)", () => {
    const lane = { plan: { ms: 10 }, merge: { ms: 5 } };
    assert.deepEqual(phasesOf({ phases: lane }, { queueMs: 300 }), { queue_wait: { ms: 300 }, ...lane });
    assert.deepEqual(phasesOf({ phases: lane }, {}), lane);
    assert.equal(phasesOf({ wall_ms: 5 }, { queueMs: 1 }), null);
  });

  it("forgedock stats aggregates the ledger and tolerates runs without one", () => {
    const run = (ledger) => ({ source: "local", repo: "o/r", version: "1.0.0", issue: 1, run: "r", finished: true, reason: "merged", code: null, remediated: false, usageEvents: 1, startTs: null, endTs: null, wallMs: 100, phases: {}, builderAttempts: [], ledger });
    const t = aggregate({ runs: [run({ plan: { ms: 40 }, implement: { ms: 60 } }), run({}), run(undefined)] }).groups?.[0]?.time;
    assert.equal(t?.ledger.n, 1);
    assert.equal(t.ledger.largest.phase, "implement");
  });
});
