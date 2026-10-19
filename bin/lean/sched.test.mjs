// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { openSched, priorityFromLabels } from "./sched.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { schedFromCli } from "../engine-cli.mjs";

const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const until = async (cond, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 2)); }
};
// Injected pids and clock: `live` is the set of pids the registry sees as alive.
const world = () => {
  const live = new Set(), clock = { t: 1_000_000 };
  const dir = tmpDir("sched-");
  const handle = (pid, extra = {}) => { live.add(pid); return openSched(dir, { pid, alive: (p) => live.has(p), now: () => ++clock.t, ...extra }); };
  return { dir, live, handle };
};

describe("host lane registry (#4191)", () => {
  it("priorityFromLabels: priority:P<n> or bare P<n>, lowest wins, unlabelled = P2", () => {
    assert.equal(priorityFromLabels(["priority:P0"]), 0);
    assert.equal(priorityFromLabels([{ name: "P1" }, { name: "bug" }]), 1);
    assert.equal(priorityFromLabels(["priority:P3", "p1", "Priority:P2"]), 1);
    assert.equal(priorityFromLabels(["bug", "P", "priority:high", "XP0"]), 2);
    assert.equal(priorityFromLabels([]), 2);
    assert.equal(priorityFromLabels(undefined), 2);
  });

  it("grants within the cap in (priority, FIFO) order; a P0 queued last is granted next", () => {
    const { handle } = world();
    const a = handle(101), b = handle(102), c = handle(103);
    const e = (batch, issue, priority) => ({ batch, repo: "o/r", issue, priority });
    assert.equal(a.tryAcquire("A#1", e("A", 1, 2), 2).ok, true);
    assert.equal(b.tryAcquire("B#1", e("B", 1, 2), 2).ok, true);
    const r = b.tryAcquire("B#2", e("B", 2, 2), 2);
    assert.equal(r.ok, false);
    assert.match(r.reason, /host cap 2/);
    a.offer([{ key: "A#2", ...e("A", 2, 3) }]);
    c.offer([{ key: "C#9", ...e("C", 9, 0) }]); // P0, offered last
    assert.deepEqual(a.list().queue.map((q) => q.key), ["C#9", "B#2", "A#2"]);
    a.release("A#1");
    assert.equal(b.tryAcquire("B#2", e("B", 2, 2), 2).ok, false, "the freed slot belongs to the P0");
    assert.equal(c.tryAcquire("C#9", e("C", 9, 0), 2).ok, true);
    b.release("B#1");
    assert.equal(a.tryAcquire("A#2", e("A", 2, 3), 2).ok, false, "FIFO within priority: B#2 (P2) before A#2 (P3)");
    assert.equal(b.tryAcquire("B#2", e("B", 2, 2), 2).ok, true);
    assert.equal(a.list().slots.length, 2);
    // A re-offer keeps the FIFO position.
    a.offer([{ key: "A#2", ...e("A", 2, 3) }]);
    assert.deepEqual(a.list().queue.map((q) => q.key), ["A#2"]);
  });

  it("dead dispatchers' queued entries and slots are reclaimed; a slot whose detached lane still runs is kept", () => {
    const { handle, live } = world();
    const a = handle(201), b = handle(202);
    assert.equal(a.tryAcquire("A#1", { issue: 1 }, 2).ok, true);
    assert.equal(a.tryAcquire("A#2", { issue: 2 }, 2).ok, true);
    a.setLanePid("A#2", 9002);
    live.add(9002);
    a.offer([{ key: "A#3", issue: 3, priority: 0 }]);
    assert.equal(b.tryAcquire("B#1", { issue: 1 }, 2).ok, false);
    live.delete(201); // dispatcher A dies
    assert.deepEqual(b.list().slots.map((s) => s.key), ["A#2"], "A#1 reclaimed; A#2's lane is still running");
    assert.deepEqual(b.list().queue.map((q) => q.key), ["B#1"], "A's queued P0 is gone");
    assert.equal(b.tryAcquire("B#1", { issue: 1 }, 2).ok, true);
    live.delete(9002); // the orphaned lane exits
    assert.deepEqual(b.list().slots.map((s) => s.key), ["B#1"]);
    // A resume adopts a live lane without being gated by the cap.
    const a2 = handle(203);
    a2.adoptSlot("A#4", { issue: 4, lanePid: 9004 });
    a2.adoptSlot("A#5", { issue: 5 });
    assert.equal(a2.list().slots.length, 3);
  });

  it("forgedock sched cap changes the cap live; --clear falls back to the caller's config", async () => {
    const { handle } = world();
    const a = handle(301), b = handle(302);
    assert.equal(a.tryAcquire("A#1", {}, 5).ok, true);
    await quiet(() => schedFromCli(["cap", "1"], { sched: a }));
    assert.equal(b.cap(), 1);
    assert.equal(b.tryAcquire("B#1", {}, 5).ok, false, "the registry cap overrides the config cap");
    const shown = await quiet(() => schedFromCli(["show"], { sched: b }));
    assert.deepEqual([shown.cap, shown.slots.length, shown.queue.length], [1, 1, 1]);
    await quiet(() => schedFromCli(["cap", "--clear"], { sched: a }));
    assert.equal(b.tryAcquire("B#1", {}, 5).ok, true);
    assert.equal(b.tryAcquire("B#2", {}, null).ok, true, "no cap anywhere: always granted");
    for (const bad of [["cap"], ["cap", "0"], ["cap", "x"], ["cap", "1.5"], ["nope"]]) {
      await assert.rejects(() => quiet(() => schedFromCli(bad, { sched: a })), /usage: forgedock sched/);
    }
  });

  it("fails open: an unreadable registry or a held lock grants with fallback", () => {
    const { dir, handle } = world();
    writeFileSync(join(dir, "registry.json"), "{not json");
    const a = handle(401);
    const r = a.tryAcquire("A#1", {}, 1);
    assert.deepEqual([r.ok, r.fallback], [true, true]);
    assert.match(r.reason, /unreadable/);
    const w2 = world();
    const owner = w2.handle(402);
    writeFileSync(join(w2.dir, "registry.lock"), "402"); // a live owner never releases it
    const b = w2.handle(403, { lockWaitMs: 30 });
    const r2 = b.tryAcquire("B#1", {}, 1);
    assert.deepEqual([r2.ok, r2.fallback], [true, true]);
    assert.match(r2.reason, /lock held by pid 402/);
    // A dead owner's lock is taken over.
    w2.live.delete(402);
    const r3 = b.tryAcquire("B#1", {}, 1);
    assert.deepEqual([r3.ok, r3.fallback], [true, undefined]);
    assert.ok(owner);
  });

  it("14 dispatchers against one registry: running lanes ≤ the cap, each batch ≤ its K, a P0 submitted last starts next", async () => {
    const { handle, live } = world();
    const CAP = 4, K = 2, BATCHES = 14;
    const inFlight = new Map(); // key -> resolve
    const perBatch = new Map();
    const starts = [];
    let maxHost = 0, maxBatch = 0;
    let autoRelease = false;
    const runOneFor = (batch) => async (n) => {
      const key = `${batch}#${n}`;
      starts.push(key);
      perBatch.set(batch, (perBatch.get(batch) ?? 0) + 1);
      maxHost = Math.max(maxHost, inFlight.size + 1);
      maxBatch = Math.max(maxBatch, perBatch.get(batch));
      const r = await new Promise((res) => { inFlight.set(key, res); if (autoRelease) setTimeout(() => res(), 1); });
      inFlight.delete(key);
      perBatch.set(batch, perBatch.get(batch) - 1);
      return r ?? { terminalReason: "merged", pr: n, cost_usd: 0 };
    };
    const dispatch = (i, issues, prio) => {
      const batch = `b${i}`;
      const registry = handle(5000 + i);
      return orchestrate({ issues, parallel: K, readBody: async () => "", runOne: runOneFor(batch), pollMs: 2, batchId: batch,
        sched: { registry, batch, repo: `o/r${i % 3}`, cap: CAP }, priorityOf: async (n) => prio(n) });
    };
    const reg = handle(4999);
    const runs = [];
    for (let i = 0; i < BATCHES; i++) runs.push(dispatch(i, [1, 2, 3], () => 2));
    await until(() => inFlight.size === CAP && reg.list().queue.length === BATCHES * K - CAP, "the cap to fill and every batch to offer");
    assert.equal(reg.list().slots.length, CAP);
    // A P0 submitted last, in its own batch behind 24 queued P2s.
    runs.push(dispatch(BATCHES, [7, 8], (n) => (n === 7 ? 0 : 3)));
    await until(() => reg.list().queue.some((q) => q.key === `b${BATCHES}#7`), "the P0 to be queued");
    assert.equal(reg.list().queue[0].key, `b${BATCHES}#7`);
    const before = starts.length;
    inFlight.get(starts[0])(); // one lane ends
    await until(() => starts.length > before, "the next start");
    assert.equal(starts[before], `b${BATCHES}#7`, "the freed slot went to the P0");
    assert.equal(starts.length, before + 1);
    autoRelease = true;
    for (const res of [...inFlight.values()]) res();
    const results = await Promise.all(runs);
    assert.ok(results.flat().every((r) => r.outcome === "merged"), JSON.stringify(results));
    assert.equal(starts.length, BATCHES * 3 + 2);
    assert.ok(maxHost <= CAP, `host lanes peaked at ${maxHost}`);
    assert.ok(maxBatch <= K, `a batch peaked at ${maxBatch}`);
    const end = reg.list();
    assert.deepEqual([end.slots.length, end.queue.length], [0, 0], "every slot released and offer withdrawn");
    assert.ok(live.size > BATCHES);
  });

  it("a dead dispatcher's slots are reclaimed so a waiting batch proceeds; adopted lanes hold a slot until they settle", async () => {
    const { handle, live } = world();
    const ghost = handle(6001);
    assert.equal(ghost.tryAcquire("g#1", { issue: 1 }, 1).ok, true);
    const registry = handle(6002);
    let ran = 0;
    const p = orchestrate({ issues: [1], readBody: async () => "", runOne: async () => { ran++; return { terminalReason: "merged", cost_usd: 0 }; },
      pollMs: 2, batchId: "b", sched: { registry, batch: "b", repo: "o/r", cap: 1 } });
    await until(() => registry.list().queue.length === 1, "the offer");
    assert.equal(ran, 0, "the host is full");
    live.delete(6001); // the other dispatcher dies
    const rows = await p;
    assert.deepEqual([rows[0].outcome, ran], ["merged", 1]);
    // --resume: a live lane recorded by the earlier dispatcher is adopted into the registry, and released once it settles.
    const saved = { v: 1, order: [5], deps: { 5: [] }, results: {}, running: { 5: { startedAt: 0, pid: 777 } }, pending: [] };
    let store = saved;
    const calls = [];
    const spy = { ...registry, adoptSlot: (k, e) => { calls.push(["adopt", k, e.lanePid]); registry.adoptSlot(k, e); calls.push(["slots", registry.list().slots.map((x) => x.key)]); },
      release: (k) => { calls.push(["release", k]); registry.release(k); } };
    live.add(777);
    const q = await orchestrate({ issues: [], readBody: async () => "", runOne: async () => ({ terminalReason: "merged" }), adopt: async () => ({ terminalReason: "merged", cost_usd: 0 }),
      store: { load: () => store, save: (s) => { store = s; } }, pollMs: 2, batchId: "r", sched: { registry: spy, batch: "r", repo: "o/r", cap: 1 } });
    assert.equal(q[0].outcome, "merged");
    assert.deepEqual(calls, [["adopt", "r#5", 777], ["slots", ["r#5"]], ["release", "r#5"]]);
    assert.equal(registry.list().slots.length, 0);
    assert.deepEqual(store.priorities, { 5: 2 });
  });

  it("an unreadable registry admits without the global cap and says so once", async () => {
    const { dir, handle } = world();
    writeFileSync(join(dir, "registry.json"), "garbage");
    const rows = [];
    const res = await orchestrate({ issues: [1, 2], parallel: 2, readBody: async () => "", runOne: async () => ({ terminalReason: "merged", cost_usd: 0 }),
      pollMs: 2, batchId: "f", sched: { registry: handle(7001), batch: "f", repo: "o/r", cap: 1 }, onUpdate: (r) => rows.push(r) });
    assert.deepEqual(res.map((r) => r.outcome), ["merged", "merged"]);
    assert.equal(rows.filter((r) => r.outcome === "sched").length, 1);
  });

  it("without a registry, admission and state are unchanged (no priorities key, FIFO)", async () => {
    let store = null;
    const order = [];
    await orchestrate({ issues: [3, 1, 2], parallel: 1, readBody: async () => "", runOne: async (n) => { order.push(n); return { terminalReason: "merged" }; },
      priorityOf: async (n) => (n === 2 ? 0 : 2), store: { load: () => null, save: (s) => { store = s; } } });
    assert.deepEqual(order, [3, 1, 2]);
    assert.equal("priorities" in store, false);
  });
});
