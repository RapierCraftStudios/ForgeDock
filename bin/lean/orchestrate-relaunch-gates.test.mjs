// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6081: relaunch, recovery and requeue honour holds and pauses like fresh admission; an operator-stopped held lane is a hold, not an engine-error.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";

const memStore = () => { let st = null; return { load: () => (st ? JSON.parse(JSON.stringify(st)) : null), save: (s) => { st = JSON.parse(JSON.stringify(s)); }, log: () => {} }; };
const EE = (detail) => ({ terminalReason: "engine-error", detail });
const STOPPED = EE("lane pid 4242 exited without a result; see lanes/1.log");
const MERGED = { terminalReason: "merged", pr: 9 };
const REC = { owner: "op@h", since: "2026-01-01T00:00:00.000Z", expiresAt: null, reason: "host reserved", ownerPid: null, ownerHost: null };

const run = ({ script, issues = [1], store = memStore(), held = { v: [] }, pause = { v: null }, onStart = () => {}, extra = {}, clock = { t: 1_000_000 } }) => {
  const calls = [], updates = [];
  const p = orchestrate({ issues, parallel: 2, pollMs: 1000, readBody: async () => "", trusted: () => true, now: () => clock.t, store,
    sleep: async (ms) => { clock.t += Math.max(1, Number(ms) || 0); },
    getHeld: () => held.v, getPause: () => pause.v, recovery: { maxAttempts: 1, mechanicalMaxAttempts: 3 },
    breaker: { errors: 2, window_min: 30 },
    runOne: async (n) => { calls.push(n); clock.t += 1000; onStart(n); const l = script[n] ?? [MERGED]; return l[Math.min(calls.filter((c) => c === n).length - 1, l.length - 1)]; },
    onUpdate: (r) => updates.push(r), ...extra });
  return p.then((rows) => ({ rows, calls, updates, byIssue: Object.fromEntries(rows.map((r) => [r.issue, r])) }));
};

describe("#6081: relaunch gates", () => {
  it("held while running, then engine-error: no relaunch until --release", async () => {
    const store = memStore(), held = { v: [] };
    const a = await run({ script: { 1: [EE("boom"), MERGED] }, store, held, onStart: (n) => { if (n === 1) held.v = [1]; } });
    assert.deepEqual(a.calls, [1], "the relaunch waits for the release");
    assert.equal(a.byIssue[1].outcome, "held");
    held.v = [];
    const b = await run({ script: { 1: [MERGED] }, store, held });
    assert.deepEqual(b.calls, [1]);
    assert.equal(b.byIssue[1].outcome, "merged");
  });

  it("a batch pause blocks the engine-error relaunch; the running lane still finishes", async () => {
    const store = memStore(), pause = { v: null };
    const a = await run({ script: { 1: [EE("boom"), MERGED] }, store, pause, onStart: (n) => { if (n === 1) pause.v = REC; } });
    assert.deepEqual(a.calls, [1]);
    assert.equal(a.byIssue[1].outcome, "held");
    pause.v = null;
    const b = await run({ script: { 1: [MERGED] }, store, pause });
    assert.equal(b.byIssue[1].outcome, "merged");
  });

  it("an operator-stopped held lane is a hold row, not an engine-error, and never counts toward the breaker", async () => {
    const held = { v: [] };
    const r = await run({ issues: [1, 2, 3], script: { 1: [STOPPED], 2: [STOPPED], 3: [MERGED] }, held,
      onStart: (n) => { if (n === 1 || n === 2) held.v = [1, 2]; } });
    assert.ok(!r.updates.some((u) => u.outcome === "breaker"), "no breaker trip");
    assert.ok(!r.updates.some((u) => u.outcome === "engine-error"), "no engine-error row");
    assert.ok(r.updates.some((u) => u.issue === 1 && u.outcome === "hold" && /stopped/.test(u.detail)));
    assert.equal(r.byIssue[1].outcome, "held");
    assert.equal(r.byIssue[3].outcome, "merged");
  });
});
