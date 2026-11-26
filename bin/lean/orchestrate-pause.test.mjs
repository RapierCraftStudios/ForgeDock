// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5975: a batch-level pause stops admission for every issue (dependency merge, engine/env re-admit, expiry), never a running lane.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate, AUTH_PROBE_MS, AUTH_ESCALATE_MS, HOLD_RAMP_STEP_MS } from "./orchestrate.mjs";

const memStore = () => { let st = null; return { load: () => (st ? JSON.parse(JSON.stringify(st)) : null), save: (s) => { st = JSON.parse(JSON.stringify(s)); }, log: () => {} }; };
const EE = (detail) => ({ terminalReason: "engine-error", detail });
const MERGED = { terminalReason: "merged", pr: 9 };
const REC = { owner: "op@h", since: "2026-01-01T00:00:00.000Z", expiresAt: null, reason: "release cut", ownerPid: null, ownerHost: null };

// A fake clock: every sleep advances it, so polls and expiry run instantly.
const run = ({ script, issues, store = memStore(), pause = { v: null }, extra = {}, onStart = () => {}, onRow = () => {}, clock = { t: 1_000_000 } }) => {
  const calls = [], updates = [], decisions = [];
  const p = orchestrate({ issues, parallel: 1, pollMs: 1000, readBody: async (n) => (n === 2 ? "Blocked by #1" : ""), trusted: () => true, now: () => clock.t, store,
    sleep: async (ms) => { clock.t += Math.max(1, Number(ms) || 0); },
    getPause: () => pause.v, recovery: { maxAttempts: 1, mechanicalMaxAttempts: 3 },
    runOne: async (n) => { calls.push(n); clock.t += 1000; onStart(n); const l = script[n] ?? [MERGED]; return l[Math.min(calls.filter((c) => c === n).length - 1, l.length - 1)]; },
    decide: (d) => decisions.push(d), onUpdate: (r) => { updates.push(r); onRow(r); }, ...extra });
  return p.then((rows) => ({ rows, calls, updates, decisions, byIssue: Object.fromEntries(rows.map((r) => [r.issue, r])) }));
};

describe("#5975: batch pause", () => {
  it("paused batch: a dependency merge does not dispatch the re-admitted dependent; after --unpause it does; the running lane completes", async () => {
    const store = memStore(), pause = { v: null };
    const a = await run({ script: {}, issues: [2, 1], store, pause, onStart: (n) => { if (n === 1) pause.v = REC; } });
    assert.deepEqual(a.calls, [1], "the lane already running finishes through the pause; its dependent is not admitted");
    assert.equal(a.byIssue[1].outcome, "merged");
    assert.equal(a.byIssue[2].outcome, "held");
    assert.match(a.byIssue[2].detail, /paused \(release cut, until unpause\)/);
    assert.ok(a.updates.some((r) => r.outcome === "pause"), "a pause row");
    pause.v = null; // --unpause, then --resume
    const b = await run({ script: {}, issues: [2, 1], store, pause });
    assert.deepEqual(b.calls, [2]);
    assert.equal(b.byIssue[2].outcome, "merged");
  });

  it("an engine upgrade re-admit of a held (engine/env) issue in a paused batch stays pending", async () => {
    let v = "1.0.0"; const pause = { v: null };
    const r = await run({ script: { 1: [EE("boom"), EE("boom"), MERGED] }, issues: [1], pause,
      extra: { envHold: { maxMs: 120_000, watchMs: 30_000, version: () => v } },
      onRow: (row) => { if (row.issue === 1 && row.outcome === "held") { v = "1.0.1"; pause.v = REC; } } });
    assert.deepEqual(r.calls, [1, 1], "the upgrade would re-admit it, the pause keeps it pending");
    assert.equal(r.byIssue[1].outcome, "held");
  });

  it("a timed pause expires on its own (injected clock) and admission resumes", async () => {
    const pause = { v: { ...REC, expiresAt: new Date(1_000_000 + 600_000).toISOString() } };
    const clock = { t: 1_000_000 };
    const r = await run({ script: {}, issues: [2, 1], pause, clock, extra: { expirePause: () => { const p = pause.v; if (p && Date.parse(p.expiresAt) <= clock.t) { pause.v = null; return { ...p, ownerGone: false }; } return null; } } });
    assert.deepEqual(r.calls, [1, 2]);
    assert.ok(r.updates.some((x) => x.outcome === "pause-expired"));
    assert.ok(r.decisions.some((d) => /pause expired/.test(d.what)));
  });

  it("without getPause (or with no pause set) admission is unchanged", async () => {
    const r = await run({ script: {}, issues: [2, 1], extra: { getPause: null } });
    assert.deepEqual(r.calls, [1, 2]);
  });
});

// #5988: a backend.auth outage is probed every 5 min, rotated, escalated once at 30 min; hold expiry is paced and warned at T-30.
describe("#5988: auth outage probe and hold expiry", () => {
  const AUTH = { terminalReason: "deferred", code: "backend.auth", retryInSeconds: 56 * 3600, detail: "login failed" };
  const rot = (cur = { n: 1 }) => ({ accounts: [{ n: 1 }, { n: 2 }], current: () => cur.n, headroom: (ex) => [1, 2].some((n) => !(ex instanceof Map ? ex : new Map()).has(n)), resumeAt: (ex) => Math.max(0, ...[...(ex ?? new Map()).values()]) || null, isAccount: () => true,
    pick: ({ exclude } = {}) => { const ex = new Set([...(exclude instanceof Map ? exclude.keys() : exclude ?? [])].map(Number)); const a = [1, 2].find((n) => !ex.has(n)); return a ? { account: a } : { account: null }; }, markLimited: (n) => { cur.n = n === 1 ? 2 : 1; return true; } });

  it("login failure recovering at 10 min resumes within 5 min on the next account first, no operator action", async () => {
    const resumed = await (async () => {
      const c = { t: 5_000_000 }, s0 = c.t, ps = [], rows = [];
      const out = await orchestrate({ issues: [1], parallel: 1, pollMs: 1000, readBody: async () => "", trusted: () => true, now: () => c.t, store: memStore(), rotator: rot(),
        sleep: async (ms) => { c.t += Math.max(1, Number(ms) || 0); }, recovery: { maxAttempts: 1, mechanicalMaxAttempts: 3 },
        authProbe: async ({ account }) => { ps.push({ account, at: c.t - s0 }); return { ok: c.t - s0 >= 10 * 60000 }; },
        runOne: async () => { c.t += 1000; return c.t - s0 < 10 * 60000 ? AUTH : MERGED; }, onUpdate: (x) => rows.push({ ...x, at: c.t - s0 }) });
      return { out, ps, rows };
    })();
    assert.equal(resumed.out[0].outcome, "merged");
    assert.ok(Number.isInteger(resumed.ps[0].account), "the probe runs on the next rotator account, picked before the lane retries");
    const back = resumed.rows.find((x) => x.outcome === "merged");
    assert.ok(back && back.at <= 10 * 60000 + AUTH_PROBE_MS + 5000, "resumed within one probe interval of the recovery");
    assert.ok(!resumed.rows.some((x) => x.outcome === "auth-escalation"));
  });

  it("a 56 h outage pauses at most 30 min and escalates exactly once", async () => {
    const c = { t: 9_000_000 }, s0 = c.t, rows = [], esc = []; let k = 0;
    await orchestrate({ issues: [1], parallel: 1, pollMs: 1000, readBody: async () => "", trusted: () => true, now: () => c.t, store: memStore(), rotator: rot(),
      sleep: async (ms) => { c.t += Math.max(1, Number(ms) || 0); }, recovery: { maxAttempts: 1, mechanicalMaxAttempts: 3 },
      authProbe: async () => ({ ok: false }), onEscalate: async (e) => esc.push(e),
      runOne: async () => { c.t += 1000; return ++k <= 12 ? AUTH : MERGED; }, onUpdate: (x) => rows.push({ ...x, at: c.t - s0 }) });
    assert.equal(esc.length, 1);
    assert.equal(rows.filter((x) => x.outcome === "auth-escalation").length, 1);
    assert.ok(rows.find((x) => x.outcome === "auth-escalation").at <= AUTH_ESCALATE_MS + 2 * AUTH_PROBE_MS);
    assert.ok(c.t - s0 < 3 * 3600_000, "never a multi-hour pause");
  });

  it("expiry of 100 holds is announced once at T-30 and released at the controller's pace, not all at once", async () => {
    const issues = Array.from({ length: 100 }, (_, i) => i + 1), clock = { t: 2_000_000 };
    let held = new Set(issues), live = 0, peak = 0; const starts = [], release = clock.t + 20 * 60000;
    const info = Object.fromEntries(issues.map((n) => [n, { owner: "op", since: "x", expiresAt: new Date(clock.t + 20 * 60000).toISOString() }]));
    const rows = [];
    await orchestrate({ issues, parallel: 4, pollMs: 1000, readBody: async () => "", trusted: () => true, now: () => clock.t, store: memStore(),
      sleep: async (ms) => { clock.t += Math.max(1, Number(ms) || 0); }, recovery: { maxAttempts: 1, mechanicalMaxAttempts: 3 },
      getHeld: () => [...held], getHoldInfo: () => info,
      expireHolds: () => { if (clock.t < Date.parse(info[1].expiresAt) || !held.size) return []; const due = [...held].map((n) => ({ issue: n, owner: "op", since: "x" })); held = new Set(); return due; },
      runOne: async () => { live++; peak = Math.max(peak, live); starts.push({ live, since: clock.t - release }); clock.t += 1000; await Promise.resolve(); live--; return MERGED; }, onUpdate: (x) => rows.push(x) });
    assert.equal(rows.filter((x) => x.outcome === "hold-alert").length, 100, "one T-30 alert per hold");
    assert.ok(peak <= 4, `peak ${peak} never exceeds the controller's cap`);
    const early = starts.filter((x) => x.since < HOLD_RAMP_STEP_MS);
    assert.ok(early.length > 0 && early.every((x) => x.live === 1), "the first step after expiry admits one lane, not the parallel cap of 4");
    assert.equal(rows.filter((x) => x.outcome === "merged").length, 100);
  });
});

describe("#6008: hold and pause cover deferred retries and kept sandboxes", () => {
  const CAP = { terminalReason: "deferred", code: "sandbox.capacity", retryInSeconds: 30, detail: "no sandbox capacity" };
  it("a sandbox.capacity-deferred issue is not dispatched while held, including when its timer fires", async () => {
    const held = { v: [] };
    const r = await run({ script: { 1: [CAP, MERGED] }, issues: [1], extra: { getHeld: () => held.v }, onRow: (row) => { if (row.issue === 1 && row.outcome === "deferred") held.v = [1]; } });
    assert.deepEqual(r.calls, [1], "the retry timer fired (clock advanced) but the held issue was not dispatched");
    assert.notEqual(r.byIssue[1].outcome, "merged");
  });
  it("a sandbox.capacity-deferred issue is not dispatched while the batch is paused, including when its timer fires", async () => {
    const pause = { v: null };
    const r = await run({ script: { 1: [CAP, MERGED] }, issues: [1], pause, onRow: (row) => { if (row.issue === 1 && row.outcome === "deferred") pause.v = REC; } });
    assert.deepEqual(r.calls, [1]);
    assert.notEqual(r.byIssue[1].outcome, "merged");
  });
  it("a paused batch suspends its kept sandboxes; unpause lifts it", async () => {
    const pause = { v: null }, marks = [];
    const KEPT = { terminalReason: "deferred", code: "sandbox.unreachable", retryInSeconds: 60, detail: "kept for adopt", kept: { issue: 1, since: 1_000_000, phase: "implement" } };
    await run({ script: { 1: [KEPT, MERGED] }, issues: [1], pause, extra: { suspendLane: (n, on, why) => marks.push([n, on, why]) },
      onRow: (row) => { if (row.issue === 1 && row.outcome === "deferred") pause.v = REC; } });
    assert.deepEqual(marks, [[1, true, "paused"]]);
  });
});
