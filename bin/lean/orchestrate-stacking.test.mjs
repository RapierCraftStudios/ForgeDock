// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5831: stacked lanes phase 1 — orchestrate admits a dependent as a plan lane while its in-batch dependency runs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";

const HASH = "abcdef123456", SHA = "1".repeat(40);
const body = async (n) => (n === 2 ? "Depends on #1" : "");
/** Issue 1 resolves when `release1()` is called; every launch is recorded with its ctx. */
const harness = ({ planResult = { terminalReason: "planned", planned: { contractHash: HASH, baseSha: SHA } }, stacking = "plan", issues = [1, 2], ...extra } = {}) => {
  const calls = [], updates = [], events = [];
  let release1; const gate1 = new Promise((r) => { release1 = r; });
  const runOne = async (n, lane, ctx = {}) => {
    calls.push({ n, ctx });
    if (n === 1) { await gate1; return { terminalReason: "merged", cost_usd: 0 }; }
    if (ctx.plan) { release1(); return typeof planResult === "function" ? planResult() : planResult; }
    return { terminalReason: "merged", cost_usd: 0 };
  };
  const store = { load: () => null, save: () => {}, log: (r) => events.push(r) };
  const run = () => orchestrate({ issues, parallel: 2, readBody: body, runOne, stacking, store, onUpdate: (r) => updates.push(r), maxDeferrals: 1, ...extra });
  return { calls, updates, events, run, release1: () => release1() };
};

describe("orchestrate stacking (#5831)", () => {
  it("off: the dependent waits for the dependency; no plan lane, no ctx.plan/planned", async () => {
    const h = harness({ stacking: "off" });
    const p = h.run();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(h.calls.map((c) => c.n), [1], "the dependent does not start while #1 runs");
    h.release1();
    await p;
    assert.deepEqual(h.calls.map((c) => c.n), [1, 2]);
    assert.equal(h.calls.some((c) => c.ctx.plan || c.ctx.planned), false);
  });
  it("plan: the dependent gets a plan lane while #1 runs; its build lane starts after #1 merged with ctx.planned", async () => {
    const h = harness();
    await h.run();
    assert.deepEqual(h.calls.map((c) => [c.n, !!c.ctx.plan]), [[1, false], [2, true], [2, false]]);
    assert.deepEqual(h.calls[2].ctx.planned, { contractHash: HASH, baseSha: SHA });
    assert.deepEqual(h.updates.filter((u) => u.issue === 2).map((u) => u.outcome), ["planned", "merged"]);
    assert.ok(h.updates.find((u) => u.issue === 2 && u.outcome === "merged").plan_minutes >= 0, "#5834: plan lane minutes ride the final row");
    assert.deepEqual(h.events.filter((e) => e.event?.startsWith("STACK_")).map((e) => e.event), ["STACK_PLAN_START", "STACK_PLANNED"]);
  });
  it("plan: one plan lane per issue; a failed plan lane is plan-failed, not counted, and the build lane runs without ctx.planned", async () => {
    const h = harness({ planResult: { terminalReason: "engine-error", detail: "boom" }, breaker: { errors: 1, window_min: 30 } });
    await h.run();
    assert.equal(h.calls.filter((c) => c.n === 2 && c.ctx.plan).length, 1);
    const build = h.calls.filter((c) => c.n === 2 && !c.ctx.plan);
    assert.equal(build.length, 1, "no engine-error relaunch, breaker (errors: 1) not tripped");
    assert.equal(build[0].ctx.planned, undefined);
    assert.deepEqual(h.updates.filter((u) => u.issue === 2).map((u) => u.outcome), ["plan-failed", "merged"]);
  });
  it("plan: a dependency-open plan end is not a requeue", async () => {
    const h = harness({ planResult: { terminalReason: "dependency-open", dependencies: [1], detail: "open" } });
    await h.run();
    assert.deepEqual(h.updates.filter((u) => u.issue === 2).map((u) => u.outcome), ["plan-failed", "merged"]);
  });
  for (const reason of ["invalid", "needs-human", "decomposed", "budget-exceeded"]) {
    it(`plan (#5909): a ${reason} plan end settles the issue; no build lane, no plan-failed`, async () => {
      const h = harness({ planResult: { terminalReason: reason, detail: "verdict" } });
      await h.run();
      assert.equal(h.calls.filter((c) => c.n === 2 && !c.ctx.plan).length, 0, "no build lane");
      const outs = h.updates.filter((u) => u.issue === 2).map((u) => u.outcome);
      assert.equal(outs.includes("plan-failed"), false);
      assert.equal(outs.at(-1), reason);
    });
  }
  it("plan: planned/planTried are persisted for --resume", async () => {
    let saved = null;
    const store = { load: () => null, save: (s) => { if (s.planTried) saved = s; }, log: () => {} };
    await harness({ store }).run();
    assert.deepEqual(saved.planTried, [2]);
    assert.deepEqual(saved.planned[2], { contractHash: HASH, baseSha: SHA });
  });
});

describe("orchestrate stacked builds, phase 2 (#5832)", () => {
  const RD = { pr: 9, branch: "feat/issue-1-lean", sha: "a".repeat(40) };
  /** #1 runs until released; #2 depends on it. `ready` says whether #1's lane has published prReady. */
  const full = ({ stacking = "full", ready = () => RD, extra = {} } = {}) => {
    const calls = [], updates = [], events = [];
    let release1; const gate1 = new Promise((r) => { release1 = r; });
    const runOne = async (n, lane, ctx = {}) => {
      calls.push({ n, ctx });
      if (n === 1) { await gate1; return { terminalReason: "merged", cost_usd: 0 }; }
      if (ctx.plan) return { terminalReason: "planned", planned: { contractHash: HASH, baseSha: SHA } };
      if (ctx.stackedOn) release1(); // the stacked build ends only after the dependency merged
      return { terminalReason: "merged", cost_usd: 0 };
    };
    const store = { load: () => null, save: () => {}, log: (r) => events.push(r) };
    const run = () => orchestrate({ issues: [1, 2], parallel: 2, readBody: body, runOne, stacking, readPrReady: async () => ready(), store, onUpdate: (r) => updates.push(r), maxDeferrals: 1, ...extra });
    return { calls, updates, events, run, release1: () => release1() };
  };
  it("full: a dependent builds on the dependency's head once its PR is ready; STACK_BUILD_START and a stacked row record it", async () => {
    const h = full();
    await h.run();
    const b = h.calls.filter((c) => c.n === 2 && !c.ctx.plan);
    assert.equal(b.length, 1);
    assert.deepEqual(b[0].ctx.stackedOn, { dependency: 1, branch: RD.branch, sha: RD.sha });
    const ev = h.events.find((e) => e.event === "STACK_BUILD_START");
    assert.equal(ev.issue, 2); assert.equal(ev.stacked, true);
    const row = h.updates.find((u) => u.issue === 2 && u.outcome === "merged");
    assert.equal(row.stacked, true); assert.equal(row.stackedOn.dependency, 1);
    assert.deepEqual(row.deps, [1], "#5834: the row carries its in-batch edges");
    assert.ok(Number.isFinite(row.admitted_at) && row.ended_at >= row.admitted_at, "#5834: admission and end timestamps");
  });
  it("full: nothing is stacked before the dependency is PR-ready (it falls back to waiting for the merge)", async () => {
    let ready = false;
    const h = full({ ready: () => (ready ? RD : null) });
    const p = h.run();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.calls.some((c) => c.n === 2 && c.ctx.stackedOn), false);
    h.release1(); await p;
    assert.equal(h.calls.some((c) => c.n === 2 && c.ctx.stackedOn), false, "built after the merge as a normal lane");
    assert.equal(h.events.some((e) => e.event === "STACK_BUILD_START"), false);
  });
  it("plan and off never stack, even when the dependency is PR-ready", async () => {
    for (const stacking of ["plan", "off"]) {
      const h = full({ stacking });
      const p = h.run();
      await new Promise((r) => setTimeout(r, 100));
      h.release1(); await p;
      assert.equal(h.calls.some((c) => c.ctx.stackedOn), false, stacking);
    }
  });
  it("full: stacked/stackedTried persist for --resume", async () => {
    let saved = null;
    const store = { load: () => null, save: (st) => { if (st.stackedTried) saved = st; }, log: () => {} };
    await full({ extra: { store } }).run();
    assert.deepEqual(saved.stackedTried, [2]);
    assert.equal(saved.stacked[2].dependency, 1);
  });
  it("cascade (#5833): a stack.replan end requeues the dependent as a normal lane; the row records the cascade and its rework", async () => {
    let gate; const g = new Promise((r) => { gate = r; });
    const calls = [];
    const runOne = async (n, lane, ctx = {}) => {
      calls.push({ n, ctx });
      if (n === 1) { await g; return { terminalReason: "merged", cost_usd: 0 }; }
      if (ctx.plan) return { terminalReason: "planned", planned: { contractHash: HASH, baseSha: SHA } };
      if (ctx.stackedOn) { gate(); return { terminalReason: "deferred", code: "stack.replan", cascade: "replan", cascades: ["replan"], cascade_cost_usd: 0.25, cascade_minutes: 2, cost_usd: 0.25, detail: "dependency ended unsatisfied" }; }
      return { terminalReason: "merged", cost_usd: 0 };
    };
    const updates = [], events = [];
    const store = { load: () => null, save: () => {}, log: (r) => events.push(r) };
    await orchestrate({ issues: [1, 2], parallel: 2, readBody: body, runOne, stacking: "full", readPrReady: async () => RD, store, onUpdate: (r) => updates.push(r), maxDeferrals: 2 });
    const cas = updates.find((u) => u.issue === 2 && u.cascade);
    assert.equal(cas.cascade, "replan"); assert.equal(cas.stacked, true); assert.equal(cas.cascade_cost_usd, 0.25);
    assert.ok(events.some((e) => e.event === "STACK_CASCADE" && e.issue === 2 && e.cascade === "replan"));
    const later = calls.filter((c) => c.n === 2 && !c.ctx.plan && !c.ctx.stackedOn);
    assert.equal(later.length, 1, "rebuilt as a normal lane");
    assert.equal(updates.filter((u) => u.issue === 2).pop().outcome, "merged");
  });
});
