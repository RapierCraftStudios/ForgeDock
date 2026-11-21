// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5823: a pr-ready lane frees its slot; the batch's merge train merges its PR or hands it back to a fix lane.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { orchestrate } from "./orchestrate.mjs";

process.env.FORGEDOCK_SCHED_DIR = tmpDir("train-sched-");
const READY = (pr) => ({ terminalReason: "pr-ready", pr, head: "f".repeat(40), required: ["build"], policy: "required", lane: "staging", cost_usd: 1.5 });
/** `script[n]`: lane results per launch; `steps[n]`: train step results per pass (the last repeats). */
const run = ({ issues, script, steps, extra = {}, parallel = 1 }) => {
  const k = new Map(), s = new Map(), calls = [], stepped = [], relabels = [];
  const mergeTrain = { pollMs: 1, step: async (e) => { stepped.push([e.issue, e.pr]); const xs = steps[e.issue]; const i = s.get(e.issue) ?? 0; s.set(e.issue, i + 1); return xs[Math.min(i, xs.length - 1)]; } };
  return orchestrate({ issues, parallel, pollMs: 1, readBody: async (n) => (n === 2 && extra.dep ? "Depends on #1" : ""), mergeTrain, relabelNeedsHuman: async (x) => { relabels.push(x); },
    runOne: async (n, _lane, ctx) => { calls.push({ n, recover: ctx?.recover?.code ?? null, running: null }); const i = k.get(n) ?? 0; k.set(n, i + 1); return script[n][Math.min(i, script[n].length - 1)]; },
    ...extra.opts }).then((rows) => ({ rows, calls, stepped, relabels }));
};

describe("merge train in the batch runner (#5823)", () => {
  it("a pr-ready lane's PR merges through the train; the row is merged with the lane's cost and the train's wait", async () => {
    const r = await run({ issues: [1], script: { 1: [READY(11)] }, steps: { 1: [{ state: "wait" }, { state: "merged", mergedTo: { lane: "staging", pr: 11, sha: "c" }, detail: "PR #11 merged by the train" }] } });
    assert.equal(r.rows[0].outcome, "merged"); assert.equal(r.rows[0].pr, 11); assert.equal(r.rows[0].cost_usd, 1.5);
    assert.equal(r.rows[0].train.result, "merged"); assert.equal(r.calls.length, 1);
    assert.ok(r.stepped.length >= 2);
  });
  it("the slot frees at pr-ready: with parallel 1 the next issue starts while the first PR is still in the train", async () => {
    let gate = false;
    const order = [];
    const r = await run({ issues: [1, 2], script: { 1: [READY(11)], 2: [{ terminalReason: "merged", pr: 22 }] },
      steps: { 1: [{ state: "wait" }], 2: [{ state: "wait" }] },
      extra: { opts: { runOne: async (n) => { order.push(n); if (n === 2) gate = true; return n === 1 ? READY(11) : { terminalReason: "merged", pr: 22 }; },
        mergeTrain: { pollMs: 1, step: async () => (gate ? { state: "merged", detail: "ok" } : { state: "wait" }) } } } });
    assert.deepEqual(order, [1, 2]);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["merged", "merged"]);
  });
  it("a dependent waits for the train's merge, not for pr-ready", async () => {
    const order = [];
    let merged = false;
    const r = await run({ issues: [1, 2], parallel: 2, script: { 1: [READY(11)], 2: [{ terminalReason: "merged", pr: 22 }] }, steps: {},
      extra: { dep: true, opts: { runOne: async (n) => { order.push([n, merged]); return n === 1 ? READY(11) : { terminalReason: "merged", pr: 22 }; },
        mergeTrain: { pollMs: 1, step: async () => { merged = true; return { state: "merged", detail: "ok" }; } } } } });
    assert.deepEqual(order, [[1, false], [2, true]]);
    assert.equal(r.rows[1].outcome, "merged");
  });
  it("red hands the PR back: a ci.red recovery lane runs, ends pr-ready again, and the train merges it (recovered)", async () => {
    const r = await run({ issues: [1], script: { 1: [READY(11), READY(11)] },
      steps: { 1: [{ state: "handback", outcome: "needs-human", code: "ci.red", detail: "Required check(s) failed: build" }, { state: "merged", detail: "ok" }] },
      extra: { opts: { recovery: { maxAttempts: 1 } } } });
    assert.deepEqual(r.calls.map((c) => c.recover), [null, "ci.red"]);
    assert.equal(r.rows[0].outcome, "merged"); assert.equal(r.rows[0].recovered, "ci.red"); assert.equal(r.rows[0].cost_usd, 3);
  });
  it("red with no recovery left ends needs-human and is labelled once with the train's evidence", async () => {
    const r = await run({ issues: [1], script: { 1: [READY(11)] }, steps: { 1: [{ state: "handback", outcome: "needs-human", code: "ci.red", detail: "build failed" }] } });
    assert.equal(r.rows[0].outcome, "needs-human"); assert.equal(r.rows[0].code, "ci.red"); assert.equal(r.rows[0].train.result, "needs-human");
    assert.equal(r.relabels.length, 1); assert.match(r.relabels[0].evidence, /Merge train handed PR #11 back \(`ci.red`\)/);
  });
  it("without a train, pr-ready is an ordinary final row", async () => {
    const rows = await orchestrate({ issues: [1], parallel: 1, readBody: async () => "", runOne: async () => READY(11) });
    assert.equal(rows[0].outcome, "pr-ready");
  });
  it("an update (new head, syncs) is persisted on the entry and reaches the next step", async () => {
    const seen = [];
    const r = await run({ issues: [1], script: { 1: [READY(11)] }, steps: {},
      extra: { opts: { mergeTrain: { pollMs: 1, step: async (e) => { seen.push([e.head, e.syncs]); return seen.length === 1 ? { state: "wait", update: { head: "d", syncs: 1 } } : { state: "merged", detail: "ok" }; } } } } });
    assert.deepEqual(seen, [["f".repeat(40), 0], ["d", 1]]);
    assert.equal(r.rows[0].train.syncs, 1);
  });
});
