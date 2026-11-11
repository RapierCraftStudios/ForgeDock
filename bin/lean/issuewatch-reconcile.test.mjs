// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClaim, reconcileClaims, claimCounts, stuckClaims, formatStuck } from "./issuewatch-reconcile.mjs";

test("classifyClaim: merged, parked (terminal code), needs-human, running, stranded", () => {
  assert.deepEqual(classifyClaim({ outcome: "merged" }), { kind: "merged", code: null });
  assert.deepEqual(classifyClaim({ outcome: "needs-human", code: "conformance.unimplemented" }), { kind: "parked", code: "conformance.unimplemented" });
  assert.equal(classifyClaim({ outcome: "needs-human" }).kind, "needs-human");
  assert.equal(classifyClaim(undefined).kind, "running");
  assert.deepEqual(classifyClaim({ outcome: "engine-error" }), { kind: "stranded", code: "engine-error" });
});

test("reconcileClaims settles merged, fails the rest, leaves running claims inflight", () => {
  const state = { inflight: [1, 2, 3], merged: [] };
  const settled = [], failed = [];
  const done = reconcileClaims({ state, results: { 1: { outcome: "merged" }, 2: { outcome: "needs-human", code: "ci.red" } }, now: 5, fail: (n) => failed.push(n), settle: (n) => settled.push(n) });
  assert.deepEqual(done, [1, 2]); assert.deepEqual(settled, [1]); assert.deepEqual(failed, [2]);
  assert.equal(state.outcomes[2].kind, "parked");
  assert.equal(claimCounts({ ...state, inflight: [3] }).parked, 1);
});

test("stuckClaims lists only old unmerged claims with the reason", () => {
  const now = 100 * 3600_000;
  const s = { claimed: [1, 2, 3], merged: [3], inflight: [1], claimedAt: { 1: 0, 2: 99 * 3600_000, 3: 0 }, outcomes: {} };
  const rows = stuckClaims(s, now, 24);
  assert.deepEqual(rows.map((r) => r.issue), [1]);
  assert.match(formatStuck(rows), /#1 claimed 100h ago, no merged PR: running in its lane/);
});
