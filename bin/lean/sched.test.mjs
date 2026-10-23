// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { grantOrder, openSched, priorityFromLabels } from "./sched.mjs";
import { orchestrate, estimateLaneMinutes, laneHistory, formatEstimateSummary, EST_DEFAULT_MIN, POST_DEPLOY_EST_MIN } from "./orchestrate.mjs";
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

describe("cross-repo fairness weights (#4193)", () => {
  // Two repos, one dispatcher each, keep twice the cap queued at P2 (o/b offers its first batch before o/a). Each
  // round the oldest running lane ends and every queued key retries, lowest-ranked first, so only the registry's
  // grant order decides who starts.
  const saturate = ({ weights = {}, cap = 6 } = {}) => {
    const { handle } = world();
    const disp = { "o/a": handle(501), "o/b": handle(502) };
    for (const [r, n] of Object.entries(weights)) disp["o/a"].setWeight(r, n);
    const next = { "o/a": 0, "o/b": 0 };
    const offer = (repo, priority = 2) => {
      const n = ++next[repo];
      disp[repo].offer([{ key: `${repo}#${n}`, batch: repo, repo, issue: n, priority }]);
      return `${repo}#${n}`;
    };
    for (const r of ["o/b", "o/a"]) for (let i = 0; i < cap * 2; i++) offer(r);
    const pass = () => {
      for (let granted = true; granted;) {
        granted = false;
        for (const q of disp["o/a"].list().queue.reverse()) {
          if (disp[q.repo].tryAcquire(q.key, q, cap).ok) { granted = true; if (q.priority === 2) offer(q.repo); }
        }
      }
    };
    const slots = () => disp["o/a"].list().slots;
    const running = () => { const c = { "o/a": 0, "o/b": 0 }; for (const s of slots()) c[s.repo]++; return c; };
    const endOldest = () => { const s = slots().sort((x, y) => x.at - y.at)[0]; disp[s.repo].release(s.key); };
    return { disp, offer, pass, slots, running, endOldest };
  };

  it("two repos weighted 2:1, both saturated at one priority: running lanes converge to 2:1", () => {
    const w = saturate({ weights: { "o/a": 2 } });
    w.pass();
    assert.deepEqual(w.running(), { "o/a": 4, "o/b": 2 }, "the first fill already follows the weights, not who offered first");
    for (let round = 0; round < 40; round++) {
      w.endOldest();
      w.pass();
      assert.deepEqual(w.running(), { "o/a": 4, "o/b": 2 }, `round ${round}`);
    }
  });

  it("default weights are equal: a repo that offered first does not take every slot", () => {
    const w = saturate();
    w.pass();
    assert.deepEqual(w.running(), { "o/a": 3, "o/b": 3 });
    for (let round = 0; round < 20; round++) { w.endOldest(); w.pass(); assert.deepEqual(w.running(), { "o/a": 3, "o/b": 3 }); }
  });

  it("a P0 from any repo still starts next, even from the repo already at its share", () => {
    const w = saturate({ weights: { "o/a": 2 } });
    w.pass();
    const p0 = w.offer("o/b", 0);
    assert.equal(w.disp["o/a"].list().queue[0].key, p0, "the P0 heads the queue ahead of the heavier repo's P2s");
    assert.equal(w.disp["o/a"].tryAcquire("o/a#13", { repo: "o/a", priority: 2 }, 6).ok, false, "no slot free");
    w.endOldest();
    assert.equal(w.disp["o/a"].tryAcquire(w.disp["o/a"].list().queue[1].key, { repo: "o/a", priority: 2 }, 6).ok, false, "the freed slot belongs to the P0");
    assert.equal(w.disp["o/b"].tryAcquire(p0, { repo: "o/b", priority: 0 }, 6).ok, true);
    assert.ok(w.slots().some((s) => s.key === p0));
  });

  it("grantOrder on an injected queue: priority first, then load/weight across repos, FIFO inside a repo", () => {
    const q = (repo, seq, priority = 2, batch = null) => ({ repo, batch, issue: seq, priority, seq });
    const s = {
      weights: {},
      slots: { "x#1": { repo: "o/a", priority: 2 }, "x#2": { repo: "o/a", priority: 1 } },
      queue: { a1: q("o/a", 1), a2: q("o/a", 2), a3: q("o/a", 3), b1: q("o/b", 4), b2: q("o/b", 5), c0: q("o/c", 9, 0) },
    };
    assert.deepEqual(grantOrder(s).map(([k]) => k), ["c0", "b1", "b2", "a1", "a2", "a3"]);
    s.weights = { "o/a": 3 };
    assert.deepEqual(grantOrder(s).map(([k]) => k), ["c0", "b1", "a1", "a2", "b2", "a3"], "ties in load/weight go to the heavier repo");
    // One repo (or no repo, grouped by batch, else by key): plain FIFO, as before #4193.
    const one = { weights: {}, slots: {}, queue: { k3: q(null, 3, 2, "B"), k1: q(null, 1, 2, "B"), k2: q(null, 2, 2, "B") } };
    assert.deepEqual(grantOrder(one).map(([k]) => k), ["k1", "k2", "k3"]);
    const none = { weights: {}, slots: {}, queue: { k3: q(null, 3), k1: q(null, 1), k2: q(null, 2) } };
    assert.deepEqual(grantOrder(none).map(([k]) => k), ["k1", "k2", "k3"]);
  });

  it("forgedock sched weight sets and clears a repo's weight; show lists it; invalid input is rejected", async () => {
    const { handle } = world();
    const a = handle(601);
    assert.deepEqual(a.weights(), {});
    await quiet(() => schedFromCli(["weight", "o/a", "2"], { sched: a }));
    assert.deepEqual(a.weights(), { "o/a": 2 });
    const shown = await quiet(() => schedFromCli(["show"], { sched: a }));
    assert.deepEqual(shown.weights, { "o/a": 2 });
    await quiet(() => schedFromCli(["weight", "o/a", "--clear"], { sched: a }));
    assert.deepEqual(a.weights(), {});
    for (const bad of [["weight"], ["weight", "o/a"], ["weight", "o/a", "0"], ["weight", "o/a", "1.5"], ["weight", "--clear"]]) {
      await assert.rejects(() => quiet(() => schedFromCli(bad, { sched: a })), /usage: forgedock sched/);
    }
    assert.throws(() => a.setWeight("o/a", 0), /positive integer/);
    assert.throws(() => a.setWeight("", 2), /non-empty/);
  });
});

// #4409: a virtual clock. Lane durations and sleeps are timers in virtual ms; the clock jumps to the next timer once the
// event loop has drained every microtask, so the orchestrator's async chains settle before time moves.
const vclock = () => {
  let t = 0, done = false;
  const timers = [];
  const at = (ms, signal) => new Promise((res) => {
    const x = { when: t + ms, res };
    timers.push(x);
    signal?.addEventListener("abort", () => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); res(); }, { once: true });
  });
  const tick = () => setImmediate(() => {
    if (done) return;
    if (timers.length) { timers.sort((a, b) => a.when - b.when); const x = timers.shift(); t = x.when; x.res(); }
    tick();
  });
  tick();
  return { now: () => t, at, sleep: (ms, signal) => at(ms, signal), stop: () => { done = true; } };
};
const MIN = 60000;

describe("longest-first admission (#4409)", () => {
  it("estimateLaneMinutes: size label, unsized = M, post-deploy floor, history only with enough merged samples of the repo", () => {
    assert.equal(estimateLaneMinutes({ labels: ["size:S"] }), EST_DEFAULT_MIN.S);
    assert.equal(estimateLaneMinutes({ labels: [{ name: "size:L" }] }), EST_DEFAULT_MIN.L);
    assert.equal(estimateLaneMinutes({}), EST_DEFAULT_MIN.M);
    assert.equal(estimateLaneMinutes({ labels: ["size:L"], body: "- [ ] `R1: smoke` — post-deploy: needs prod" }), POST_DEPLOY_EST_MIN);
    const run = (repo, size, min, reason = "merged") => ({ repo, size, reason, wallMs: min * MIN });
    const h = laneHistory([run("o/r", "S", 4), run("o/r", "S", 6), run("o/r", "S", 8), run("o/r", "S", 100, "needs-human"), run("x/y", "S", 1),
      run("o/r", "L", 90), run("o/r", "L", 70)], "o/r");
    assert.deepEqual(h, { S: 6 }, "L has only 2 samples; other repos and unmerged runs never count");
    assert.equal(estimateLaneMinutes({ labels: ["size:S"], history: h }), 6);
    assert.equal(estimateLaneMinutes({ labels: ["size:L"], history: h }), EST_DEFAULT_MIN.L);
  });

  it("admits by estimate, descending, within a priority level; priority across levels is unchanged", async () => {
    const est = { 1: 5, 2: 50, 3: 20 };
    const order = [];
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async () => "", estimate: async (n) => est[n],
      runOne: async (n) => { order.push(n); return { terminalReason: "merged" }; } });
    assert.deepEqual(order, [2, 3, 1]);
    assert.deepEqual(rows.map((r) => r.est_minutes), [5, 50, 20]);
    const { handle } = world();
    const order2 = [];
    await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async () => "", estimate: async (n) => est[n], pollMs: 2, batchId: "lpt",
      sched: { registry: handle(7101), batch: "lpt", repo: "o/r", cap: 4 }, priorityOf: async (n) => (n === 1 ? 1 : 2),
      runOne: async (n) => { order2.push(n); return { terminalReason: "merged" }; } });
    assert.deepEqual(order2, [1, 2, 3], "the short P1 still precedes the long P2s");
  });

  it("decomposed sub-issues are admitted before same-priority FIFO items, with or without an estimator", async () => {
    for (const estimate of [null, async () => 10]) {
      const order = [];
      let store = null;
      await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async () => "", estimate, store: { load: () => null, save: (x) => { store = x; } },
        runOne: async (n) => { order.push(n); return n === 1 ? { terminalReason: "decomposed", subissues: [8, 9] } : { terminalReason: "merged" }; } });
      assert.deepEqual(order, [1, 8, 9, 2, 3]);
      assert.equal("estimates" in store, !!estimate, "no estimates key without an estimator");
      if (estimate) assert.equal(store.estimates[8], EST_DEFAULT_MIN.M, "parent estimate ÷ N, floored at M");
    }
  });

  it("starvation guard: an issue queued past starveMs is bumped ahead of a longer estimate", async () => {
    // #2 runs 0-10 min; #3 (longer) is added at 1 min; at 10 min #1 has waited 10 min.
    const run = async (starveMs) => {
      const c = vclock();
      const order = [];
      try {
        await orchestrate({ issues: [1, 2], parallel: 1, readBody: async () => "", now: c.now, sleep: c.sleep, pollMs: MIN, starveMs,
          getAdded: () => (c.now() >= MIN ? [3] : []), estimate: async (n) => ({ 1: 5, 2: 30, 3: 40 })[n],
          runOne: async (n) => { order.push(n); await c.at(10 * MIN); return { terminalReason: "merged" }; } });
      } finally { c.stop(); }
      return order;
    };
    assert.deepEqual(await run(8 * MIN), [2, 1, 3], "#1 waited past the limit");
    assert.deepEqual(await run(30 * MIN), [2, 3, 1], "under the limit: longest first");
  });

  it("critical path: an issue with an in-batch dependent outranks an equal estimate without one", async () => {
    const order = [];
    await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async (n) => (n === 3 ? "Depends on #2" : ""), estimate: async () => 10,
      runOne: async (n) => { order.push(n); return { terminalReason: "merged" }; } });
    assert.deepEqual(order, [2, 1, 3]);
  });

  it("replay of the 2026-10-22 batch: makespan is about the longest chain, not the FIFO tail", async () => {
    // K=6; 41 short lanes; #41 (size:L, 40 min) is listed last; #3 decomposes 4 min in; its sub-issue #104 runs 48 min.
    const c = vclock();
    const issues = Array.from({ length: 41 }, (_, i) => i + 1);
    const dur = (n) => (n === 41 ? 40 : n === 3 ? 4 : n === 104 ? 48 : 2) * MIN;
    const start = new Map();
    let rows;
    try {
      rows = await orchestrate({ issues, parallel: 6, readBody: async () => "", now: c.now, sleep: c.sleep,
        estimate: async (n) => estimateLaneMinutes({ labels: [n === 41 ? "size:L" : "size:S"] }),
        runOne: async (n) => {
          start.set(n, c.now());
          await c.at(dur(n));
          return n === 3 ? { terminalReason: "decomposed", subissues: [101, 102, 103, 104] } : { terminalReason: "merged" };
        } });
    } finally { c.stop(); }
    const makespan = c.now() / MIN;
    assert.equal(rows.filter((r) => r.outcome === "merged").length, 44);
    assert.equal(start.get(41), 0, "the long lane is admitted first");
    assert.ok(start.get(104) <= 5 * MIN, `sub-issue #104 started at ${start.get(104) / MIN} min`);
    assert.ok(makespan <= 56, `makespan ${makespan} min (longest chain 4 + 48)`);
  });

  it("formatEstimateSummary: estimated vs. actual over lanes that ran", () => {
    assert.equal(formatEstimateSummary([{ issue: 1, outcome: "merged", minutes: 3 }]), null);
    assert.equal(formatEstimateSummary([{ issue: 1, outcome: "merged", minutes: 12, est_minutes: 10 }, { issue: 2, outcome: "merged", minutes: 40, est_minutes: 25 },
      { issue: 3, outcome: "held", minutes: 0, est_minutes: 10 }]),
    "estimates: 2 lanes, est 35.0 min vs actual 52.0 min; median |error| 8.5 min; worst #2 est 25 actual 40");
  });

  it("a resume keeps estimates, queue times and the head band from the store", async () => {
    const saved = { v: 1, order: [1, 2, 3], deps: { 1: [], 2: [], 3: [] }, lanes: {}, crossSeen: [], results: {}, running: {}, pending: [2, 3, 1],
      estimates: { 1: 50, 2: 5, 3: 20 }, enqueued: { 1: 0, 2: 0, 3: 0 }, heads: [3] };
    const order = [];
    let estCalls = 0;
    await orchestrate({ issues: [], parallel: 1, readBody: async () => "", estimate: async () => { estCalls++; return 1; }, now: () => 0,
      store: { load: () => saved, save: () => {} }, runOne: async (n) => { order.push(n); return { terminalReason: "merged" }; } });
    assert.deepEqual(order, [3, 1, 2]);
    assert.equal(estCalls, 0);
  });
});

describe("#4481: one lane per repo and issue across batches", () => {
  it("the registry refuses a second batch's key for a live repo+issue slot, names the batch and drops it from the queue", () => {
    const { handle, live } = world();
    const a = handle(201), b = handle(202);
    assert.equal(a.tryAcquire("A#5", { batch: "A", repo: "o/r", issue: 5, exclusive: true }, 4).ok, true);
    const r = b.tryAcquire("B#5", { batch: "B", repo: "o/r", issue: 5, exclusive: true }, 4);
    assert.deepEqual([r.ok, r.conflict], [false, "A"]);
    assert.match(r.reason, /#5 has a live lane in batch A/);
    assert.deepEqual(b.list().queue, [], "a refused key holds no grant rank");
    assert.equal(b.holder({ batch: "B", repo: "o/r", issue: 5, exclusive: true }), "A");
    assert.equal(a.holder({ batch: "A", repo: "o/r", issue: 5, exclusive: true }), null, "its own batch is no conflict");
    assert.equal(b.tryAcquire("B#6", { batch: "B", repo: "o/r", issue: 6, exclusive: true }, 4).ok, true, "another issue");
    assert.equal(b.tryAcquire("C#5", { batch: "C", repo: "o/other", issue: 5, exclusive: true }, 4).ok, true, "another repo");
    assert.equal(b.tryAcquire("D#5", { batch: "D", repo: null, issue: 5, exclusive: true }, 4).ok, true, "no repo: unchanged");
    assert.equal(a.tryAcquire("A#5", { batch: "A", repo: "o/r", issue: 5, exclusive: true }, 4).ok, true, "a granted key stays granted");
    assert.equal(b.tryAcquire("E#5", { batch: "E", repo: "o/r", issue: 5 }, null).ok, true, "not exclusive: unchanged");
    b.release("E#5");
    live.delete(201); // A's dispatcher dies with no lane: its slot is reclaimed
    assert.equal(b.tryAcquire("B#5", { batch: "B", repo: "o/r", issue: 5, exclusive: true }, 4).ok, true);
  });

  it("two batches that both include issue N never run two lanes for N; the second defers naming the first and runs its other issues", async () => {
    const { handle } = world();
    const regA = handle(301), regB = handle(302);
    const active = new Map(), maxActive = new Map(), ranB = [];
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const lane = (n) => { active.set(n, (active.get(n) ?? 0) + 1); maxActive.set(n, Math.max(maxActive.get(n) ?? 0, active.get(n))); };
    const pA = orchestrate({ issues: [5], readBody: async () => "", pollMs: 2, batchId: "bA", sched: { registry: regA, batch: "bA", repo: "o/r", cap: null, exclusive: true },
      runOne: async (n) => { lane(n); await gateA; active.set(n, active.get(n) - 1); return { terminalReason: "merged", cost_usd: 0 }; } });
    await until(() => active.get(5) === 1, "batch A's lane");
    const rowsB = [];
    const pB = orchestrate({ issues: [5, 6], readBody: async () => "", pollMs: 2, batchId: "bB", sched: { registry: regB, batch: "bB", repo: "o/r", cap: null, exclusive: true },
      onUpdate: (r) => rowsB.push(r),
      runOne: async (n) => { lane(n); ranB.push(n); active.set(n, active.get(n) - 1); return { terminalReason: "merged", cost_usd: 0 }; } });
    await until(() => ranB.includes(6), "batch B's other issue");
    const deferred = rowsB.filter((r) => r.issue === 5 && r.outcome === "deferred");
    assert.equal(deferred.length, 1, "one row per other batch");
    assert.match(deferred[0].detail, /live lane in batch bA/);
    assert.ok(!ranB.includes(5), "no second lane while batch A runs #5");
    releaseA();
    await pA;
    const done = await pB;
    assert.deepEqual(done.map((r) => [r.issue, r.outcome]).sort(), [[5, "merged"], [6, "merged"]]);
    assert.equal(maxActive.get(5), 1);
  });
});
