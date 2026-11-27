// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";
import { tmpDir } from "../tests/_tmp.mjs";
import { openBatch } from "./batch.mjs";
import { utimesSync } from "node:fs";
import { evaluateDispatchStall } from "./batch-health.mjs";
import { makeCapacitySampler } from "./capsample.mjs";

// #5746: remote mode with host_fallback false never places a lane on the orchestrator host, whichever branch picks "local"
const runRemote = async (place, extra = {}) => {
  const seen = [], saves = [];
  await orchestrate({ issues: [5], parallel: 2, readBody: async () => "", pollMs: 5,
    store: { load: () => null, save: (s) => saves.push(JSON.parse(JSON.stringify(s))), log: () => {} },
    remote: { mode: "remote", max: 2, isRemote: () => true, hostFallback: false, place, admit: () => ({ ok: true }), onBudget: "stop", costPerMinute: 0 },
    runOne: async (_n, _l, ctx = {}) => { seen.push({ where: ctx.placement?.where, remote: ctx.remote }); return { terminalReason: "merged", pr: 1 }; }, ...extra });
  return { seen, saves };
};

describe("#5746 remote mode keeps lanes off the host", () => {
  it("a host-capability placement (placeLane `needs`) is placed remotely and recorded", async () => {
    const { seen, saves } = await runRemote(() => ({ where: "local", reason: "host capability: prod-monitor" }));
    assert.deepEqual(seen, [{ where: "remote", remote: true }]);
    const running = saves.flatMap((s) => Object.values(s.running ?? {}));
    assert.ok(running.length > 0 && running.every((r) => r.placement?.where === "remote" && r.remote === true), JSON.stringify(running));
  });
  it("a throwing placement never falls to the host", async () => {
    const { seen } = await runRemote(() => { throw new Error("probe"); });
    assert.deepEqual(seen.map((s) => s.where), ["remote"]);
  });
  it("host_fallback true keeps the host placement (hybrid-style config)", async () => {
    const { seen } = await runRemote(() => ({ where: "local", reason: "host capability: x" }), { remote: { mode: "remote", max: 2, isRemote: () => true, hostFallback: true, place: () => ({ where: "local", reason: "host capability: x" }), admit: () => ({ ok: true }), onBudget: "stop", costPerMinute: 0 } });
    assert.deepEqual(seen.map((s) => s.where), ["local"]);
  });
  it("every running entry carries placement.where, also for a lane admitted without a recorded one", async () => {
    const { saves } = await runRemote(() => ({ where: "remote", reason: "mode remote" }));
    const running = saves.flatMap((s) => Object.values(s.running ?? {}));
    assert.ok(running.length > 0 && running.every((r) => typeof r.placement?.where === "string"), JSON.stringify(running));
  });
});

// dispatch stall: a release after a long hold is not hours of idle
describe("dispatch-stall clock after an operator release", () => {
  const MIN = 60000;
  it("--release / hold expiry / requeue / unpause restart the idle clock", () => {
    const dir = tmpDir("stall-clock-");
    const b = openBatch(dir, "b-test");
    b.store.save({ v: 1, order: [1], pending: [1], running: {}, results: {} });
    const old = new Date(Date.now() - 150 * MIN);
    for (const f of ["state.json"]) utimesSync(`${b.dir}/${f}`, old, old);
    assert.ok(Date.now() - b.lastDispatchClockMs() >= 149 * MIN, "no operator input: the clock is the last progress");
    b.holdIssues([1]);
    b.releaseIssues([1]);
    assert.ok(Date.now() - b.lastDispatchClockMs() < MIN, "a release restarts the clock");
    const state = { order: [1], pending: [1], running: {}, results: {}, parallel: 4 };
    const idle = evaluateDispatchStall(state, { held: [], hosted: true, lastProgressMs: b.lastProgressMs(), now: Date.now(), windowMin: 3 });
    const fresh = evaluateDispatchStall(state, { held: [], hosted: true, lastProgressMs: b.lastDispatchClockMs(), now: Date.now(), windowMin: 3 });
    assert.equal(idle?.code, "dispatch-stalled"); // the old clock: declared stalled the moment the hold lifts
    assert.equal(fresh, null);
    b.setPause({}); b.clearPause();
    assert.ok(Date.now() - b.lastDispatchClockMs() < MIN);
  });
});

// a failed capacity probe clears at the next good sample (it used to stay failed forever)
describe("capacity sampler recovers from a failed probe", () => {
  it("throws after a failed probe, then samples again once the pool answers", async () => {
    let t = 0, ok = false, calls = 0;
    const cap = makeCapacitySampler({ provider: { capacity: async () => { calls++; if (!ok) throw new Error("502"); return { free: 3, online: 2 }; } }, now: () => t, pollMs: 5000 });
    assert.equal(cap(), null);
    await new Promise((r) => setImmediate(r));
    assert.throws(() => cap(), /capacity probe failed/);
    ok = true; t += 6000;
    assert.throws(() => cap(), /capacity probe failed/); // this call starts the refresh; the sample lands after it
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(cap(), { free: 3, online: 2, at: 2 });
    assert.equal(calls, 2);
  });
});
