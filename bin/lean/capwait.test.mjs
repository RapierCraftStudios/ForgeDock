// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** #4909: capacity wait as queue time. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeCapWait } from "./capwait.mjs";
import { orchestrate } from "./orchestrate.mjs";

describe("makeCapWait (#4909)", () => {
  it("blocks a refused issue only while the pool reports no free slot, and banks the wait as queue time", () => {
    let t = 1000;
    const w = makeCapWait({ now: () => t });
    assert.equal(w.blocked(1, { free: 0 }), false, "never refused: not blocked");
    w.refused(1);
    assert.equal(w.blocked(1, { free: 0 }), true);
    assert.equal(w.blocked(1, null), false, "unknown capacity falls back to the retry-in timer");
    assert.equal(w.blocked(1, { online: 2 }), false);
    t += 5000;
    assert.equal(w.blocked(1, { free: 1 }), false);
    assert.equal(w.admitted(1), 5000);
    assert.deepEqual(w.take(1, { heavy: 7 }), { heavy: 7, queue: 5000 });
    assert.equal(w.take(1, { heavy: 7 }).queue, undefined, "banked once");
    assert.equal(w.take(2, undefined), undefined);
  });
});

describe("at pool capacity a lane waits for a free slot (#4909)", () => {
  it("a capacity-refused lane does not relaunch until free > 0; the wait is its queue time", async () => {
    const c = { t: 1_000_000 };
    let sleeps = 0, freeAt = Infinity;
    const sleep = async (ms) => { await new Promise((r) => setImmediate(r)); c.t += ms; if (++sleeps >= freeAt) free = 1; };
    let free = 1, launches = 0, refusedAt = null, relaunchFree = null;
    const rows = await orchestrate({ issues: [1], parallel: 1, now: () => c.t, sleep, pollMs: 1000, readBody: async () => "",
      remote: { max: 1, isRemote: () => true, capacity: () => ({ free, at: c.t }) },
      runOne: async () => {
        launches++;
        if (launches === 1) { refusedAt = c.t; free = 0; freeAt = sleeps + 3; return { terminalReason: "deferred", code: "sandbox.capacity", retryInSeconds: 60, detail: "HTTP 503" }; }
        relaunchFree = free;
        return { terminalReason: "merged", pr: 101 };
      } });
    assert.equal(rows[0].outcome, "merged");
    assert.equal(launches, 2);
    assert.ok(relaunchFree > 0, "relaunched only with a free slot");
    assert.ok(c.t - refusedAt < 60000, "not the blind 60s retry");
    assert.ok(c.t - refusedAt >= 3000, "waited for the slot");
    assert.ok(Number.isFinite(rows[0].waits?.queue) && rows[0].waits.queue >= 0, "wait recorded as queue time");
  });
});
