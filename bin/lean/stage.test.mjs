// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStageReporter, latestStage, mergeStage, laneStageLine, laneStageLines, fixReason, renderStage } from "./stage.mjs";
import { createLedger } from "./phaseledger.mjs";

const clock = (t = 1_000_000) => { const c = { t, now: () => c.t, tick: (ms) => { c.t += ms; } }; return c; };
const timers = () => { const q = []; return { q, set: (fn, ms) => { const x = { fn, ms }; q.push(x); return x; }, clear: (x) => { const i = q.indexOf(x); if (i >= 0) q.splice(i, 1); } }; };

describe("#6245 stage reporter", () => {
  it("writes the first transition at once and throttles the rest to one edit per 60 s (trailing)", async () => {
    const c = clock(), tm = timers(), writes = [], events = [];
    const r = createStageReporter({ now: c.now, write: (t) => writes.push(t), emit: (e) => events.push(e), setTimer: tm.set, clearTimer: tm.clear });
    const ledger = createLedger(c.now, "sandbox_start", c.t, (p) => r.enter(p));
    ledger.enter("plan"); await null;
    assert.equal(writes.length, 1);
    c.tick(5000); ledger.enter("implement");
    c.tick(5000); ledger.enter("precheck");
    assert.equal(writes.length, 1, "no second edit inside the window");
    assert.equal(tm.q.length, 1); assert.ok(tm.q[0].ms > 0 && tm.q[0].ms <= 60000);
    c.tick(60000); await tm.q[0].fn();
    assert.equal(writes.length, 2);
    assert.match(writes[1], /\*\*stage:\*\* precheck - started .*last activity /);
    assert.deepEqual(events.map((e) => e.stage), ["plan", "implement", "precheck"]);
  });
  it("names a fix round with its reason and counts rounds", async () => {
    const c = clock(), writes = [], events = [];
    const r = createStageReporter({ now: c.now, write: (t) => writes.push(t), emit: (e) => events.push(e), minMs: 0 });
    const ledger = createLedger(c.now, "sandbox_start", c.t, (p) => r.enter(p));
    ledger.enter("implement");
    for (let i = 0; i < 3; i++) { r.note(fixReason("conformance", [{ code: "conformance.unimplemented", id: "R3" }])); await ledger.during("fix", async () => { c.tick(1000); }); }
    const fixes = events.filter((e) => e.stage === "fix");
    assert.deepEqual(fixes.map((e) => e.round), [1, 2, 3]);
    assert.equal(fixes[0].reason, "conformance.unimplemented R3");
    assert.match(writes.find((w) => /fix round 1/.test(w)), /fix round 1 \(conformance.unimplemented R3\)/);
  });
  it("ignores ledger phases that are not stages and never throws from write", async () => {
    const c = clock(), events = [];
    const r = createStageReporter({ now: c.now, write: () => { throw new Error("gh down"); }, emit: (e) => events.push(e) });
    r.enter("deps_install"); r.enter("plan"); await r.flush();
    assert.deepEqual(events.map((e) => e.stage), ["plan"]);
  });
  it("a touch refreshes last activity only at the heartbeat interval", () => {
    const c = clock(), writes = [], tm = timers();
    const r = createStageReporter({ now: c.now, write: (t) => writes.push(t), setTimer: tm.set, clearTimer: tm.clear, heartbeatMs: 300000 });
    r.enter("implement");
    c.tick(120000); r.touch(); assert.equal(tm.q.length, 0);
    c.tick(200000); r.touch(); assert.equal(writes.length, 2, "heartbeat edit once past 5 min");
  });
});

describe("#6245 dispatcher side", () => {
  const log = [
    { seq: 1, ts: "2026-11-28T10:00:00.000Z", event: "LANE_SETUP_TIMING", step: "cli_init", ms: 5 },
    { seq: 2, ts: "2026-11-28T10:01:00.000Z", event: "LANE_STAGE", stage: "plan" },
    { seq: 3, ts: "2026-11-28T10:05:00.000Z", event: "LANE_STAGE", stage: "fix", round: 2, reason: "conformance.unimplemented R3" },
    { seq: 4, ts: "2026-11-28T10:06:00.000Z", event: "PHASE_ATTEMPT_USAGE", phase: "build" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n";
  it("latestStage reads the newest LANE_STAGE and the newest event time", () => {
    const s = latestStage(log);
    assert.equal(s.stage, "fix"); assert.equal(s.round, 2); assert.equal(s.reason, "conformance.unimplemented R3");
    assert.equal(s.since, Date.parse("2026-11-28T10:05:00.000Z")); assert.equal(s.lastEventAt, Date.parse("2026-11-28T10:06:00.000Z"));
    assert.equal(latestStage(""), null);
  });
  it("mergeStage keeps the old stage when the log shows none and takes the newest activity", () => {
    const prev = { stage: "plan", round: null, reason: null, since: 1, lastEventAt: 100 };
    assert.deepEqual(mergeStage(prev, { stage: null, lastEventAt: 50 }, 200), { stage: "plan", round: null, reason: null, since: 1, lastEventAt: 200 });
  });
  it("prints `#N <sub-phase> for Xm (last activity Ys ago)` and flags quiet only in a model phase", () => {
    const now = Date.parse("2026-11-28T10:30:00.000Z");
    const busy = { stage: { stage: "implement", since: now - 12 * 60000, lastEventAt: now - 40000 } };
    assert.equal(laneStageLine(7, busy, { now }), "#7 implement for 12m (last activity 40s ago)");
    const silent = { stage: { stage: "implement", since: now - 30 * 60000, lastEventAt: now - 16 * 60000 } };
    assert.match(laneStageLine(8, silent, { now }), /^#8 implement for 30m \(last activity 16m ago\) quiet$/);
    const ci = { stage: { stage: "ci_wait", since: now - 30 * 60000, lastEventAt: now - 20 * 60000 } };
    assert.doesNotMatch(laneStageLine(9, ci, { now }), /quiet/);
    assert.match(laneStageLine(8, silent, { now, quietMin: 20 }), /^(?!.*quiet)/);
    assert.equal(laneStageLine(1, {}, { now }), null);
    assert.deepEqual(laneStageLines({ running: { 7: busy, 2: {} } }, { now }), ["#7 implement for 12m (last activity 40s ago)"]);
  });
  it("renderStage carries start and last-activity times", () => {
    assert.match(renderStage({ stage: "review", since: 0, last: 60000 }), /review - started 1970-01-01T00:00:00.000Z, last activity 1970-01-01T00:01:00.000Z/);
  });
});
