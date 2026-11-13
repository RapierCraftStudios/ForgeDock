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
