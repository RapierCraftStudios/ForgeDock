// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5831: stacked lanes phase 1 — the pure helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeStacking, planAdmissible, formatPlanned, parsePlanned, planStale } from "./stacking.mjs";

const SAT = new Set(["merged", "invalid"]);
const base = { n: 2, edges: [1], results: new Map(), pending: [1, 2], running: new Map(), planTried: new Set(), satisfied: SAT };

describe("stacking helpers (#5831)", () => {
  it("normalizeStacking: off by default, full behaves as plan, junk is off", () => {
    assert.equal(normalizeStacking(undefined), "off");
    assert.equal(normalizeStacking("off"), "off");
    assert.equal(normalizeStacking("plan"), "plan");
    assert.equal(normalizeStacking("FULL"), "plan");
    assert.equal(normalizeStacking("yes"), "off");
  });
  it("planAdmissible: only a dependent with an unmet in-batch dependency, once", () => {
    assert.equal(planAdmissible(base), true);
    assert.equal(planAdmissible({ ...base, edges: [] }), false, "no dependency");
    assert.equal(planAdmissible({ ...base, planTried: new Set([2]) }), false, "one plan lane per issue");
    assert.equal(planAdmissible({ ...base, running: new Map([[2, 1]]) }), false, "already running");
    assert.equal(planAdmissible({ ...base, results: new Map([[1, { outcome: "merged" }]]) }), false, "nothing unmet: a build lane");
    assert.equal(planAdmissible({ ...base, results: new Map([[1, { outcome: "needs-human" }]]) }), false, "failed dependency");
    assert.equal(planAdmissible({ ...base, pending: [2], running: new Map([[1, 1]]) }), true, "dependency running");
    assert.equal(planAdmissible({ ...base, pending: [2] }), false, "dependency neither pending nor running");
  });
  it("planned <-> --planned round trip", () => {
    const p = { contractHash: "abcdef123456", baseSha: "0123456789abcdef0123456789abcdef01234567" };
    assert.deepEqual(parsePlanned(formatPlanned(p)), p);
    assert.equal(parsePlanned("nonsense"), null);
    assert.equal(parsePlanned(undefined), null);
    assert.equal(formatPlanned(null), null);
  });
  it("planStale: contract, lane and deliverable-path changes make a plan stale", () => {
    const planned = { contractHash: "aaaaaaaaaaaa", baseSha: "b".repeat(40) };
    const ok = { planned, contractHash: "aaaaaaaaaaaa", ancestor: true, changedPaths: ["docs/x.md"], deliverablePaths: ["bin/a.mjs"] };
    assert.equal(planStale(ok), null);
    assert.match(planStale({ ...ok, contractHash: "cccccccccccc" }), /contract/);
    assert.match(planStale({ ...ok, ancestor: false }), /lane moved/);
    assert.match(planStale({ ...ok, changedPaths: ["bin/a.mjs"] }), /deliverable path/);
    assert.match(planStale({ ...ok, planned: null }), /no plan/);
  });
});
