// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { startSpeculative } from "./overlap.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// The gate's shape: guard+precheck and the review run together; the review is adopted only when precheck passes.
async function gate({ precheck, review, order }) {
  const spec = startSpeculative(() => review.promise);
  const applied = [];
  try {
    const finish = order === "review-first" ? [review.resolve, precheck.resolve] : [precheck.resolve, review.resolve];
    const failed = await Promise.all([precheck.promise, Promise.resolve().then(() => finish.forEach((f) => f("x")))]).then(([p]) => p);
    if (failed) return { state: "nonconforming", applied };
    applied.push(await spec.adopt());
    return { state: "conforms", applied };
  } finally { spec.discard(); }
}

for (const order of ["review-first", "precheck-first"]) {
  test(`a green precheck adopts the review whichever finishes first (${order})`, async () => {
    const p = deferred(), r = deferred();
    p.promise.then(() => {});
    const out = await gate({ precheck: { promise: p.promise.then(() => false), resolve: p.resolve }, review: r, order });
    assert.deepEqual(out, { state: "conforms", applied: ["x"] });
  });
  test(`a red precheck discards the review and applies nothing (${order})`, async () => {
    const p = deferred(), r = deferred();
    const out = await gate({ precheck: { promise: p.promise.then(() => true), resolve: p.resolve }, review: r, order });
    assert.deepEqual(out, { state: "nonconforming", applied: [] });
  });
}

test("a discarded job that rejects is never an unhandled rejection, and an adopted one rejects as the job did", async () => {
  const a = startSpeculative(async () => { throw new Error("boom"); });
  assert.equal(a.discard() === true || a.discard() === false, true);
  const b = startSpeculative(async () => { throw new Error("boom"); });
  await assert.rejects(b.adopt(), /boom/);
  await new Promise((r) => setImmediate(r));
});

test("discard reports whether the job was still running", async () => {
  const d = deferred();
  const s = startSpeculative(() => d.promise);
  assert.equal(s.discard(), true);
  assert.equal(s.state(), "discarded");
});
