// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4773: issue-level readiness: trusted `Blocked by` edges and the `blocked` label.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";

const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
const merged = { terminalReason: "merged" };

describe("#4773: Blocked by edges and the blocked label", () => {
  it("an issue whose body says Blocked by #A is not dispatched before #A merges, whatever the batch order", async () => {
    const started = [];
    const rows = await orchestrate({ issues: [2, 1], parallel: 3, pollMs: 5, trusted: () => true, readBody: async (n) => (n === 2 ? "Blocked by #1" : ""),
      runOne: async (n) => { started.push(n); await new Promise((r) => setTimeout(r, n === 1 ? 30 : 0)); return merged; } });
    assert.deepEqual(started, [1, 2]);
    assert.ok(rows.every((r) => r.outcome === "merged"));
  });

  it("adding #A later to the same batch orders it before the issue that is blocked by it", async () => {
    const bodies = { 1: "", 2: "Blocked by #3", 3: "" };
    let added = [];
    const started = []; let open;
    const g = new Promise((r) => { open = r; });
    const done = orchestrate({ issues: [1, 2], parallel: 1, pollMs: 5, trusted: () => true, readBody: async (n) => bodies[n], getAdded: () => added,
      runOne: async (n) => { started.push(n); if (n === 1) await g; return merged; } });
    await until(() => started.includes(1));
    added = [3];
    await new Promise((r) => setTimeout(r, 30));
    open();
    await done;
    assert.deepEqual(started, [1, 3, 2]);
  });

  it("an untrusted author's Blocked by line makes no edge", async () => {
    const started = [];
    await orchestrate({ issues: [2, 1], parallel: 1, pollMs: 5, trusted: () => false, readBody: async (n) => (n === 2 ? "Blocked by #1" : ""),
      runOne: async (n) => { started.push(n); return merged; } });
    assert.deepEqual(started, [2, 1]);
  });

  it("a blocked-labelled issue is admitted but not dispatched; removing the label releases it on the next tick", async () => {
    let blocked = [1];
    const started = [], log = [];
    const done = orchestrate({ issues: [1, 2], parallel: 3, pollMs: 5, readBody: async () => "", blockedRefreshMs: 0, getBlocked: async () => blocked, onUpdate: (r) => log.push(r),
      runOne: async (n) => { started.push(n); return merged; } });
    await until(() => started.includes(2));
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(started, [2], "#1 waits while labelled");
    blocked = [];
    const rows = await done;
    assert.deepEqual(started, [2, 1]);
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "merged"]]);
    assert.deepEqual(log.filter((r) => ["blocked", "unblocked"].includes(r.outcome)).map((r) => [r.outcome, r.detail]), [["blocked", "#1"], ["unblocked", "#1"]]);
  });

  it("a failed label read keeps the last set instead of releasing", async () => {
    let fail = false, set = [1], reads = 0;
    const started = [];
    const done = orchestrate({ issues: [1], parallel: 1, pollMs: 5, readBody: async () => "", blockedRefreshMs: 0, getBlocked: async () => { reads++; if (fail) throw new Error("gh down"); return set; },
      runOne: async (n) => { started.push(n); return merged; } });
    await until(() => reads > 0);
    fail = true;
    const seen = reads;
    await until(() => reads > seen + 2);
    assert.deepEqual(started, []);
    fail = false; set = [];
    await done;
    assert.deepEqual(started, [1]);
  });
});

describe("#4917: a deferred issue still waiting when the last running lane ends", () => {
  it("stays pending in the saved state (future notBefore) while the batch stops on the breaker", async () => {
    let failLast; const gate = new Promise((r) => { failLast = r; });
    let saved = null;
    const store = { load: () => null, save: (st) => { saved = st; } };
    await orchestrate({ issues: [1, 2], parallel: 2, pollMs: 5, readBody: async () => "", breaker: { errors: 1, window_min: 30 }, maxDeferrals: 3, store,
      runOne: async (n) => {
        if (n === 1) { setTimeout(failLast, 20); return { terminalReason: "deferred", code: "run.interrupted", retryInSeconds: 3600, cost_usd: 0 }; }
        await gate; return { terminalReason: "engine-error", detail: "boom" };
      } });
    assert.ok(saved.pending.includes(1), JSON.stringify(saved.pending));
    assert.ok(Number(saved.notBefore?.[1]) > Date.now(), JSON.stringify(saved.notBefore));
    assert.deepEqual(saved.running, {});
  });
});

describe("remote lanes with a registry lacking the #4964 methods", () => {
  it("a remote-placed lane runs and settles when the registry stub has no noteRemote/dropRemote/notePool", async () => {
    const calls = [];
    const registry = { tryAcquire: () => { calls.push("acquire"); return { ok: true }; }, offer() {}, withdraw() {}, release() {}, setLanePid() {}, adoptSlot() {}, holder: () => null };
    const rows = await orchestrate({ issues: [4], parallel: 1, pollMs: 5, trusted: () => true, readBody: async () => "", sched: { registry, batch: "B", repo: "o/r" },
      remote: { max: 1, isRemote: () => true, capacity: () => null },
      runOne: async (n, lane, ctx) => { ctx.onStart?.({ handle: { id: "s-4" }, remote: true }); return merged; } });
    assert.equal(rows[0].outcome, "merged");
    assert.deepEqual(calls, [], "a remote lane never takes a host slot");
  });
});

describe("#5048: the pool is unreachable only after a failed capacity probe", () => {
  const run = async (capacity) => {
    const notes = [];
    const registry = { tryAcquire: () => ({ ok: true }), offer() {}, withdraw() {}, release() {}, setLanePid() {}, adoptSlot() {}, holder: () => null, notePool: (b, st) => notes.push(st === null ? "clear" : "down") };
    const rows = await orchestrate({ issues: [4, 5, 6], parallel: 1, pollMs: 5, trusted: () => true, readBody: async () => "", sched: { registry, batch: "B", repo: "o/r" },
      remote: { max: 1, isRemote: () => true, ...(capacity ? { capacity } : {}) },
      runOne: async (n, lane, ctx) => { ctx.onStart?.({ handle: { id: `s-${n}` }, remote: true }); return merged; } });
    assert.ok(rows.every((r) => r.outcome === "merged"));
    return notes;
  };
  it("unknown capacity (null) does not mark the pool unreachable", async () => {
    assert.deepEqual(await run(() => null), []);
  });
  it("a provider without capacity() never marks the pool unreachable", async () => {
    assert.deepEqual(await run(null), []);
  });
  it("a throwing probe marks it down and a later successful sample clears it", async () => {
    let calls = 0;
    const notes = await run(() => { if (++calls === 1) throw new Error("boom"); return { free: 1, online: 1, at: calls }; });
    assert.deepEqual(notes, ["down", "clear"]);
  });
});

describe("#5162: failed roots hold their subtree; only real cycles are cycles", () => {
  const memStore = () => { let st = null; return { load: () => st, save: (s) => { st = JSON.parse(JSON.stringify(s)); }, get: () => st }; };
  const chain = { 1: "", 2: "**Depends on**: #1", 3: "**Depends on**: #2", 4: "**Depends on**: #1, #3" };
  const outcome = (rows, n) => rows.find((r) => r.issue === n);

  it("a DAG whose engine-error root ends marks no row dependency cycle; every dependent is held and names the root", async () => {
    const rows = await orchestrate({ issues: [1, 2, 3, 4], parallel: 2, pollMs: 5, readBody: async (n) => chain[n], engineErrorRetries: 0, transientRetries: 0,
      runOne: async () => ({ terminalReason: "engine-error", detail: "boom" }) });
    assert.ok(!rows.some((r) => /dependency cycle/.test(r.detail ?? "")), JSON.stringify(rows));
    for (const n of [2, 3, 4]) { assert.equal(outcome(rows, n).outcome, "held"); assert.match(outcome(rows, n).detail, /^blocked by #1 \(engine-error\)$/); }
  });

  it("a genuine cycle is still labelled dependency cycle; its downstream names a member", async () => {
    const bodies = { 1: "**Depends on**: #2", 2: "**Depends on**: #1", 3: "**Depends on**: #2" };
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 2, pollMs: 5, readBody: async (n) => bodies[n], runOne: async () => merged });
    assert.deepEqual(rows.map((r) => r.outcome), ["skipped", "skipped", "skipped"]);
    assert.equal(outcome(rows, 1).detail, "dependency cycle");
    assert.equal(outcome(rows, 2).detail, "dependency cycle");
    assert.match(outcome(rows, 3).detail, /^blocked by #[12] \(dependency cycle\)$/);
  });

  it("dependents of a needs-human root end held; after the label is removed a resume admits root then dependents in order", async () => {
    const store = memStore();
    const first = await orchestrate({ issues: [1, 2, 3, 4], parallel: 2, pollMs: 5, store, readBody: async (n) => chain[n], runOne: async () => ({ terminalReason: "needs-human", code: "ci.red", detail: "red" }) });
    assert.equal(outcome(first, 1).outcome, "needs-human");
    for (const n of [2, 3, 4]) assert.deepEqual([outcome(first, n).outcome, outcome(first, n).detail], ["held", "blocked by #1 (needs-human)"]);
    const started = [];
    const rows = await orchestrate({ issues: [1, 2, 3, 4], parallel: 3, pollMs: 5, store, readBody: async (n) => chain[n], issueLabels: async () => [],
      runOne: async (n) => { started.push(n); await new Promise((r) => setTimeout(r, 5)); return merged; } });
    assert.deepEqual(started, [1, 2, 3, 4]);
    assert.ok(rows.every((r) => r.outcome === "merged"), JSON.stringify(rows));
  });

  it("a resume with the needs-human label still on the root keeps the subtree held", async () => {
    const store = memStore();
    await orchestrate({ issues: [1, 2], parallel: 1, pollMs: 5, store, readBody: async (n) => chain[n], runOne: async () => ({ terminalReason: "needs-human", detail: "x" }) });
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, pollMs: 5, store, readBody: async (n) => chain[n], issueLabels: async () => ["needs-human"], runOne: async () => merged });
    assert.deepEqual(rows.map((r) => r.outcome), ["needs-human", "held"]);
  });

  it("the report lists a held subtree with its root and one --requeue command", async () => {
    const { formatOutcomeLists } = await import("./orchestrate.mjs");
    const lines = formatOutcomeLists([{ issue: 1, outcome: "engine-error" }, { issue: 2, outcome: "held", root: 1 }, { issue: 3, outcome: "held", root: 1 }]);
    assert.ok(lines.some((l) => /held subtree: #1 \(engine-error\) holds #2 #3; release: forgedock orchestrate --requeue <batch> 1/.test(l)), lines.join("\n"));
  });

  it("the blocked-label list is read at most once per blockedRefreshMs, not on every pass", async () => {
    let reads = 0, t = 0;
    const started = [];
    let open;
    const g = new Promise((r) => { open = r; });
    const done = orchestrate({ issues: [1, 2], parallel: 1, pollMs: 5, now: () => t, blockedRefreshMs: 60000, readBody: async () => "",
      getBlocked: async () => { reads++; return []; }, runOne: async (n) => { started.push(n); if (n === 1) await g; return merged; } });
    await until(() => started.includes(1));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(reads, 1, "many passes inside the window make one read");
    t = 60001;
    open();
    await done;
    assert.ok(reads >= 2, "a pass after the window reads again");
  });

  it("#5632: refreshHeld is a hoisted function declaration (finish/recovery callbacks of a resumed batch call it before its line runs)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./orchestrate.mjs", import.meta.url), "utf8");
    assert.match(src, /\n  function refreshHeld\(\) \{/);
    assert.doesNotMatch(src, /const refreshHeld\s*=/);
  });
});

