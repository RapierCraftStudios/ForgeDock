// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { releaseMergeHold, rollupPending } from "./release-merge-hold.mjs";

const run = (rows) => async () => JSON.stringify(rows);
const O = (gh, extra = {}) => ({ gh, repo: "o/r", branch: "staging", defaults: ["main"], ...extra });
const PEND = { number: 7, baseRefName: "main", statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] };

describe("release merge hold (#5709)", () => {
  it("holds while a staging->main release PR has pending checks", async () => {
    const r = await releaseMergeHold(O(run([PEND])));
    assert.equal(r.held, true); assert.equal(r.kind, "release-ci"); assert.equal(r.pr, 7);
  });
  it("does not hold with no release PR, completed checks, or another base", async () => {
    assert.equal((await releaseMergeHold(O(run([])))).held, false);
    assert.equal((await releaseMergeHold(O(run([{ ...PEND, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED" }, { __typename: "StatusContext", state: "SUCCESS" }] }])))).held, false);
    assert.equal((await releaseMergeHold(O(run([{ ...PEND, baseRefName: "dev" }])))).held, false);
  });
  it("is off when release.hold_merges_during_release_ci is false", async () => {
    assert.equal((await releaseMergeHold(O(run([PEND]), { enabled: false }))).held, false);
  });
  it("holds on a manual hold and fails open on read errors", async () => {
    const m = await releaseMergeHold(O(run([]), { readActive: async () => ({ mergeHold: { reason: "r" } }) }));
    assert.equal(m.held, true); assert.equal(m.kind, "manual");
    const f = await releaseMergeHold(O(async () => { throw new Error("gh down"); }, { readActive: async () => { throw new Error("x"); } }));
    assert.equal(f.held, false);
  });
  it("rollupPending reads check runs and status contexts", () => {
    assert.equal(rollupPending({ __typename: "StatusContext", state: "PENDING" }), true);
    assert.equal(rollupPending({ __typename: "CheckRun", status: "QUEUED" }), true);
    assert.equal(rollupPending({ __typename: "CheckRun", status: "COMPLETED" }), false);
  });
});
