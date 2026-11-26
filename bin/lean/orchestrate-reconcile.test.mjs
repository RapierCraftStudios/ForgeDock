// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5978: standing orders: selector join/leave, re-admission policy, env.* join, breaker auto-reset, staging-lane close, coverage.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";
import { readmitDue, backoffMs, humanCode, environmentalDetail, closesManually, needsDecisionDigest, diffSelection, parseSelected, selectArgs, DEFER_CAP_MS, HELD_COOLDOWN_MS } from "./reconcile.mjs";
import { decideAutoReset } from "./clear-breaker.mjs";
import { coverage } from "./batch.mjs";

const harness = ({ script = {}, issues = [], reconcile, extra = {} }) => {
  let t = 1_000_000;
  const calls = [], decisions = [], updates = [];
  return orchestrate({ issues, parallel: 2, readBody: async () => "", now: () => t, pollMs: 1000, reconcile, select: reconcile ? "no:milestone" : null,
    sleep: async (ms) => { t += Math.max(1, Number(ms) || 0); },
    runOne: async (n) => { calls.push(n); t += 1000; const l = script[n] ?? [{ terminalReason: "merged", pr: 1 }]; return l[Math.min(calls.filter((c) => c === n).length - 1, l.length - 1)]; },
    decide: (d) => decisions.push(d), onUpdate: (r) => updates.push(r), ...extra }).then((rows) => ({ rows, calls, decisions, updates }));
};

const seeded = (results, more = {}) => ({ load: () => ({ v: 1, order: Object.keys(results).map(Number), pending: [], results, ...more }), save: () => {}, log: () => {} });

describe("selector reconcile (R2, R13)", () => {
  it("a new matching issue joins within one interval, no operator command; a standing order ends only by stop", async () => {
    let polls = 0;
    const ac = new AbortController();
    const list = async () => { polls++; if (polls >= 4) ac.abort(); return polls === 1 ? [{ number: 1 }] : [{ number: 1 }, { number: 2 }]; };
    const r = await harness({ issues: [], reconcile: { everyMs: 5000, list }, extra: { signal: ac.signal } });
    assert.deepEqual(r.calls.sort(), [1, 2]);
    assert.ok(r.rows.every((x) => x.outcome === "merged"));
  });
  it("diffSelection joins matches and leaves closed pending issues, never running ones", () => {
    const d = diffSelection({ open: [{ number: 5 }, { number: 6 }], members: [5, 7, 8], pending: [7], running: new Set([8]), results: new Map() });
    assert.deepEqual(d, { join: [6], leave: [7] });
  });
  it("#6022 only a member the selector matched can leave: env.* issues, children, --add and argv members stay pending", () => {
    const d = diffSelection({ open: [{ number: 5 }], members: [5, 7, 9], pending: [7, 9], running: new Set(), results: new Map(), matched: new Set([5, 7]) });
    assert.deepEqual(d, { join: [], leave: [7] });
  });
  it("#6029 a selector-matched member closed during a resume's downtime leaves; unmatched pending members still run", async () => {
    const saves = [];
    const store = { load: () => ({ v: 1, order: [7, 9], pending: [7, 9], results: {}, selMatched: [7] }), save: (s) => saves.push(s), log: () => {} };
    const ac = new AbortController();
    let polls = 0;
    const r = await harness({ issues: [], reconcile: { everyMs: 5000, list: async () => { if (++polls >= 3) ac.abort(); return [{ number: 9 }]; } }, extra: { store, signal: ac.signal } });
    assert.deepEqual(r.calls, [9]);
    assert.ok(r.rows.find((x) => x.issue === 7)?.outcome !== "merged");
    assert.ok(saves.some((s) => Array.isArray(s.selMatched) && s.selMatched.includes(9)), "save() persists selMatched");
  });
  it("#6029 old state without selMatched restores an empty set: a closed pending member does not leave", async () => {
    const store = { load: () => ({ v: 1, order: [7], pending: [7], results: {} }), save: () => {}, log: () => {} };
    const ac = new AbortController();
    let polls = 0;
    const r = await harness({ issues: [], reconcile: { everyMs: 5000, list: async () => { if (++polls >= 3) ac.abort(); return []; } }, extra: { store, signal: ac.signal } });
    assert.deepEqual(r.calls, [7]);
  });
  it("a failed read leaves nothing (parseSelected null)", () => {
    assert.equal(parseSelected("not json"), null);
    assert.deepEqual(parseSelected('[{"number":3,"labels":[{"name":"x"}]}]'), [{ number: 3, labels: ["x"] }]);
    assert.ok(selectArgs("o/r", "no:milestone").includes("no:milestone"));
  });
});

describe("re-admission policy (R5, R6, R8, R14)", () => {
  const rows = (o) => new Map([[9, { issue: 9, outcome: o }]]);
  it("deferred retries with exponential backoff capped at 2h", () => {
    const state = new Map();
    assert.equal(readmitDue({ results: rows("deferred"), state, now: 0 }).requeue.length, 0);
    assert.equal(readmitDue({ results: rows("deferred"), state, now: backoffMs(0) }).requeue.length, 1);
    assert.equal(backoffMs(30), DEFER_CAP_MS);
    assert.ok(backoffMs(2) > backoffMs(1));
  });
  it("held / engine-error re-admit on a version change, or after the 6h cooldown", () => {
    for (const o of ["held", "engine-error"]) {
      const state = new Map();
      readmitDue({ results: rows(o), state, now: 0, version: "1" });
      assert.equal(readmitDue({ results: rows(o), state, now: 1000, version: "1" }).requeue.length, 0);
      assert.equal(readmitDue({ results: rows(o), state, now: 2000, version: "2" }).requeue.length, 1);
      const s2 = new Map();
      readmitDue({ results: rows(o), state: s2, now: 0, version: "1" });
      assert.equal(readmitDue({ results: rows(o), state: s2, now: HELD_COOLDOWN_MS, version: "1" }).requeue.length, 1);
    }
  });
  it("a human-coded needs-human is never re-admitted", () => {
    const r = new Map([[4, { issue: 4, outcome: "needs-human", detail: "needs credentials for the payment API" }]]);
    assert.equal(readmitDue({ results: r, state: new Map(), now: 0 }).requeue.length, 0);
    assert.ok(humanCode({ outcome: "needs-human", detail: "product decision needed" }));
    assert.ok(!humanCode({ outcome: "needs-human", detail: "tests failed on lint" })); // negative example
    assert.ok(!humanCode({ outcome: "engine-error", detail: "customers table" }));
  });
  it("conformance: one more attempt after the base moves, then parked in one digest", () => {
    const row = new Map([[7, { issue: 7, outcome: "needs-human", conformance: { failed: true } }]]);
    const state = new Map();
    assert.equal(readmitDue({ results: row, state, now: 0, base: "a" }).requeue.length, 0);
    assert.equal(readmitDue({ results: row, state, now: 1, base: "a" }).requeue.length, 0);
    assert.equal(readmitDue({ results: row, state, now: 2, base: "b" }).requeue.length, 1);
    const again = readmitDue({ results: row, state, now: 3, base: "c" });
    assert.equal(again.requeue.length, 0);
    assert.deepEqual(again.parked.map((p) => p.issue), [7]);
    assert.match(needsDecisionDigest(again.parked), /needs decision \(1\): #7/);
    assert.equal(needsDecisionDigest([]), "");
  });
  it("runner requeues an ended held issue on a version change without an operator command", async () => {
    let ver = "1", polls = 0;
    const ac = new AbortController();
    const r = await harness({ issues: [1], reconcile: { everyMs: 1000, version: () => ver, list: async () => { if (++polls === 3) ver = "2"; if (polls > 8) ac.abort(); return [{ number: 1 }]; } },
      extra: { signal: ac.signal, store: seeded({ 1: { issue: 1, outcome: "held", detail: "x" } }) } });
    assert.deepEqual(r.calls, [1]);
    assert.ok(r.updates.some((u) => u.issue === 1 && u.outcome === "requeued"));
    assert.equal(r.rows[0].outcome, "merged");
  });
  it("the env.* issue the engine filed joins the order", async () => {
    const ac = new AbortController(); let polls = 0;
    const r = await harness({ issues: [], reconcile: { everyMs: 1000, list: async () => { if (++polls > 3) ac.abort(); return []; } },
      extra: { signal: ac.signal, store: seeded({}, { envSigs: { "env.tool:x": { issues: [1, 2], number: 77 } } }) } });
    assert.deepEqual(r.calls, [77]);
  });
});

describe("breaker auto-reset (R9)", () => {
  it("environmental signature + cooldown + healthy pool resets; anything else does not", () => {
    const tripped = { at: 100 };
    const base = { tripped, now: 100 + 1000, cooldownMs: 500, environmental: true, poolHealthy: true };
    assert.equal(decideAutoReset(base).reset, true);
    assert.equal(decideAutoReset({ ...base, environmental: false }).reset, false);
    assert.equal(decideAutoReset({ ...base, now: 200 }).reset, false);
    assert.equal(decideAutoReset({ ...base, poolHealthy: false }).reset, false);
    assert.equal(decideAutoReset({ ...base, tripped: null }).reset, false);
  });
  it("environmental details are recognised; product failures are not", () => {
    assert.ok(environmentalDetail("sandbox.lost: VM restart"));
    assert.ok(environmentalDetail("mirror fetch ETIMEDOUT"));
    assert.ok(!environmentalDetail("assertion failed in foo.test.mjs"));
  });
});

describe("staging lane close (R11)", () => {
  it("only a merge into a non-default staging/milestone lane closes by hand", () => {
    assert.ok(closesManually("staging"));
    assert.ok(closesManually("milestone/v2"));
    assert.ok(!closesManually("main"));
    assert.ok(!closesManually(""));
  });
  it("the runner closes the issue after a merge into a staging lane", async () => {
    const closed = [];
    let polls = 0;
    const ac = new AbortController();
    await harness({ issues: [3], script: { 3: [{ terminalReason: "merged", pr: 1, lane: "staging" }] },
      reconcile: { everyMs: 1000, list: async () => { if (++polls > 2) ac.abort(); return [{ number: 3 }]; }, closeIssue: async (n, o) => closed.push([n, o.lane]) },
      extra: { signal: ac.signal } }).catch(() => null);
    assert.deepEqual(closed, [[3, "staging"]]);
  });
});

describe("--status coverage (R12, R16)", () => {
  it("0 unscheduled when each open match is running/queued/backing-off/waiting/human-blocked", () => {
    const state = { pending: [2, 3, 4], running: { 1: {} }, notBefore: { 3: 9e15 }, deps: { 4: [2] }, results: { 5: { outcome: "needs-human", detail: "needs credentials" }, 6: { outcome: "deferred" } }, readmit: { 6: {} } };
    const c = coverage({ state, open: [1, 2, 3, 4, 5, 6].map((number) => ({ number })), now: 1 });
    assert.deepEqual([c.running, c.queued, c.backingOff, c.waitingDeps, c.humanBlocked, c.unscheduled], [[1], [2], [3, 6], [4], [5], []]);
  });
  it("a match nobody will run is unscheduled", () => {
    const c = coverage({ state: { pending: [], results: { 8: { outcome: "needs-human", detail: "tests failed" } } }, open: [{ number: 8 }, { number: 9 }] });
    assert.deepEqual(c.unscheduled, [8, 9]);
  });
});
