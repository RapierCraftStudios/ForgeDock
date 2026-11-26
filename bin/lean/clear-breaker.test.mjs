// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5964: hosted --clear-breaker is a durable, time-scoped request the runner consumes on its next pass, however long that is.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { decideClear } from "./clear-breaker.mjs";
import { openBatch } from "./batch.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { runBatch } from "../engine-cli.mjs";

const memStore = () => { let st = null; return { load: () => (st ? JSON.parse(JSON.stringify(st)) : null), save: (s) => { st = JSON.parse(JSON.stringify(s)); }, log: () => {}, peek: () => st }; };
const EE = (detail) => ({ terminalReason: "engine-error", detail });
const MERGED = { terminalReason: "merged", pr: 9 };

/** A runner whose every pass costs 12 s of injected time; `req` is the pending request `at` (or null), made `reqAfterMs` after the trip. */
const slowRun = async ({ reqAfterMs }) => {
  let t = 1_000_000, tripAt = null, req = null, consumed = 0; const acks = [], calls = [], ac = new AbortController();
  const script = { 1: [EE("boom A")], 2: [EE("boom B")], 3: [MERGED] };
  const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async () => "", now: () => t, store: memStore(), pollMs: 12000, breaker: { errors: 2, window_min: 10 }, signal: ac.signal,
    sleep: async (ms) => { t += Math.max(12000, Number(ms) || 0); },
    runOne: async (n) => { calls.push(n); t += 12000; return script[n][0]; },
    onUpdate: (u) => { if (u.outcome === "breaker" && tripAt === null) { tripAt = t; req = tripAt + reqAfterMs; } },
    getClearBreaker: () => req, consumeClearBreaker: () => { req = null; consumed++; if (reqAfterMs < 0) ac.abort(); }, // #6042: a trip kept closed by a stale request waits for an operator; the test ends it
    ackClearBreaker: (i) => acks.push(i) });
  return { rows, acks, calls, consumed };
};

describe("#5964 decideClear", () => {
  it("clears a trip at or before the request; never a later one; boolean is legacy; nothing without a request", () => {
    assert.deepEqual(decideClear({ tripped: { at: 100 }, requestAt: 150 }), { clear: true, stale: false });
    assert.deepEqual(decideClear({ tripped: { at: 100 }, requestAt: 100 }), { clear: true, stale: false });
    assert.deepEqual(decideClear({ tripped: { at: 200 }, requestAt: 150 }), { clear: false, stale: true });
    assert.deepEqual(decideClear({ tripped: { at: 200 }, requestAt: true }), { clear: true, stale: false });
    assert.deepEqual(decideClear({ tripped: null, requestAt: 150 }), { clear: true, stale: false });
    for (const requestAt of [null, false, undefined, NaN, "x"]) assert.deepEqual(decideClear({ tripped: { at: 1 }, requestAt }), { clear: false, stale: false }, String(requestAt));
  });
});

describe("#5964 runner pass", () => {
  it("slow pass: request survives and next pass clears (a request 1 s into a 12 s pass is cleared and acked on the next pass, and admissions resume)", async () => {
    const r = await slowRun({ reqAfterMs: 1000 });
    assert.ok(r.acks.some((a) => a.cleared === true), "acked a real clear");
    assert.equal(r.consumed, 1);
    assert.ok(r.calls.includes(3), "issue 3 was admitted after the clear");
  });

  it("a request older than a later trip does not clear it (stale), and is consumed", async () => {
    const r = await slowRun({ reqAfterMs: -5000 });
    assert.equal(r.acks.some((a) => a.cleared === true), false);
    assert.equal(r.consumed, 1);
    assert.equal(r.calls.includes(3), false, "the later trip stays closed");
  });
});

describe("#5964 slow pass over the real batch request file", () => {
  it("slow pass: a request made 1 s into a 12 s pass stays on disk, the next pass clears tripped, acks, consumes it, and admissions resume", async () => {
    const root = tmpDir("clrbrk-"); const b = openBatch(root, "b3"); b.store.save({ id: "b3" });
    let t = 1_000_000, tripped = false, requested = false, release = null, onDiskAtNextPass = null; const calls = [], acks = [];
    const gate = new Promise((r) => { release = r; });
    const script = { 1: EE("boom A"), 2: EE("boom B"), 3: null, 4: MERGED };
    const rows = await orchestrate({ issues: [1, 2, 3, 4], parallel: 3, readBody: async () => "", now: () => t, store: memStore(), pollMs: 12000, breaker: { errors: 2, window_min: 10 },
      sleep: async () => {
        if (tripped && !requested) { requested = true; b.requestClearBreaker(); t += 12000; release(); } // the request lands during a 12 s pass
        else t += 12000;
      },
      runOne: async (n) => { calls.push(n); if (n === 3) { await gate; return MERGED; } return script[n]; },
      onUpdate: (u) => { if (u.outcome === "breaker") tripped = true; },
      getClearBreaker: () => { if (requested && onDiskAtNextPass === null) onDiskAtNextPass = existsSync(join(root, "b3", "clear-breaker")); return b.peekClearBreaker(); },
      consumeClearBreaker: b.readClearBreaker, ackClearBreaker: (i) => { acks.push(i); b.ackClearBreaker(i); } });
    assert.equal(onDiskAtNextPass, true, "the request survived until the runner's next pass");
    assert.equal(acks.some((a) => a.cleared === true), true, "tripped was cleared and acked");
    assert.equal(b.readClearBreakerAck().cleared, true);
    assert.equal(existsSync(join(root, "b3", "clear-breaker")), false, "consumed after the decision");
    assert.ok(calls.includes(4), "admissions resumed (issue 4 ran) with no restart");
    assert.equal(rows.find((r) => r.issue === 4)?.outcome, "merged");
  });
});

describe("#5964 batch request file and CLI", () => {
  it("peekClearBreaker returns the request time without deleting it; readClearBreaker consumes", () => {
    const root = tmpDir("clrbrk-"); const b = openBatch(root, "b1"); b.store.save({ id: "b1" });
    assert.equal(b.peekClearBreaker(), null);
    const at = b.requestClearBreaker();
    assert.equal(b.peekClearBreaker(), at);
    assert.equal(existsSync(join(root, "b1", "clear-breaker")), true, "peek leaves the file");
    assert.equal(b.readClearBreaker(), true);
    assert.equal(b.peekClearBreaker(), null);
  });

  it("unhosted (no daemon) batch keeps the direct state.json rewrite", async () => {
    const root = tmpDir("clrbrk-"); const b = openBatch(root, "b2"); b.store.save({ id: "b2", breaker: { at: 1 }, errorTimes: [1] }); writeFileSync(join(root, "b2", "plan.json"), "{}");
    const lines = [];
    const r = await runBatch({ argv: ["--clear-breaker", "b2"], deps: { batchRoot: root, noDaemon: true }, sink: { line: (l) => lines.push(l) } });
    assert.equal(r.cleared, true);
    assert.equal(b.store.load().breaker, null);
    assert.match(lines[0], /breaker cleared/);
  });
});
