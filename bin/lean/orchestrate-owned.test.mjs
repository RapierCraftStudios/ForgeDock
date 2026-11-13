// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5471: --add/--requeue/dispatch skip an issue another live batch of the repo holds; --force overrides; status warns.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { sharedPendingLines } from "./schedd.mjs";
import { openBatch, ownerOf, dispatchOwner } from "./batch.mjs";
import { orchestrateFromCli, makeDispatchCheck } from "../engine-cli.mjs";

process.env.FORGEDOCK_SCHED_DIR = tmpDir("owned-sched-");
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const queued = (p) => p.catch((e) => { if (e?.code === "batch.not-hosted") return e.result; throw e; });
const seed = (root, id, { order = [5], running = {}, pending = [], results = {}, held = [], repo = "o/r" } = {}) => {
  const b = openBatch(root, id);
  b.writePlan({ v: 1, id, repo });
  b.store.save({ order, running, pending, results, notBefore: {} });
  if (held.length) b.holdIssues(held);
  return b;
};
const io = { gh: async (a) => { if (a[0] === "api") return "OWNER\n"; return JSON.stringify({ state: "OPEN", labels: [] }); } };

describe("cross-batch ownership (#5471)", () => {
  it("add skips an issue pending in another live batch of the repo, naming the owner; after the owner finishes it, B may add it", async () => {
    const root = tmpDir("owned-add-");
    seed(root, "bA", { pending: [5] });
    const b = seed(root, "bB", { order: [1], pending: [1] });
    const res = await queued(quiet(() => orchestrateFromCli(["--add", "bB", "5"], { batchRoot: root, io })));
    assert.deepEqual(res.added, []);
    assert.deepEqual(res.skipped.map((x) => [x.issue, x.reason]), [[5, "owned by bA"]]);
    assert.deepEqual(b.readAdded(), []);
    openBatch(root, "bA").store.save({ order: [5], running: {}, pending: [], results: { 5: { outcome: "merged" } }, notBefore: {} });
    const again = await queued(quiet(() => orchestrateFromCli(["--add", "bB", "5"], { batchRoot: root, io })));
    assert.deepEqual(again.added, [5]);
  });
  it("--force overrides the add skip; another repo's batch does not own", async () => {
    const root = tmpDir("owned-force-");
    seed(root, "bA", { pending: [5] });
    seed(root, "bC", { pending: [6], order: [6], repo: "o/other" });
    const b = seed(root, "bB", { order: [1], pending: [1] });
    const res = await queued(quiet(() => orchestrateFromCli(["--add", "bB", "5", "6", "--force", "dup ok"], { batchRoot: root, io })));
    assert.deepEqual(res.added, [5, 6]);
    assert.equal(ownerOf(root, "o/r", 6, "bB"), null);
    assert.deepEqual(b.readAdded(), [5, 6]);
  });
  it("requeue refuses an issue another live batch runs; a batch that only holds it does not own it (#5592)", async () => {
    const root = tmpDir("owned-requeue-");
    seed(root, "bA", { order: [5, 7], pending: [7], running: { 5: {} }, held: [7] });
    const b = seed(root, "bB", { order: [5, 7], results: { 5: { outcome: "needs-human" }, 7: { outcome: "needs-human" } } });
    assert.equal(ownerOf(root, "o/r", 7, "bB"), null, "held only: not an owner");
    const res = await queued(quiet(() => orchestrateFromCli(["--requeue", "bB", "5", "7", "--reason", "r"], { batchRoot: root, io })));
    assert.deepEqual(res.requeued, [7]);
    assert.deepEqual(res.refused.map((x) => [x.issue, x.reason]), [[5, "owned by bA"]]);
    assert.deepEqual(b.readRequeued().map((e) => e.issue), [7]);
  });
  it("#5592: held in A, force-started in B: B requeues it; A's refusal names B instead of a bare 'not terminal'", async () => {
    const root = tmpDir("owned-moved-");
    const a = seed(root, "bA", { order: [7], pending: [7], held: [7] });
    seed(root, "bB", { order: [7], results: { 7: { outcome: "needs-human" } } });
    const res = await queued(quiet(() => orchestrateFromCli(["--requeue", "bB", "7", "--reason", "r"], { batchRoot: root, io })));
    assert.deepEqual(res.requeued, [7]);
    seed(root, "bC", { order: [7], running: { 7: {} } });
    assert.deepEqual(a.requeue([7]).refused.map((x) => x.reason), ["not terminal: held here, run by bC; requeue it there"]);
  });
  it("#5597: held in A and nothing runs it elsewhere: --requeue in A releases the hold", async () => {
    const root = tmpDir("owned-release-");
    const a = seed(root, "bA", { order: [7, 8], pending: [7, 8], held: [7] });
    assert.deepEqual(a.requeue([7, 8]).requeued, [7]);
    assert.deepEqual(a.readHeld(), []);
  });
  it("dispatch defers an issue another batch runs (or holds pending with a lower id) and admits it once the owner is done", async () => {
    const root = tmpDir("owned-dispatch-");
    seed(root, "bA", { pending: [5] });
    openBatch(root, "bA");
    const check = (id) => makeDispatchCheck({ gh: async () => JSON.stringify({ state: "OPEN", labels: [] }), repo: "o/r", owner: (n) => dispatchOwner(root, "o/r", n, id) });
    const r = await check("bB")(5);
    assert.deepEqual([r?.outcome, r?.code, r?.detail], ["deferred", "batch.owned", "owned by bA"]);
    assert.equal(await check("bA")(5), null, "the lower id keeps it: no mutual deferral");
    openBatch(root, "bA").store.save({ order: [5], running: {}, pending: [], results: { 5: { outcome: "merged" } }, notBefore: {} });
    assert.equal(await check("bB")(5), null);
  });
  it("schedd status warns when two hosted batches share a pending issue", async () => {
    const statuses = { type: "status", pid: 1, batches: [{ id: "bA", running: true, pending: [5, 6] }, { id: "bB", running: true, pending: [5] }], unhosted: [] };
    const lines = sharedPendingLines(statuses.batches);
    assert.ok(lines.some((t) => /#5 is pending in 2 batches \(bA, bB\)/.test(t)), lines.join("\n"));
    assert.ok(!lines.some((t) => /#6 is pending/.test(t)));
  });
});
