// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5893: a needs-human root with held dependents is readmitted only when the label is really gone (fresh read) and its removal
// event post-dates the newest FORGE:NEEDS_HUMAN; an identical block (outcome code + ask key) needs a newer removal event.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";

const memStore = () => { let st = null; return { load: () => (st ? JSON.parse(JSON.stringify(st)) : null), save: (s) => { st = JSON.parse(JSON.stringify(s)); }, log: () => {}, peek: () => st }; };
const FAIL = { terminalReason: "needs-human", code: "spend.cap", detail: "needs a spend decision" };
const MERGED = { terminalReason: "merged", pr: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run 1 blocks root 1 (2 is held behind it); run 2 resumes the batch and watches the held root.
const resume = async (store, { issueLabels, heldFacts, ran, watchMs = 60 }) => {
  const updates = [];
  const p = orchestrate({ issues: [1, 2], parallel: 1, pollMs: 5, store, readBody: async (n) => (n === 2 ? "**Depends on**: #1" : ""), issueLabels, ...(heldFacts ? { heldFacts } : {}),
    runOne: async (n) => { ran.push(n); return MERGED; }, onUpdate: (r) => updates.push(r) });
  await Promise.race([p, sleep(watchMs)]);
  return { updates, p };
};
const block = async (store) => orchestrate({ issues: [1, 2], parallel: 1, pollMs: 5, store, readBody: async (n) => (n === 2 ? "**Depends on**: #1" : ""), issueLabels: async () => ["needs-human"], runOne: async (n) => (n === 1 ? FAIL : MERGED) });

describe("#5893 held needs-human root readmit", () => {
  it("no readmit while needs-human label is still on (stale cache vs fresh read)", async () => {
    const store = memStore(); await block(store);
    const ran = []; const calls = [];
    // the memoized read lacks the label; only a fresh read sees it
    const issueLabels = async (n, o) => { calls.push(o?.fresh === true); return o?.fresh ? ["needs-human"] : []; };
    const { updates } = await resume(store, { issueLabels, ran });
    assert.deepEqual(ran, []);
    assert.ok(!updates.some((u) => u.outcome === "readmitted"));
    assert.ok(calls.every(Boolean), "every held-root label read is fresh");
  });

  it("removal event before the NEEDS_HUMAN comment: no readmit; unreadable events: no readmit", async () => {
    for (const heldFacts of [async () => ({ removedAt: 10, blockedAt: 20, askKey: "k" }), async () => { throw new Error("gh down"); }, async () => null]) {
      const store = memStore(); await block(store);
      const ran = [];
      const { updates } = await resume(store, { issueLabels: async () => [], heldFacts, ran });
      assert.deepEqual(ran, []);
      assert.ok(!updates.some((u) => u.outcome === "readmitted"));
    }
  });

  it("removal event after the block readmits once and the subtree follows", async () => {
    const store = memStore(); await block(store);
    const ran = [];
    const { updates, p } = await resume(store, { issueLabels: async () => [], heldFacts: async () => ({ removedAt: 30, blockedAt: 20, askKey: "k" }), ran, watchMs: 200 });
    await Promise.race([p, sleep(500)]);
    assert.equal(updates.filter((u) => u.outcome === "readmitted" && u.issue === 1).length, 1);
    assert.ok(ran.includes(1));
  });

  it("identical block is not readmitted twice without a newer removal event; sig survives resume", async () => {
    const store = memStore(); await block(store);
    const ran = [];
    const facts = { removedAt: 30, blockedAt: 20, askKey: "k" };
    const first = await resume(store, { issueLabels: async () => [], heldFacts: async () => facts, ran, watchMs: 200 });
    await Promise.race([first.p, sleep(500)]);
    assert.deepEqual(store.peek().heldSigs?.[1], { sig: "needs-human:k", removedAt: 30 }.sig ? { sig: "needs-human:k", removedAt: 30 } : null);
    // the lane blocks again with the same ask; the old removal event is the only one
    const st = store.peek();
    st.results = { ...st.results, 1: { issue: 1, outcome: "needs-human", code: "spend.cap" }, 2: { issue: 2, outcome: "held", root: 1, waiting: [1] } };
    st.pending = []; st.running = {};
    const store2 = memStore(); store2.save(st);
    const ran2 = [];
    const again = await resume(store2, { issueLabels: async () => [], heldFacts: async () => facts, ran: ran2 });
    assert.deepEqual(ran2, []);
    assert.ok(!again.updates.some((u) => u.outcome === "readmitted"));
  });
});
