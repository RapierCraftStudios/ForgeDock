// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5975: a batch-level pause stops admission for every issue (dependency merge, engine/env re-admit, expiry), never a running lane.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";

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
  it("a dependency merge in a paused batch does not dispatch the dependent; after --unpause it does; the running lane completes", async () => {
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
