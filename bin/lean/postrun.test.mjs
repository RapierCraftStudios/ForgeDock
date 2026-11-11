// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5437: the post-run job queue.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makePostRun } from "./postrun.mjs";

const mk = (o = {}) => { const events = [], sleeps = []; return { events, sleeps, q: makePostRun({ ev: (e) => events.push(e), sleep: async (ms) => { sleeps.push(ms); }, ...o }) }; };

describe("#5437 makePostRun", () => {
  it("runs jobs in order and records POSTRUN_OK for each", async () => {
    const { q, events } = mk(), order = [];
    q.add("a", async () => order.push("a")); q.add("b", async () => order.push("b"));
    await q.run();
    assert.deepEqual(order, ["a", "b"]);
    assert.deepEqual(events.map((e) => `${e.event}:${e.job}`), ["POSTRUN_OK:a", "POSTRUN_OK:b"]);
    assert.deepEqual(q.pending(), []);
  });
  it("is idempotent: a second run does not re-run finished jobs, and concurrent callers share one run", async () => {
    const { q } = mk(); let n = 0;
    q.add("a", async () => { n++; });
    await Promise.all([q.run(), q.run()]); await q.run();
    assert.equal(n, 1);
  });
  it("retries a failing job with backoff and records the success", async () => {
    const { q, events, sleeps } = mk(); let n = 0;
    q.add("flaky", async () => { if (++n < 3) throw new Error("boom"); });
    await q.run();
    assert.equal(n, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
    assert.equal(events.at(-1).event, "POSTRUN_OK"); assert.equal(events.at(-1).attempt, 3);
  });
  it("a job that keeps failing is recorded POSTRUN_FAILED, never thrown, and later jobs still run", async () => {
    const { q, events } = mk(); let later = false;
    q.add("bad", async () => { throw new Error("nope"); }); q.add("later", async () => { later = true; });
    await q.run();
    assert.equal(later, true);
    const f = events.find((e) => e.event === "POSTRUN_FAILED");
    assert.equal(f.job, "bad"); assert.equal(f.attempts, 3); assert.match(f.error, /nope/);
  });
});
