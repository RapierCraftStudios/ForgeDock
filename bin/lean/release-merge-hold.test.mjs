// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { releaseMergeHold, rollupPending, holdEnabled, ledgerIoFromGh } from "./release-merge-hold.mjs";
import { CI_EXCLUDED_CHECKS } from "../review-staging.mjs";

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
    assert.equal((await releaseMergeHold(O(run([PEND]), { policy: { release: { hold_merges_during_release_ci: false } } }))).held, false);
    assert.equal((await releaseMergeHold(O(run([PEND]), { policy: { release: { hold_merges_during_release_ci: true } } }))).held, true);
    assert.equal(holdEnabled(null), true); assert.equal(holdEnabled({ schema: 1 }), true); assert.equal(holdEnabled({ release: {} }), true);
  });
  it("#5794 skipReleaseCi lets the release fix lane past a pending release PR; the manual hold and the default still hold", async () => {
    assert.equal((await releaseMergeHold(O(run([PEND]), { skipReleaseCi: true }))).held, false);
    assert.equal((await releaseMergeHold(O(run([PEND]), { skipReleaseCi: false }))).held, true);
    const m = await releaseMergeHold(O(run([PEND]), { skipReleaseCi: true, readActive: async () => ({ mergeHold: { reason: "r" } }) }));
    assert.equal(m.held, true); assert.equal(m.kind, "manual");
  });
  it("holds on a manual hold and fails open on read errors", async () => {
    const m = await releaseMergeHold(O(run([]), { readActive: async () => ({ mergeHold: { reason: "r" } }) }));
    assert.equal(m.held, true); assert.equal(m.kind, "manual");
    const f = await releaseMergeHold(O(async () => { throw new Error("gh down"); }, { readActive: async () => { throw new Error("x"); } }));
    assert.equal(f.held, false);
  });
  it("#5776 the manual hold is read through a gh-backed ledger io (no io.api needed)", async () => {
    const { readActive } = await import("./release-ledger.mjs");
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
    const mk = (gh) => ({ readActive: () => readActive({ io: ledgerIoFromGh(gh), repo: "o/r", credential: "driver" }) });
    const ok = async (a) => { assert.equal(a[0], "api"); assert.match(a[3], /^repos\/o\/r\/contents\/.*active\.json\?ref=/); return JSON.stringify({ content: b64({ mergeHold: { reason: "r" } }) }); };
    const m = await releaseMergeHold(O(run([]), mk(ok)));
    assert.equal(m.held, true); assert.equal(m.kind, "manual");
    const missing = async () => { throw new Error("gh api GET x failed: HTTP 404"); };
    assert.equal((await releaseMergeHold(O(run([]), mk(missing)))).held, false);
  });
  it("rollupPending reads check runs and status contexts", () => {
    assert.equal(rollupPending({ __typename: "StatusContext", state: "PENDING" }), true);
    assert.equal(rollupPending({ __typename: "CheckRun", status: "QUEUED" }), true);
    assert.equal(rollupPending({ __typename: "CheckRun", status: "COMPLETED" }), false);
  });
  it("#5777: the always-pending forge/deploy-gate status and other report-only gate checks do not hold a merge", async () => {
    const gate = { __typename: "StatusContext", context: "forge/deploy-gate", state: "PENDING" };
    const done = { __typename: "CheckRun", name: "ci", status: "COMPLETED" };
    assert.equal(rollupPending(gate), false);
    assert.equal((await releaseMergeHold(O(run([{ ...PEND, statusCheckRollup: [gate, done] }])))).held, false);
    const others = [{ __typename: "CheckRun", name: "forgedock/verify", status: "IN_PROGRESS" }, { __typename: "CheckRun", name: "Check for FORGE gate markers", status: "QUEUED" }];
    assert.equal((await releaseMergeHold(O(run([{ ...PEND, statusCheckRollup: [gate, ...others, done] }])))).held, false);
    for (const n of CI_EXCLUDED_CHECKS) {
      assert.equal(rollupPending({ __typename: "CheckRun", name: n, status: "IN_PROGRESS" }), false, n);
      assert.equal(rollupPending({ __typename: "StatusContext", context: n, state: "PENDING" }), false, n);
    }
    const real = await releaseMergeHold(O(run([{ ...PEND, statusCheckRollup: [gate, { __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" }] }])));
    assert.equal(real.held, true); assert.equal(real.kind, "release-ci");
  });
});
