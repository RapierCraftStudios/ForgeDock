// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5831: stacked lanes phase 1 — the pure helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeStacking, planAdmissible, formatPlanned, parsePlanned, planStale, stackAdmissible, formatStackedOn, parseStackedOn, validStackedOn, stackedBaseBlock } from "./stacking.mjs";

const SAT = new Set(["merged", "invalid"]);
const base = { n: 2, edges: [1], results: new Map(), pending: [1, 2], running: new Map(), planTried: new Set(), satisfied: SAT };

describe("stacking helpers (#5831)", () => {
  it("normalizeStacking: off by default, full is its own mode, junk is off", () => {
    assert.equal(normalizeStacking(undefined), "off");
    assert.equal(normalizeStacking("off"), "off");
    assert.equal(normalizeStacking("plan"), "plan");
    assert.equal(normalizeStacking("FULL"), "full");
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

describe("stacked builds, phase 2 (#5832)", () => {
  const rd = new Map([[1, { pr: 9, branch: "feat/issue-1", sha: "a".repeat(40) }]]);
  const a = { ...base, pending: [2], running: new Map([[1, 1]]), prReady: rd, stackedTried: new Set() };
  it("stackAdmissible: only when the one unmerged dependency is running and PR-ready", () => {
    assert.deepEqual(stackAdmissible(a), { dependency: 1, branch: "feat/issue-1", sha: "a".repeat(40) });
    assert.equal(stackAdmissible({ ...a, prReady: new Map() }), null, "not PR-ready yet");
    assert.equal(stackAdmissible({ ...a, running: new Map() }), null, "dependency not running");
    assert.equal(stackAdmissible({ ...a, stackedTried: new Set([2]) }), null, "once per issue");
    assert.equal(stackAdmissible({ ...a, edges: [1, 3], pending: [2, 3] }), null, "a second unmerged dependency");
    assert.equal(stackAdmissible({ ...a, edges: [1, 3], results: new Map([[3, { outcome: "merged" }]]) })?.dependency, 1, "others merged");
    assert.equal(stackAdmissible({ ...a, edges: [1, 3], results: new Map([[3, { outcome: "needs-human" }]]) }), null, "another failed");
  });
  it("stackedOn <-> --stacked-on round trip", () => {
    const s = { dependency: 1, branch: "feat/issue-1", sha: "abcdef1234567" };
    assert.deepEqual(parseStackedOn(formatStackedOn(s)), s);
    assert.equal(parseStackedOn("x"), null);
    assert.deepEqual(validStackedOn(s), s);
    assert.equal(validStackedOn({ ...s, sha: "zz" }), null);
  });
  it("stackedBaseBlock (merge.stacked_base): a stacked PR never merges into the dependency branch or before the dependency", () => {
    const g = { prBase: "feat/issue-1", lane: "staging", stackedBranch: "feat/issue-1" };
    assert.match(stackedBaseBlock({ ...g, dependencyMerged: false }), /^merge\.stacked_base/);
    assert.match(stackedBaseBlock({ ...g, dependencyMerged: true }), /not the lane/, "merged dependency but base not yet moved");
    assert.match(stackedBaseBlock({ ...g, prBase: "staging", dependencyMerged: false }), /unmerged/);
    assert.equal(stackedBaseBlock({ ...g, prBase: "staging", dependencyMerged: true }), null);
    assert.equal(stackedBaseBlock({ prBase: "staging", lane: "staging", dependencyMerged: false }), null, "not stacked");
  });
});
