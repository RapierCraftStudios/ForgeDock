// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backfill, targetLabel } from "./backfill-finding-labels.mjs";

const issues = [
  { number: 1, labels: [{ name: "workflow:merged" }] },
  { number: 2, labels: [{ name: "workflow:invalid" }] },
  { number: 3, labels: [], stateReason: "NOT_PLANNED" },
  { number: 4, labels: [{ name: "workflow:merged" }, { name: "workflow:invalid" }] },
  { number: 5, labels: [] },
];

describe("backfill-finding-labels (#5254)", () => {
  it("maps merged to validated, invalid / not planned to false-positive, else null", () => {
    assert.deepEqual(issues.map(targetLabel), ["validated", "false-positive", "false-positive", "false-positive", null]);
  });
  it("dry-run reports counts and edits nothing", () => {
    const calls = [];
    const r = backfill({ issues, edit: (...a) => calls.push(a) });
    assert.equal(r.mode, "dry-run");
    assert.deepEqual(r.counts, { validated: 1, "false-positive": 3, skipped: 1, failed: 0 });
    assert.deepEqual(calls, []);
  });
  it("--apply edits each mapped issue", () => {
    const calls = [];
    const r = backfill({ issues, apply: true, edit: (n, l) => calls.push([n, l]) });
    assert.equal(r.mode, "apply");
    assert.deepEqual(calls, [[1, "validated"], [2, "false-positive"], [3, "false-positive"], [4, "false-positive"]]);
  });
  it("a failed edit is counted, not reported as changed", () => {
    const r = backfill({ issues: [issues[0]], apply: true, edit: () => { throw new Error("x"); } });
    assert.deepEqual(r.counts, { validated: 0, "false-positive": 0, skipped: 0, failed: 1 });
  });
});
