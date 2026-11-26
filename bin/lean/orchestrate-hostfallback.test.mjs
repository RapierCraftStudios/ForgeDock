// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";
import { hostFallbackAllowed } from "./execution.mjs";

// #5652: host re-placement of a remote lane's env.tool_missing / env.capability_remote end follows host.role / execution.host_fallback.
const go = async (code, cfg, rec = {}) => {
  const calls = [];
  const rows = await orchestrate({ issues: [5], parallel: 2, recovery: { maxAttempts: 1 }, readBody: async () => "",
    remote: { max: 2, isRemote: () => true, hostFallback: hostFallbackAllowed(cfg), place: () => ({ where: "remote", reason: "mode remote" }), admit: () => ({ ok: true }), onBudget: "stop", costPerMinute: 0 },
    runOne: async (n, _l, ctx = {}) => {
      calls.push({ placement: ctx.placement?.where, recover: ctx.recover?.code ?? null });
      return ctx.recover ? { terminalReason: "merged", pr: 9 } : { terminalReason: "needs-human", code, detail: "no tool", placement: { where: "remote" } };
    } });
  return { rows, calls };
};

// #5746: remote mode with host fallback off never re-places a mechanical recovery on the host
const goMech = async (hostFallback) => {
  const calls = [];
  await orchestrate({ issues: [5], parallel: 2, recovery: { maxAttempts: 1, mechanicalMaxAttempts: 2 }, readBody: async () => "",
    remote: { max: 2, isRemote: () => true, hostFallback, admit: () => ({ ok: true }), onBudget: "stop", costPerMinute: 0 },
    runOne: async (n, _l, ctx = {}) => {
      calls.push(ctx.placement?.where);
      return ctx.recover ? { terminalReason: "merged", pr: 9 } : { terminalReason: "needs-human", code: "env.repro_unrunnable", detail: "x", placement: { where: "remote" } };
    } });
  return calls;
};

describe("#5652 host fallback placement", () => {
  for (const code of ["env.capability_remote", "env.tool_missing"]) {
    it(`${code}: host.role unset keeps the host re-placement`, async () => {
      const r = await go(code, {});
      assert.equal(r.calls.length, 2);
    });
    it(`${code}: host.role orchestrator ends the lane without a host re-placement`, async () => {
      const r = await go(code, { hostRole: "orchestrator" });
      assert.equal(r.calls.length, 1);
      assert.equal(r.rows.find((x) => x.issue === 5).outcome, "needs-human");
    });
    it(`${code}: explicit host_fallback: true overrides host.role orchestrator`, async () => {
      const r = await go(code, { hostRole: "orchestrator", hostFallback: true });
      assert.equal(r.calls.length, 2);
      assert.equal(r.calls[1].placement === "local" || r.calls[1].placement === "remote", true);
    });
  }
  it("regression: a non-host code (ci.red-like) recovery is unaffected by host.role", async () => {
    const r = await go("env.repro_unrunnable", { hostRole: "orchestrator" });
    assert.ok(r.calls.length >= 1);
  });
  it("#5746: remote mode with nothing set disallows the host; hybrid keeps it; explicit true wins", () => {
    assert.equal(hostFallbackAllowed({ mode: "remote" }), false);
    assert.equal(hostFallbackAllowed({ mode: "hybrid" }), true);
    assert.equal(hostFallbackAllowed({ mode: "remote", hostFallback: true }), true);
    assert.equal(hostFallbackAllowed({ mode: "remote", fallbackLocal: true }), false);
  });
  it("#5746: a #5371 mechanical recovery with host_fallback false retries remotely, not on the host", async () => {
    const calls = await goMech(false);
    assert.ok(calls.length >= 2);
    assert.ok(calls.every((w) => w !== "local"), JSON.stringify(calls));
  });
  it("#5746: with host fallback on the #5371 recovery still goes to the host", async () => {
    const calls = await goMech(true);
    assert.equal(calls[1], "local");
  });
  for (const [name, remoteCfg] of [
    ["fallback_local with max_remote 0", { max: 0, fallbackLocal: true, offlineFallback: true, admit: () => ({ ok: true }), onBudget: "stop" }],
    ["execution budget under on_budget local", { max: 2, admit: () => ({ ok: false, reason: "budget cap" }), onBudget: "local" }],
  ]) {
    it(`#5746: host_fallback false: ${name} never runs the lane on the host`, async () => {
      const ac = new AbortController(), where = [];
      const run = orchestrate({ issues: [5], parallel: 2, readBody: async () => "", pollMs: 5, signal: ac.signal,
        remote: { isRemote: () => true, hostFallback: false, place: () => ({ where: "remote", reason: "mode remote" }), costPerMinute: 0, ...remoteCfg },
        runOne: async (_n, _l, ctx = {}) => { where.push(ctx.placement?.where); return { terminalReason: "merged", pr: 1 }; } }).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
      ac.abort();
      await Promise.race([run, new Promise((r) => setTimeout(r, 1000))]);
      assert.ok(!where.includes("local"), JSON.stringify(where));
    });
  }
  it("#5746: remote mode with nothing set ends a host-capability lane without a host re-placement", async () => {
    const r = await go("env.capability_remote", { mode: "remote" });
    assert.equal(r.calls.length, 1);
  });
  it("#5746: max_remote 0 holds the lane (no host run) and announces waiting", async () => {
    const events = [], ac = new AbortController();
    let ran = 0;
    const run = orchestrate({ issues: [5], parallel: 2, readBody: async () => "", pollMs: 5, signal: ac.signal, decide: (d) => events.push(d.what),
      remote: { max: 0, isRemote: () => true, hostFallback: false, place: () => ({ where: "remote", reason: "max_remote 0 (live override)", hold: true }), admit: () => ({ ok: true }), onBudget: "stop", costPerMinute: 0 },
      runOne: async () => { ran++; return { terminalReason: "merged", pr: 1 }; } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await Promise.race([run, new Promise((r) => setTimeout(r, 1000))]);
    assert.equal(ran, 0);
    assert.ok(events.some((w) => /waiting: max_remote 0/.test(w)), JSON.stringify(events));
  });
});

// #5808: a lane's slow post-result work (teardown) is its postRun: the dependent starts at once, the batch still waits for it.
describe("#5808 dispatch on lane exit", () => {
  const run = async (cfg = {}) => {
    const log = [];
    let release;
    const gate = new Promise((res) => { release = res; });
    const p = orchestrate({ issues: [1, 2], parallel: 2, readBody: async (n) => (n === 2 ? "Depends on #1" : ""),
      remote: { max: 1, isRemote: () => true, place: () => ({ where: "remote", reason: "mode remote" }), admit: () => ({ ok: true }), onBudget: "stop", costPerMinute: 0, ...cfg },
      runOne: async (n) => {
        log.push(`start ${n}`);
        if (n === 1) return { terminalReason: "merged", pr: 1, postRun: async () => { await gate; log.push("postRun 1 done"); } };
        return { terminalReason: "merged", pr: 2 };
      } });
    return { p, log, release };
  };
  it("orchestrate: dependent starts before the finished lane's postRun resolves (#5808)", async () => {
    const { p, log, release } = await run({ max: 2 });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(log, ["start 1", "start 2"]); // before postRun 1 resolved
    release();
    await p;
    assert.deepEqual(log, ["start 1", "start 2", "postRun 1 done"]); // the batch waited for it
  });
  it("orchestrate: a pass runs on lane exit, with no scheduler tick (sleep never fires) (#5808)", async () => {
    const log = [];
    const never = () => new Promise(() => {}); // a tick that never arrives: only the lane exit can wake the loop
    let free;
    const gate = new Promise((res) => { free = res; });
    const p = orchestrate({ issues: [1, 2], parallel: 1, pollMs: 1e9, sleep: never, readBody: async (n) => (n === 2 ? "Depends on #1" : ""),
      runOne: async (n) => { log.push(`start ${n}`); if (n === 1) await gate; return { terminalReason: "merged", pr: n }; } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(log, ["start 1"]); // K=1: the dependent is held while the slot is taken
    free();
    const rows = await p; // would hang if the next pass waited for a tick
    assert.deepEqual(log, ["start 1", "start 2"]);
    assert.deepEqual(rows.map((x) => x.outcome), ["merged", "merged"]);
  });
});
