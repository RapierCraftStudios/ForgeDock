// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5836: the merge train in the batch runner: pr-ready frees the slot, dependents wait, hand-backs recover, resume continues.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { createMergeTrain, formatTrainSummary } from "./mergetrain.mjs";

process.env.FORGEDOCK_SCHED_DIR = tmpDir("train-sched-");
const H = "a".repeat(40);
const READY = (pr) => ({ terminalReason: "pr-ready", pr, head: H, required: ["build"], policy: "required", lane: "staging" });
/** A fake gh: `checks[pr]` is the list of rollups the PR shows poll by poll (the last repeats). */
function world(checks) {
  const merged = new Set(), calls = [];
  const gh = async (a) => {
    calls.push(a);
    if (a[0] === "pr" && a[1] === "view") {
      const pr = Number(a[2]); const seq = checks[pr]; const c = seq.length > 1 ? seq.shift() : seq[0];
      return JSON.stringify({ state: merged.has(pr) ? "MERGED" : "OPEN", headRefOid: H, headRefName: `b${pr}`, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "staging", statusCheckRollup: [{ name: "build", status: c === "pending" ? "IN_PROGRESS" : "COMPLETED", conclusion: c === "pending" ? "" : c === "red" ? "FAILURE" : "SUCCESS", detailsUrl: `https://ci/${pr}` }] });
    }
    if (a[0] === "pr" && a[1] === "merge") merged.add(Number(a[2]));
    return "";
  };
  return { gh, merged, calls };
}
const go = (extra) => orchestrate({ parallel: 1, readBody: async () => "", pollMs: 1, trainEveryMs: 0, sleep: async () => {}, ...extra });

describe("merge train in the batch runner (#5836)", () => {
  it("frees the slot at pr-ready, merges via the train, and counts it in the report line", async () => {
    const w = world({ 10: ["pending", "green"] }); const train = createMergeTrain({ gh: w.gh, repo: "o/r" });
    const started = [];
    const rows = await go({ issues: [1, 2], train, runOne: async (n) => { started.push([n, w.merged.size]); return n === 1 ? READY(10) : { terminalReason: "merged" }; } });
    assert.deepEqual(started, [[1, 0], [2, 0]], "issue 2 started before the train merged PR 10");
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    assert.ok(w.calls.some((a) => a[1] === "merge" && a.slice(-2).join() === `--match-head-commit,${H}`));
    assert.match(formatTrainSummary(train.stats()), /^merge train: merged 1, handed back 0/);
  });
  it("a dependent waits for the train's merge", async () => {
    const w = world({ 10: ["pending", "pending", "green"] }); const train = createMergeTrain({ gh: w.gh, repo: "o/r" });
    const seen = [];
    const rows = await go({ issues: [1, 2], train, readBody: async (n) => (n === 2 ? "Depends on #1" : ""),
      runOne: async (n) => { seen.push([n, w.merged.has(10)]); return n === 1 ? READY(10) : { terminalReason: "merged" }; } });
    assert.deepEqual(seen, [[1, false], [2, true]]);
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
  });
  it("a red PR is handed back as ci.red and a recovery lane runs, then merges", async () => {
    const w = world({ 10: ["red"] }); const train = createMergeTrain({ gh: w.gh, repo: "o/r" });
    const marks = []; let k = 0;
    const rows = await go({ issues: [1], train, recovery: { maxAttempts: 1 }, markRecovering: async (x) => { marks.push(x); },
      runOne: async () => (k++ === 0 ? READY(10) : { terminalReason: "merged" }) });
    assert.deepEqual(marks.map((m) => m.code), ["ci.red"]);
    assert.equal(rows[0].outcome, "merged"); assert.equal(rows[0].recovered, "ci.red");
    assert.equal(train.stats().handedBack["ci.red"], 1);
    assert.equal(w.merged.size, 0, "the train never merged the red PR");
  });
  it("a hand-back with no recovery budget ends needs-human with the failing check URL", async () => {
    const w = world({ 10: ["red"] }); const train = createMergeTrain({ gh: w.gh, repo: "o/r" });
    const rows = await go({ issues: [1], train, recovery: { maxAttempts: 0 }, runOne: async () => READY(10) });
    assert.equal(rows[0].outcome, "needs-human"); assert.equal(rows[0].code, "ci.red");
    assert.match(rows[0].detail, /build https:\/\/ci\/10/);
  });
  it("a stopped batch reports the pr-ready row and --resume continues it through the train", async () => {
    const w = world({ 10: ["pending"] }); let state = null;
    const ac = new AbortController();
    const store = { load: () => null, save: (s) => { state = JSON.parse(JSON.stringify(s)); if (s.train?.entries.length) ac.abort(); }, log: () => {} };
    await go({ issues: [1], train: createMergeTrain({ gh: w.gh, repo: "o/r" }), store, signal: ac.signal, runOne: async () => READY(10) }).catch(() => {});
    assert.equal(state.results[1].outcome, "pr-ready");
    assert.equal(state.train.entries[0].pr, 10);
    const w2 = world({ 10: ["green"] }); const train2 = createMergeTrain({ gh: w2.gh, repo: "o/r" });
    const rows = await go({ issues: [1], train: train2, store: { load: () => state, save: () => {}, log: () => {} }, runOne: async () => { throw new Error("must not relaunch"); } });
    assert.equal(rows[0].outcome, "merged"); assert.ok(w2.merged.has(10));
  });
  it("without a train nothing changes: a merged lane is a merged row", async () => {
    const rows = await go({ issues: [1, 2], runOne: async () => ({ terminalReason: "merged" }) });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
  });
});
