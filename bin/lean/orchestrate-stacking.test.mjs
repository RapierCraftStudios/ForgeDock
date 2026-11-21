// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5831 (epic #5822): stacked lanes phase 1, `orchestration.stacking: plan`: a dependent gets one read-only plan lane while its
// in-batch dependency is still open, and builds after the dependency merged with the plan's contract.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";
import { reuseStale } from "./lean.mjs";
import { parseStackFlags, STACKING_MODES } from "../engine-cli.mjs";

const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
const merged = { terminalReason: "merged" };
const body = (n) => (n === 2 ? "**Depends on** #1" : "");
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

describe("#5831: stacked plan lanes", () => {
  it("stacking off (default): the dependent starts only after its dependency merged, with no plan context", async () => {
    const calls = [];
    const g = gate();
    const done = orchestrate({ issues: [1, 2], parallel: 2, pollMs: 5, trusted: () => true, readBody: async (n) => body(n),
      runOne: async (n, _l, ctx) => { calls.push([n, !!ctx.plan, ctx.planned ?? null]); if (n === 1) await g.p; return merged; } });
    await until(() => calls.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls, [[1, false, null]], "no plan lane while off");
    g.open();
    await done;
    assert.deepEqual(calls, [[1, false, null], [2, false, null]]);
  });

  it("plan: the dependent's plan lane runs while the dependency runs; its build lane gets the plan after the merge", async () => {
    const calls = [], log = [];
    const g = gate();
    const rows = await (async () => {
      const done = orchestrate({ issues: [1, 2], parallel: 2, pollMs: 5, stacking: "plan", trusted: () => true, readBody: async (n) => body(n), onUpdate: (r) => log.push(r),
        decide: () => {},
        runOne: async (n, _l, ctx) => {
          calls.push({ n, plan: !!ctx.plan, planned: ctx.planned ?? null });
          if (ctx.plan) return { terminalReason: "planned", contractHash: "abcdef123456", baseSha: "0123456789abcdef", detail: "contract abcdef123456 frozen" };
          if (n === 1) await g.p;
          return merged;
        } });
      await until(() => calls.some((c) => c.n === 2 && c.plan));
      assert.ok(!calls.some((c) => c.n === 2 && !c.plan), "no build lane before the dependency merged");
      g.open();
      return done;
    })();
    assert.deepEqual(calls.map((c) => [c.n, c.plan]), [[1, false], [2, true], [2, false]]);
    assert.deepEqual(calls[2].planned, { hash: "abcdef123456", baseSha: "0123456789abcdef" });
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "merged"]]);
    assert.deepEqual(log.filter((r) => r.issue === 2 && ["plan-admitted", "planned"].includes(r.outcome)).map((r) => r.outcome), ["plan-admitted", "planned"]);
  });

  it("full runs as plan until stacked builds land", async () => {
    const calls = [];
    const g = gate();
    const done = orchestrate({ issues: [1, 2], parallel: 2, pollMs: 5, stacking: "full", trusted: () => true, readBody: async (n) => body(n),
      runOne: async (n, _l, ctx) => { calls.push([n, !!ctx.plan]); if (ctx.plan) return { terminalReason: "planned", contractHash: "abcdef123456" }; if (n === 1) await g.p; return merged; } });
    await until(() => calls.length === 2);
    g.open();
    await done;
    assert.deepEqual(calls, [[1, false], [2, true], [2, false]]);
  });

  it("a ready issue takes the slot before a plan lane", async () => {
    const calls = [];
    const g1 = gate(), g3 = gate();
    const done = orchestrate({ issues: [1, 2, 3], parallel: 2, pollMs: 5, stacking: "plan", trusted: () => true, readBody: async (n) => body(n),
      runOne: async (n, _l, ctx) => {
        calls.push([n, !!ctx.plan]);
        if (ctx.plan) return { terminalReason: "planned", contractHash: "abcdef123456" };
        if (n === 1) await g1.p;
        if (n === 3) await g3.p;
        return merged;
      } });
    await until(() => calls.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls, [[1, false], [3, false]], "both slots go to ready issues");
    g3.open();
    await until(() => calls.length === 3);
    assert.deepEqual(calls[2], [2, true], "the freed slot plans #2 while #1 still runs");
    g1.open();
    await done;
    assert.deepEqual(calls[3], [2, false]);
  });

  it("a failed plan lane returns the issue to pending once (plan-failed): no breaker, no relaunch, no second plan lane", async () => {
    const calls = [], log = [];
    const g = gate();
    const done = orchestrate({ issues: [1, 2], parallel: 2, pollMs: 5, stacking: "plan", breaker: { errors: 1, window_min: 30 }, trusted: () => true,
      readBody: async (n) => body(n), onUpdate: (r) => log.push(r), decide: () => {},
      runOne: async (n, _l, ctx) => { calls.push([n, !!ctx.plan, ctx.planned ?? null]); if (ctx.plan) return { terminalReason: "engine-error", detail: "boom" }; if (n === 1) await g.p; return merged; } });
    await until(() => log.some((r) => r.outcome === "plan-failed"));
    await new Promise((r) => setTimeout(r, 30));
    g.open();
    const rows = await done;
    assert.deepEqual(calls, [[1, false, null], [2, true, null], [2, false, null]]);
    assert.ok(!log.some((r) => r.outcome === "breaker"), "a plan lane's engine-error never trips the breaker");
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "merged"]]);
  });

  it("an invalid verdict from the plan lane is final", async () => {
    const g = gate();
    const done = orchestrate({ issues: [1, 2], parallel: 2, pollMs: 5, stacking: "plan", trusted: () => true, readBody: async (n) => body(n),
      runOne: async (n, _l, ctx) => { if (ctx.plan) return { terminalReason: "invalid", detail: "already fixed" }; if (n === 1) await g.p; return merged; } });
    await new Promise((r) => setTimeout(r, 40));
    g.open();
    const rows = await done;
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "invalid"]]);
  });

  it("a dependency that ends unsatisfied still holds the planned dependent (no build)", async () => {
    const calls = [];
    const g = gate();
    const done = orchestrate({ issues: [1, 2], parallel: 2, pollMs: 5, stacking: "plan", trusted: () => true, readBody: async (n) => body(n),
      runOne: async (n, _l, ctx) => { calls.push([n, !!ctx.plan]); if (ctx.plan) return { terminalReason: "planned", contractHash: "abcdef123456" }; await g.p; return { terminalReason: "needs-human", detail: "x" }; } });
    await until(() => calls.length === 2);
    g.open();
    const rows = await done;
    assert.deepEqual(calls, [[1, false], [2, true]]);
    assert.equal(rows.find((r) => r.issue === 2).outcome, "held");
  });

  it("planned and planTried are persisted for a resume", async () => {
    let state = null;
    const store = { load: () => null, save: (s) => { state = JSON.parse(JSON.stringify(s)); }, log: () => {} };
    const g = gate();
    const done = orchestrate({ issues: [1, 2], parallel: 2, pollMs: 5, stacking: "plan", store, trusted: () => true, readBody: async (n) => body(n),
      runOne: async (n, _l, ctx) => { if (ctx.plan) return { terminalReason: "planned", contractHash: "abcdef123456", baseSha: "0123456789abcdef" }; if (n === 1) await g.p; return merged; } });
    await until(() => state?.planned?.["2"]);
    assert.equal(state.planned["2"].hash, "abcdef123456");
    assert.deepEqual(state.planTried, [2]);
    g.open();
    await done;
  });
});

describe("#5831: lane plumbing", () => {
  it("parseStackFlags reads --plan and --planned <hash>[:<sha>]", () => {
    assert.deepEqual(parseStackFlags(["7", "--plan"]), { plan: true, planned: null });
    assert.deepEqual(parseStackFlags(["7", "--planned", "abcdef123456:0123456789abcdef"]), { plan: false, planned: { hash: "abcdef123456", baseSha: "0123456789abcdef" } });
    assert.deepEqual(parseStackFlags(["7", "--planned", "abcdef123456"]), { plan: false, planned: { hash: "abcdef123456", baseSha: null } });
    assert.deepEqual(parseStackFlags(["7", "--planned", "--retry"]), { plan: false, planned: null });
    assert.deepEqual(STACKING_MODES, ["off", "plan", "full"]);
  });

  it("reuseStale: a deliverable the dependency changed, or an uncomparable plan base, is stale", () => {
    const fc = { base: "staging", scope: "s1" };
    assert.equal(reuseStale({ fc, scopeHash: "s1", lane: "staging", resumed: false }), null);
    assert.equal(reuseStale({ fc, scopeHash: "s1", lane: "staging", resumed: false, moved: [] }), null);
    assert.match(reuseStale({ fc, scopeHash: "s1", lane: "staging", resumed: false, moved: ["bin/a.mjs"] }), /dependency changed deliverable path\(s\) since the plan: bin\/a\.mjs/);
    assert.match(reuseStale({ fc, scopeHash: "s1", lane: "staging", resumed: false, moved: null }), /could not be compared/);
    assert.match(reuseStale({ fc, scopeHash: "s2", lane: "staging", resumed: false, moved: [] }), /issue scope/);
  });
});
