// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { join } from "node:path";
import { phasesOf } from "./orchestrate.mjs";
import { aggregate } from "../stats/aggregate.mjs";
import { LANE_PHASES, createLedger, laneSum, withinWall, flattenPhases, unflattenPhases, summarizePhases, formatLedgerSummary, WAIT_CAUSES, summarizeWaits, comparePhases, formatPhaseComparison, readBaselineRows } from "./phaseledger.mjs";

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
    const line = formatLedgerSummary(rows);
    assert.match(line, /implement 10\.0m\/15\.0m/);
    assert.match(line, /largest: implement/);
    assert.equal(formatLedgerSummary([{ issue: 1 }]), "phases (wall time): n/a");
    assert.equal(formatLedgerSummary(null), "phases (wall time): n/a");
    assert.equal(LANE_PHASES.length, 13);
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

  it("attributes non-model time to named causes that close to the phase wall (#5349)", () => {
    const now = clock(), L = createLedger(now);
    L.enter("plan"); now.tick(100000);
    L.addModel("plan", 30000, 0.1);
    L.addWait("plan", "heavy_queue", 20000); L.addWait("plan", "rate_limit", 10000); L.addWait("plan", "bogus", 5); L.addWait("nope", "host_load", 1000);
    L.enter("implement"); now.tick(50000);
    const p = L.snapshot();
    assert.deepEqual(p.plan.wait, { heavy_queue: 20000, rate_limit: 10000, host_load: 1000, command: 39000 });
    assert.equal(p.plan.model_ms + Object.values(p.plan.wait).reduce((a, b) => a + b, 0), p.plan.ms);
    assert.deepEqual(p.implement.wait, { command: 50000 });
    assert.equal(createLedger(clock()).snapshot().plan, undefined);
    const first = createLedger(now); now.tick(7000);
    assert.deepEqual(first.snapshot().sandbox_start.wait, { sandbox: 7000 });
    assert.ok(WAIT_CAUSES.includes("host_load"));
  });

  it("wait round-trips through the flattened telemetry keys and aggregates by cause; old rows stay n/a (#5349)", () => {
    const p = { plan: { ms: 10, model_ms: 4, wait: { heavy_queue: 3, command: 3 } }, merge: { ms: 7 } };
    const flat = flattenPhases(p);
    assert.equal(flat.phase_plan_wait_heavy_queue_ms, 3);
    assert.deepEqual(unflattenPhases(flat), p);
    const s = summarizeWaits([p, { plan: { ms: 5 } }, null]);
    assert.equal(s.n, 1);
    assert.deepEqual(s.total, { ms: 17, model_ms: 4, wait: { heavy_queue: 3, command: 3 } });
    assert.equal(summarizeWaits([{ plan: { ms: 5 } }]).n, 0);
    const q = summarizeWaits([1, 2, 3, 4].map((n) => ({ plan: { ms: 10 * n, wait: { heavy_queue: n * 1000 } } })));
    assert.deepEqual(q.phases.plan.pct.heavy_queue, { p50: 2500, p90: 4000 });
  });
});

describe("phase comparison vs previous 7 days (#5649)", () => {
  const row = (phases, minutes, outcome = "merged", issue = 1) => ({ issue, outcome, minutes, phases });
  const M = 60000;

  it("contract and fix are ledger phases that keep the lane sum, rows without them still summarise", async () => {
    const now = clock(), t0 = now(), L = createLedger(now);
    now.tick(1000); L.enter("plan"); now.tick(2000);
    await L.during("contract", async () => { now.tick(3000); });
    now.tick(4000); L.enter("review"); now.tick(5000);
    await L.during("fix", async () => { now.tick(6000); });
    now.tick(7000); L.enter("merge"); now.tick(1000);
    const p = L.snapshot();
    assert.deepEqual(Object.keys(p), ["sandbox_start", "plan", "contract", "review", "fix", "merge"]);
    assert.equal(p.contract.ms, 3000); assert.equal(p.fix.ms, 6000);
    assert.ok(withinWall(p, now() - t0));
    assert.equal(unflattenPhases(flattenPhases(p)).fix.ms, 6000);
    const s = summarizePhases([p, { plan: { ms: 10 } }]);
    assert.equal(s.n, 2); assert.equal(s.phases.plan.n, 2); assert.equal(s.phases.fix.n, 1);
  });

  it("summarizePhases carries p75", () => {
    const s = summarizePhases([1, 2, 3, 4].map((x) => ({ plan: { ms: x * 1000 } })));
    assert.equal(s.phases.plan.p75, 3000);
  });

  it("comparePhases: no prior batches, rows without ledgers, one-sided phases", () => {
    const cur = [row({ plan: { ms: 4 * M }, fix: { ms: M } }, 20), row(undefined, 30, "merged", 2)];
    const none = comparePhases(cur, null);
    assert.equal(none.baseline, false);
    assert.equal(none.phases.plan.prev, null); assert.equal(none.phases.plan.delta, null);
    assert.deepEqual([none.wall.cur.median, none.wall.cur.p75], [25 * M, 30 * M]);
    const c = comparePhases(cur, [row({ plan: { ms: 2 * M }, merge: { ms: M } }, 10), row({}, 0, "failed")]);
    assert.equal(c.baseline, true);
    assert.equal(c.phases.plan.delta, 1);
    assert.equal(c.phases.fix.prev, null); assert.equal(c.phases.merge.cur, null);
    assert.equal(c.wall.prev.median, 10 * M);
    assert.doesNotThrow(() => comparePhases(undefined, undefined));
  });

  it("formatPhaseComparison prints the line form, marks >25% growth and the lane wall", () => {
    const out = formatPhaseComparison([row({ plan: { ms: 3 * M }, merge: { ms: M } }, 20)], [row({ plan: { ms: 2 * M }, merge: { ms: M } }, 10)]);
    assert.equal(out[0], "plan median 3.0m (prev7d 2.0m) p75 3.0m (prev7d 2.0m) ! median +50%");
    assert.equal(out[1], "merge median 1.0m (prev7d 1.0m) p75 1.0m (prev7d 1.0m)");
    assert.equal(out[2], "lane wall (merged) median 20.0m (prev7d 10.0m) p75 20.0m (prev7d 10.0m) ! median +100%");
    assert.match(formatPhaseComparison([row({ plan: { ms: M } }, 5)], null)[0], /^plan median 1\.0m \(prev7d n\/a\)/);
    assert.deepEqual(formatPhaseComparison([], []), ["phases vs prev7d: n/a"]);
  });

  it("readBaselineRows reads recent batches except the current one, last row per issue; null when unreadable", () => {
    const root = tmpDir("bl-"), now = Date.now();
    const mk = (id, rows, ageDays) => {
      mkdirSync(join(root, id)); const f = join(root, id, "log.jsonl");
      writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
      const t = (now - ageDays * 86400000) / 1000; utimesSync(f, t, t);
    };
    mk("a", [{ issue: 1, minutes: 1 }, { issue: 1, minutes: 2 }, { issue: 2, minutes: 3 }], 1);
    mk("old", [{ issue: 9, minutes: 9 }], 10);
    mk("cur", [{ issue: 5, minutes: 5 }], 0);
    mkdirSync(join(root, "nolog"));
    const rows = readBaselineRows({ root, excludeId: "cur", now });
    assert.deepEqual(rows.map((r) => r.minutes).sort(), [2, 3]);
    assert.equal(readBaselineRows({ root: join(root, "missing"), now }), null);
  });
});
