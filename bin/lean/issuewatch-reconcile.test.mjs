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

test("#5529 classifyClaim marks a lane that could not find its CLI as missing-executable; other engine-errors unchanged", () => {
  const row = { outcome: "engine-error", detail: "claude CLI exited with status 1. Output: Failed to find executable claude: No such file or directory" };
  assert.deepEqual(classifyClaim(row), { kind: "stranded", code: "engine-error", reason: "missing-executable" });
  assert.deepEqual(classifyClaim({ outcome: "engine-error", detail: "lane pid 4 exited without a result" }), { kind: "stranded", code: "engine-error" });
});

test("#5529 redriveStep waits for claude on a missing-executable claim, re-drives others, and respects the budget", async () => {
  const { redriveStep } = await import("./issuewatch-reconcile.mjs");
  const state = { outcomes: { 1: { kind: "stranded", code: "engine-error", reason: "missing-executable" }, 2: { kind: "stranded", code: "engine-error" }, 3: { kind: "parked", code: "ci.red" } } };
  const driven = [];
  let ok = false;
  assert.deepEqual(redriveStep({ state, now: 1, resolved: () => ok, redrive: (n) => (driven.push(n), true) }), [2]);
  assert.equal(claimCounts({ ...state, inflight: [] }).stranded, 1);
  ok = true;
  assert.deepEqual(redriveStep({ state, now: 2, resolved: () => ok, redrive: (n) => (driven.push(n), true) }), [1]);
  assert.equal(claimCounts({ ...state, inflight: [] }).stranded, 0);
  for (let i = 0; i < 3; i++) { state.outcomes[2] = { kind: "stranded", code: "engine-error" }; redriveStep({ state, now: 3 + i, resolved: () => true, redrive: (n) => (driven.push(n), true) }); }
  assert.equal(driven.filter((n) => n === 2).length, 2, "budget of 2 re-drives");
  assert.equal(state.outcomes[3].kind, "parked");
});
