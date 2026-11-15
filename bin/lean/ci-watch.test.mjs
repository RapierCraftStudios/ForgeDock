// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchCi, ciSignal, failedStepsOf, cancelDecision, eventLog } from "./ci-watch.mjs";

/** Fake clock: sleep advances time, never waits. */
const clock = () => { const c = { t: 0 }; c.sleep = async (ms) => { c.t += ms; }; c.now = () => c.t; return c; };
const JOBS = [{ name: "build", status: "in_progress", conclusion: null, steps: [{ name: "setup", conclusion: "success" }, { name: "pnpm test", conclusion: "failure", completed_at: "2026-11-15T10:00:00Z" }, { name: "after", conclusion: null }] }];

describe("watchCi (#5692)", () => {
  it("fallback: an in_progress job with one failed step yields step_failed on the next poll", async () => {
    const c = clock(); let polls = 0;
    const io = { runsForSha: async () => [{ id: 9, status: "in_progress" }], jobsOf: async () => (++polls < 2 ? [{ ...JOBS[0], steps: [{ name: "pnpm test", conclusion: null }] }] : JOBS) };
    const it_ = watchCi({ repo: "o/r", sha: "abc", io, sleep: c.sleep, now: c.now });
    const e = (await it_.next()).value;
    assert.equal(e.type, "step_failed"); assert.equal(e.step, "pnpm test"); assert.equal(e.job, "build"); assert.equal(e.ts, "2026-11-15T10:00:00Z"); assert.equal(e.source, "jobs-api");
    assert.equal(polls, 2); assert.equal(c.t, 15000, "one 15 s poll interval");
    await it_.return();
  });
  it("fallback: the same failed step is yielded once; finished jobs and runs are not synthesized", async () => {
    assert.deepEqual(failedStepsOf([{ ...JOBS[0], status: "completed" }]), []);
    assert.equal(failedStepsOf(JOBS).length, 1);
    const c = clock(); let n = 0;
    const io = { runsForSha: async () => [{ id: 9, status: "in_progress" }, { id: 8, status: "completed" }], jobsOf: async (id) => { assert.equal(id, 9); return JOBS; } };
    const sig = ciSignal({ repo: "o/r", sha: "abc", io, sleep: async (ms) => { c.t += ms; if (++n > 3) await new Promise(() => {}); }, now: c.now });
    assert.equal((await sig.next()).type, "step_failed");
    const second = await Promise.race([sig.next(), new Promise((r) => setTimeout(() => r("none"), 20))]);
    assert.equal(second, "none"); sig.stop();
  });
  it("router: yields step_failed/test_failed from the long-poll when it has events for the sha, and resumes from the cursor", async () => {
    const c = clock(), calls = [];
    const batches = [{ events: [{ seq: 1, type: "step_started" }, { seq: 2, type: "step_failed", step: "lint", lines: ["x"] }], next: 2 }, { events: [{ seq: 3, type: "test_failed", test: "t" }], next: 3 }];
    const io = { ciEventsWait: async (q) => { calls.push(q.since); return batches.shift() ?? { events: [], next: 3 }; }, runsForSha: async () => { throw new Error("must not poll the jobs API"); } };
    const it_ = watchCi({ repo: "o/r", sha: "abc", io, sleep: c.sleep, now: c.now });
    assert.equal((await it_.next()).value.step, "lint");
    assert.equal((await it_.next()).value.test, "t");
    assert.deepEqual(calls.slice(0, 2), [0, 2]); await it_.return();
  });
  it("router configured but silent for the sha: falls back to the jobs API", async () => {
    const c = clock();
    const io = { ciEventsWait: async () => ({ events: [], next: 0 }), runsForSha: async () => [{ id: 1, status: "queued" }], jobsOf: async () => JOBS };
    const it_ = watchCi({ repo: "o/r", sha: "abc", io, sleep: c.sleep, now: c.now });
    assert.equal((await it_.next()).value.source, "jobs-api"); await it_.return();
  });
  it("an unreachable io never throws", async () => {
    const c = clock(); let n = 0;
    const io = { runsForSha: async () => { throw new Error("HTTP 502"); } };
    const sig = ciSignal({ repo: "o/r", sha: "a", io, sleep: async (ms) => { c.t += ms; if (++n > 2) await new Promise(() => {}); }, now: c.now });
    assert.equal(await Promise.race([sig.next(), new Promise((r) => setTimeout(() => r("quiet"), 20))]), "quiet"); sig.stop();
  });
});

describe("cancelDecision (#5692)", () => {
  const setup = { type: "step_failed", step: "pnpm install", lines: ["ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile"] };
  const code = { type: "test_failed", test: "a.test.ts > adds", lines: ["AssertionError: expected 1 to be 2"] };
  it("cancels only for a downstream class under policy deterministic", () => {
    assert.equal(cancelDecision({ ...setup, class: "deterministic-setup" }, { fail_fast: "deterministic" }).action, "cancel");
    assert.equal(cancelDecision({ ...setup, class: "generated-artifact-stale" }, "deterministic").action, "cancel");
    assert.equal(cancelDecision(code, "deterministic").action, "continue");
    for (const class_ of ["code", "infra", "flaky-suspect"]) assert.equal(cancelDecision({ ...code, class: class_ }, "deterministic").action, "continue");
    for (const policy of [undefined, "off", { fail_fast: "off" }, {}]) assert.equal(cancelDecision({ ...setup, class: "deterministic-setup" }, policy).action, "continue");
  });
  it("eventLog carries the test id, step and lines to the builder", () => {
    assert.equal(eventLog({ test: "t1", step: "s", lines: ["l1", "l2"] }), "test: t1\nstep: s\nl1\nl2");
  });
});
