// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";
import { hostFallbackAllowed } from "./execution.mjs";

// #5652: host re-placement of a remote lane's env.tool_missing / env.capability_remote end follows host.role / execution.host_fallback.
const go = async (code, cfg) => {
  const calls = [];
  const rows = await orchestrate({ issues: [5], parallel: 2, recovery: { maxAttempts: 1 }, readBody: async () => "",
    remote: { max: 2, isRemote: () => true, hostFallback: hostFallbackAllowed(cfg), place: () => ({ where: "remote", reason: "mode remote" }), admit: () => ({ ok: true }), onBudget: "stop", costPerMinute: 0 },
    runOne: async (n, _l, ctx = {}) => {
      calls.push({ placement: ctx.placement?.where, recover: ctx.recover?.code ?? null });
      return ctx.recover ? { terminalReason: "merged", pr: 9 } : { terminalReason: "needs-human", code, detail: "no tool", placement: { where: "remote" } };
    } });
  return { rows, calls };
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
