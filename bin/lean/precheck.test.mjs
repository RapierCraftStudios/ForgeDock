// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { runChecks, formatPrecheckSummary } from "./precheck.mjs";
import { readPrecheckBudget } from "../engine-cli.mjs";
import { orchestrate } from "./orchestrate.mjs";

/** A fake run: each call takes `cost[command]` ms of the shared clock (default 1000) and returns rc[command] (default 0). */
function harness({ cost = {}, rc = {} } = {}) {
  const h = { t: 0, live: 0, peak: 0, calls: [] };
  h.now = () => h.t;
  h.run = async ({ command, timeoutMs }) => {
    h.calls.push([command, timeoutMs]); h.peak = Math.max(h.peak, ++h.live);
    await new Promise((r) => setImmediate(r));
    const c = cost[command] ?? 1000;
    h.t += Math.min(c, timeoutMs); h.live--;
    return c > timeoutMs ? { rc: 124, output: "timed out" } : { rc: rc[command] ?? 0, output: `${command} out` };
  };
  return h;
}

describe("runChecks (#4331)", () => {
  it("runs up to `parallelism` commands at once and returns results in input order with ms", async () => {
    const h = harness();
    const r = await runChecks({ commands: ["a", "b", "c", "d", "e"], parallelism: 3, budgetMs: 600000, perCommandMs: 300000, now: h.now, run: h.run });
    assert.equal(h.peak, 3);
    assert.deepEqual(r.results.map((x) => x.command), ["a", "b", "c", "d", "e"]);
    assert.ok(r.results.every((x) => x.rc === 0 && Number.isFinite(x.ms) && x.ms >= 0));
    assert.deepEqual(r.deferred, []);
    assert.ok(r.ms > 0);
  });

  it("parallelism 1 is serial; 0, NaN or missing fall back to 1", async () => {
    for (const p of [1, 0, NaN, undefined, "x"]) {
      const h = harness();
      await runChecks({ commands: ["a", "b", "c"], parallelism: p, budgetMs: 600000, perCommandMs: 300000, now: h.now, run: h.run });
      assert.equal(h.peak, 1, String(p));
    }
  });

  it("past the budget the remaining commands are deferred to CI, not failed; a running one gets what is left", async () => {
    const h = harness();
    const r = await runChecks({ commands: ["a", "b", "c"], parallelism: 1, budgetMs: 1500, perCommandMs: 300000, now: h.now, run: h.run });
    assert.deepEqual(h.calls, [["a", 1500], ["b", 500]]);
    assert.deepEqual(r.results.map((x) => [x.command, x.rc]), [["a", 0]], "b was cut by the budget (rc 124): deferred, not a failure");
    assert.deepEqual(r.deferred, ["b", "c"]);
  });

  it("a command's own timeout (not the budget) stays a failure; a throw is rc 127", async () => {
    const h = harness({ cost: { slow: 5000 } });
    const r = await runChecks({ commands: ["slow", "boom", "bad"], parallelism: 2, budgetMs: 600000, perCommandMs: 2000, now: h.now,
      run: (a) => (a.command === "boom" ? Promise.reject(new Error("spawn failed")) : a.command === "bad" ? Promise.resolve({ rc: 2, output: "lint" }) : h.run(a)) });
    assert.deepEqual(r.results.map((x) => [x.command, x.rc]), [["slow", 124], ["boom", 127], ["bad", 2]]);
    assert.match(r.results[1].output, /spawn failed/);
    assert.deepEqual(r.deferred, []);
  });

  it("no commands: nothing runs", async () => {
    let n = 0;
    const r = await runChecks({ commands: [], parallelism: 4, budgetMs: 1000, perCommandMs: 1000, now: () => 0, run: async () => { n++; return { rc: 0 }; } });
    assert.deepEqual([n, r.results, r.deferred, r.ms], [0, [], [], 0]);
  });
});

describe("formatPrecheckSummary (#4331)", () => {
  it("sums precheck_ms over the lanes that ran checks and counts deferrals; null when none did", () => {
    assert.equal(formatPrecheckSummary([{ precheck_ms: 90000 }, { precheck_ms: 30000, precheck_deferred: 2 }, { issue: 3 }]), "precheck: 2.0m total over 2 lanes, 2 deferred to CI");
    assert.equal(formatPrecheckSummary([{ precheck_ms: 6000 }]), "precheck: 0.1m total over 1 lane");
    assert.equal(formatPrecheckSummary([{ issue: 1 }]), null);
    assert.equal(formatPrecheckSummary(undefined), null);
  });
  it("orchestrate rows carry the lane's precheckMs/precheckDeferred as precheck_ms/precheck_deferred for the report line", async () => {
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async () => "",
      runOne: async (n) => ({ terminalReason: "merged", ...({ 1: { precheckMs: 90000, precheckDeferred: 1 }, 2: { precheckMs: 30000, precheckDeferred: 0 } })[n] }) });
    assert.deepEqual(rows.map((r) => [r.issue, r.precheck_ms, r.precheck_deferred]), [[1, 90000, 1], [2, 30000, undefined], [3, undefined, undefined]]);
    assert.equal(formatPrecheckSummary(rows), "precheck: 2.0m total over 2 lanes, 1 deferred to CI");
  });
});

describe("readPrecheckBudget: forge.yaml lean.precheck.max_minutes (#4331)", () => {
  const withYaml = (text, fn) => { const d = tmpDir("precheck-"); writeFileSync(join(d, "forge.yaml"), text); return fn(d); };
  it("reads the nested block and the flat key; invalid or absent is undefined", () => {
    assert.equal(withYaml("lean:\n  precheck:\n    max_minutes: 7\n", readPrecheckBudget), 7);
    assert.equal(withYaml("lean:\n  precheck_max_minutes: 15\n  repro_test: off\n", readPrecheckBudget), 15);
    for (const bad of ["0", "-1", "abc", "121"]) assert.equal(withYaml(`lean:\n  precheck_max_minutes: ${bad}\n`, readPrecheckBudget), undefined, bad);
    assert.equal(withYaml("verify:\n  mode: local\n", readPrecheckBudget), undefined);
    assert.equal(readPrecheckBudget(tmpDir("precheck-")), undefined);
  });
});
