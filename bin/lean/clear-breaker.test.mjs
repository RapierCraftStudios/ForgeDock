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
  let t = 1_000_000, tripAt = null, req = null, consumed = 0; const acks = [], calls = [];
  const script = { 1: [EE("boom A")], 2: [EE("boom B")], 3: [MERGED] };
  const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async () => "", now: () => t, store: memStore(), pollMs: 12000, breaker: { errors: 2, window_min: 10 },
    sleep: async (ms) => { t += Math.max(12000, Number(ms) || 0); },
    runOne: async (n) => { calls.push(n); t += 12000; return script[n][0]; },
    onUpdate: (u) => { if (u.outcome === "breaker" && tripAt === null) { tripAt = t; req = tripAt + reqAfterMs; } },
    getClearBreaker: () => req, consumeClearBreaker: () => { req = null; consumed++; }, ackClearBreaker: (i) => acks.push(i) });
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
  it("a request 1 s into a 12 s pass survives, is cleared and acked on the next pass, and admissions resume", async () => {
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
