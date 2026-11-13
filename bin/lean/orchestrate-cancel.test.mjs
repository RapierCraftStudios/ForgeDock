// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5241: --cancel --stop-remote confirms or reports each lane, releases its lease; dead-lease requeue; active-batch skip.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { openBatch, activeBatchOf, cancelledOwners } from "./batch.mjs";
import { clearLease } from "./lanelock.mjs";
import { providerLanes } from "./execution.mjs";
import { orchestrateFromCli } from "../engine-cli.mjs";

process.env.FORGEDOCK_SCHED_DIR = tmpDir("cancel-sched-");
const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); }
};
const clock = () => { const c = { t: 1_000_000 }; return { now: () => c.t, tick: (ms) => { c.t += ms; } }; };

describe("cancel --stop-remote teardown (#5241)", () => {
  it("retries a stop that was not accepted, reports a lane still running after the timeout, then releases its lease when it ends", async () => {
    let cancel = null, saved = null, release;
    const store = { load: () => saved, save: (s) => { saved = s; }, log: () => {} };
    const gate = new Promise((r) => { release = r; });
    const { now, tick } = clock();
    const tries = [], released = [], rows = [];
    const done = orchestrate({ issues: [7], parallel: 1, pollMs: 5, now, stopRetryMs: 1000, stopTimeoutMs: 5000, readBody: async () => "", store, getCancelled: () => cancel, onUpdate: (r) => rows.push(r),
      stopLane: (n, rec) => { tries.push(n); rec.stopNote = "the pool does not support stop (404/405)"; return false; },
      releaseLease: async (n) => { released.push(n); },
      runOne: async (n, _l, ctx) => { ctx.onStart?.({ remote: true, handle: { id: "sbx" } }); await gate; return { terminalReason: "deferred", code: "run.interrupted" }; } });
    await until(() => saved?.running?.[7]);
    cancel = { at: "2026-01-01T00:00:00Z", reason: "operator", stopRemote: true };
    await until(() => tries.length >= 1);
    tick(1500); await until(() => tries.length >= 2); // retried: the first stop was refused
    tick(6000); await until(() => rows.some((r) => /#7 not confirmed stopped/.test(r.detail ?? "")));
    assert.match(rows.find((r) => /not confirmed stopped/.test(r.detail ?? "")).detail, /404\/405/);
    assert.deepEqual(released, [], "a lane still running keeps its lease");
    release(); await done;
    assert.deepEqual(released, [7], "the ended lane's lease is released");
  });

  it("stopLane records why a lane could not be stopped on its record", async () => {
    const provider = { name: "p", idFor: (n) => `s${n}`, stop: async () => false, stopReason: () => "the pool does not support stop (404/405)" };
    const lanes = providerLanes({ provider, laneArgs: () => [], ledgerFor: () => null });
    const rec = { handle: { id: "s1" } };
    assert.equal(await lanes.stopLane(1, rec), false);
    assert.match(rec.stopNote, /404\/405/);
  });
});

describe("clearLease (#5241)", () => {
  const mk = (lease) => { const st = { lease, phase: "x" }; return { st, projector: { readState: async () => st, writeState: async (_n, s) => { Object.assign(st, s); } } }; };
  it("clears a lease the guard accepts, keeps one it refuses, and no-ops without one", async () => {
    const a = mk({ by: "core_a", until: 9e15 });
    assert.equal(await clearLease({ projector: a.projector, issue: 1 }), true);
    assert.equal(a.st.lease, null);
    const b = mk({ by: "core_b", until: 9e15 });
    assert.equal(await clearLease({ projector: b.projector, issue: 1, shouldClear: () => false }), false);
    assert.equal(b.st.lease.by, "core_b");
    assert.equal(await clearLease({ projector: mk(null).projector, issue: 1 }), false);
  });
});

describe("dead-lease requeue and active-batch lookup (#5241)", () => {
  const seed = (root, id, { repo = "o/r", order = [5], running = {}, pending = [], notBefore = {}, cancelled = false, report = false } = {}) => {
    const b = openBatch(root, id);
    b.writePlan({ v: 1, id, repo });
    b.store.save({ order, running, pending, results: {}, notBefore });
    if (cancelled) b.requestCancel({});
    if (report) b.writeReport({ done: true });
    return b;
  };
  it("requeue accepts a pending issue deferred on a lease whose holder is a cancelled batch, and still refuses an ordinary deferral", () => {
    const root = tmpDir("cancel-requeue-");
    seed(root, "bcancel", { cancelled: true, running: { 5: { remote: true } } });
    const live = seed(root, "blive", { pending: [5, 6], order: [5, 6], notBefore: { 5: Date.now() + 1e6, 6: Date.now() + 1e6 } });
    const r = live.requeue([5, 6]);
    assert.deepEqual(r.requeued, [5]);
    assert.deepEqual(r.refused, [{ issue: 6, reason: "not terminal" }]);
  });
  it("is refused while a live batch runs the issue, or when no cancelled batch owns it", () => {
    const root = tmpDir("cancel-requeue2-");
    seed(root, "bcancel", { cancelled: true });
    seed(root, "bother", { running: { 5: {} } });
    const live = seed(root, "blive", { pending: [5], notBefore: { 5: Date.now() + 1e6 } });
    assert.deepEqual(cancelledOwners(root, "o/r", 5, "blive"), []);
    assert.equal(live.requeue([5]).refused[0].reason, "not terminal");
  });
  it("activeBatchOf names an unfinished, uncancelled batch of the same repo; not a finished, cancelled, stale or other-repo one", () => {
    const root = tmpDir("cancel-active-");
    seed(root, "bpend", { pending: [5] });
    assert.equal(activeBatchOf(root, "o/r", 5), "bpend");
    assert.equal(activeBatchOf(root, "o/other", 5), null);
    assert.equal(activeBatchOf(root, "o/r", 5, { now: Date.now() + 4 * 3600e3 }), null, "stale");
    openBatch(root, "bpend").writeReport({ done: true });
    assert.equal(activeBatchOf(root, "o/r", 5), null, "finished");
    const root2 = tmpDir("cancel-active2-");
    seed(root2, "bc", { pending: [5], cancelled: true });
    assert.equal(activeBatchOf(root2, "o/r", 5), null, "cancelled");
  });
});

describe("orchestrate start skips issues of another active batch (#5241)", () => {
  const mkDeps = (root, batchId, ran) => ({ dir: tmpDir("active-run-"), batchRoot: root, batchId, allowTmpfs: true, emitTelemetry: async () => {}, io: { gh: async () => "o/r\n" }, sched: null,
    leanIo: { gh: async (a) => (a.includes("milestone") ? JSON.stringify({ milestone: null }) : JSON.stringify({ body: "" })), git: async (a) => (a[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : "") },
    decide: () => {}, orchestration: { breaker: null, maxDeferrals: 3, globalParallel: null },
    leanModule: { runCore: async (o) => { ran.push(o.issue); return { terminalReason: "merged", pr: 50 + o.issue }; } } });
  const run = async (argv, deps) => { const lines = []; const l = console.log; console.log = (...a) => lines.push(a.join(" ")); try { return { res: await orchestrateFromCli(argv, deps), lines }; } finally { console.log = l; } };

  it("skips the issue naming the batch, runs the rest, and --force starts it anyway", async () => {
    const root = tmpDir("active-cli-");
    const other = openBatch(root, "bother");
    other.writePlan({ v: 1, id: "bother", repo: "o/r" });
    other.store.save({ order: [1], running: { 1: { pid: 1 } }, pending: [], results: {} });
    const ran = [];
    const a = await run(["1", "2", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], mkDeps(root, "bnew", ran));
    assert.match(a.lines.join("\n"), /skipped: #1 is already in active batch bother/);
    assert.deepEqual(ran, [2]);
    assert.deepEqual(openBatch(root, "bnew").readPlan().argv, ["2", "--parallel", "1", "--repo", "o/r", "--no-prefilter"]);
    const ran2 = [];
    await run(["1", "--parallel", "1", "--repo", "o/r", "--no-prefilter", "--force", "sibling batch is dead"], mkDeps(root, "bforce", ran2));
    assert.deepEqual(ran2, [1]);
    await assert.rejects(run(["1", "--repo", "o/r", "--no-prefilter"], mkDeps(root, "bnone", [])), /every issue is already in an active batch \(bother\)/);
  });
});

describe("--requeue of a lease-deferred pending issue (#5241)", () => {
  it("releases the deferral wait so the next pass relaunches it at once", async () => {
    let saved = null, entries = [];
    const store = { load: () => saved, save: (s) => { saved = s; }, log: () => {} };
    const runs = [];
    const done = orchestrate({ issues: [9], parallel: 1, pollMs: 5, readBody: async () => "", store, getRequeued: () => entries,
      runOne: async (n) => {
        runs.push(n);
        return runs.length === 1 ? { terminalReason: "deferred", code: "lease-held", detail: `issue 9 leased by core_x until ${new Date(Date.now() + 3600e3).toISOString()}` } : { terminalReason: "merged", pr: 1 };
      } });
    await until(() => Number.isFinite(saved?.notBefore?.[9]));
    entries = [{ issue: 9, reason: "dead lease", by: "operator", at: "2026-01-01T00:00:00Z" }];
    const rows = await done;
    assert.deepEqual(runs, [9, 9]);
    assert.equal(rows.find((r) => r.issue === 9).outcome, "merged");
  });

  // #5654: an interrupted or engine-error lane releases its own lease so the requeue is not deferred as lease.held
  it("releases the lease of a resumed run whose lane is gone, and re-dispatches it", async () => {
    let saved = { v: 1, order: [9], running: { 9: { startedAt: 1, pid: 4242 } }, results: {}, pending: [] };
    const store = { load: () => saved, save: (s) => { saved = s; }, log: () => {} };
    const released = [], ran = [], order = [];
    await orchestrate({ issues: [9], parallel: 1, pollMs: 5, readBody: async () => "", store, adopt: async () => null,
      releaseLease: async (n) => { released.push(n); order.push("release"); },
      runOne: async (n) => { ran.push(n); order.push("run"); return { terminalReason: "merged", pr: 1 }; } });
    assert.deepEqual(released, [9]);
    assert.deepEqual(ran, [9]);
    assert.equal(order[0], "release", "the lease goes before the issue is dispatched again");
  });

  it("releases the lease of a lane that ends in engine-error", async () => {
    const released = [];
    const store = { load: () => null, save: () => {}, log: () => {} };
    let calls = 0;
    await orchestrate({ issues: [2], parallel: 1, pollMs: 5, readBody: async () => "", store, releaseLease: async (n) => { released.push(n); },
      runOne: async () => (++calls === 1 ? { terminalReason: "engine-error", detail: "boom" } : { terminalReason: "merged", pr: 2 }) });
    assert.deepEqual(released, [2]);
  });

  it("requeues an interrupted lane at once (no backoff) after releasing its lease", async () => {
    const released = [], store = { load: () => null, save: () => {}, log: () => {} };
    let calls = 0;
    const t0 = Date.now();
    await orchestrate({ issues: [3], parallel: 1, pollMs: 5, readBody: async () => "", store, releaseLease: async (n) => { released.push(n); },
      runOne: async () => (++calls === 1 ? { terminalReason: "deferred", code: "run.interrupted", detail: "SIGTERM" } : { terminalReason: "merged", pr: 3 }) });
    assert.deepEqual(released, [3]);
    assert.equal(calls, 2);
    assert.ok(Date.now() - t0 < 10000, "re-dispatched without the 120s deferral backoff");
  });
});
