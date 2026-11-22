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
  it("plan: planned/planTried are persisted for --resume", async () => {
    let saved = null;
    const store = { load: () => null, save: (s) => { if (s.planTried) saved = s; }, log: () => {} };
    await harness({ store }).run();
    assert.deepEqual(saved.planTried, [2]);
    assert.deepEqual(saved.planned[2], { contractHash: HASH, baseSha: SHA });
  });
});
