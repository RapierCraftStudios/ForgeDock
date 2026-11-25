// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5986: the attempts ledger in the batch runner: readmission needs a new input hash, a lifetime budget breach escalates once,
// and the ledger survives a resume (state.json) because releaseHeld never clears it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";

const memStore = () => { let st = null; return { load: () => (st ? JSON.parse(JSON.stringify(st)) : null), save: (s) => { st = JSON.parse(JSON.stringify(s)); }, log: () => {}, peek: () => st }; };
const FAIL = { terminalReason: "needs-human", code: "ci.red", detail: "ci red: same failure" };
const MERGED = { terminalReason: "merged", pr: 1 };
const seam = (h, extra = {}) => { const notes = [], mirrored = []; return { cfg: { maxAttempts: 4, maxIdentical: 2 }, hash: async () => h.v, notify: async (x) => { notes.push(x); }, mirror: async (n, l) => { mirrored.push([n, l]); }, notes, mirrored, ...extra }; };
const run = (store, a, runOne, labels = []) => {
  const updates = [];
  return orchestrate({ issues: [1, 2], parallel: 1, pollMs: 5, store, readBody: async (n) => (n === 2 ? "**Depends on**: #1" : ""), // 2 is held behind 1: a root with a held subtree is what the label watch readmits
     attempts: a, issueLabels: async () => labels, runOne: (n, ...x) => (n === 1 ? runOne(n, ...x) : Promise.resolve(MERGED)), onUpdate: (r) => updates.push(r) }).then((rows) => ({ rows, updates }));
};

describe("#5986 attempts ledger in the batch runner", () => {
  it("needs-human label removed with an unchanged input hash: not readmitted, loop.no_new_input, label kept", async () => {
    const store = memStore(), h = { v: "H1" }, a = seam(h);
    await run(store, a, async () => FAIL);
    let ran = 0;
    const r = await run(store, a, async () => { ran++; return MERGED; });
    assert.equal(ran, 0, "no lane ran");
    assert.equal(r.rows[0].outcome, "needs-human");
    assert.ok(r.updates.some((u) => u.code === "loop.no_new_input"), JSON.stringify(r.updates));
    const refused = a.notes.filter((n) => n.code === "loop.no_new_input");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].relabel, true, "the needs-human label is put back");
  });

  it("a changed input hash readmits the issue", async () => {
    const store = memStore(), h = { v: "H1" }, a = seam(h);
    await run(store, a, async () => FAIL);
    h.v = "H2";
    const r = await run(store, a, async () => MERGED);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["merged", "merged"], "root and its held dependent");
  });

  it("the 3rd identical-signature failure escalates once and stops; counters survive resumes (state.json)", async () => {
    const store = memStore(), h = { v: "H1" }, a = seam(h);
    await run(store, a, async () => FAIL);
    h.v = "H2"; await run(store, a, async () => FAIL);
    assert.equal(a.notes.filter((n) => n.code === "escalate").length, 0);
    h.v = "H3"; const third = await run(store, a, async () => FAIL);
    assert.equal(third.rows[0].outcome, "needs-human");
    assert.equal(a.notes.filter((n) => n.code === "escalate").length, 1, "one escalation");
    assert.equal(store.peek().attempts[1].attempts, 3);
    assert.equal(store.peek().attempts[1].signatures.length, 3);
    let ran = 0;
    const again = await run(store, a, async () => { ran++; return MERGED; }); // same hash H3, label removed
    assert.equal(ran, 0);
    assert.equal(again.rows[0].outcome, "needs-human");
    assert.equal(a.notes.filter((n) => n.code === "escalate").length, 1, "still one escalation");
    h.v = "H4";
    assert.equal((await run(store, a, async () => MERGED)).rows[0].outcome, "merged", "a new input hash readmits");
  });

  it("an engine-error that breaches the lifetime attempts cap ends needs-human (escalated)", async () => {
    const store = memStore(), h = { v: "H1" }, a = seam(h, { cfg: { maxAttempts: 1, maxIdentical: 5 } });
    const r = await run(store, a, async () => ({ terminalReason: "engine-error", detail: "boom" }));
    assert.equal(r.rows[0].outcome, "needs-human");
    assert.equal(a.notes.filter((n) => n.code === "escalate").length, 1);
  });

  it("no seam or no ledger admits (a merged-first-try issue sees nothing)", async () => {
    const a = seam({ v: "H1" });
    const r = await run(memStore(), a, async () => MERGED);
    assert.equal(r.rows[0].outcome, "merged");
    assert.equal(a.notes.length, 0);
    assert.equal((await run(memStore(), null, async () => MERGED)).rows[0].outcome, "merged");
  });
});
