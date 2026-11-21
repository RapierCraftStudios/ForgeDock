// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5823: merge train phase 1 (verdict, one step per PR, report line).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMergeTrain, trainVerdict, makeMergeTrain, formatTrainSummary, TRAIN_MAX_SYNCS, MERGE_TRAIN_MARKER } from "./mergetrain.mjs";

const HEAD = "a".repeat(40);
const run = (name, conclusion, extra = {}) => ({ __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion: conclusion ?? "", detailsUrl: `https://ci/${name}`, ...extra });
const view = (o = {}) => ({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: HEAD, headRefName: "feat/issue-7", statusCheckRollup: [run("build", "SUCCESS")], ...o });
const entry = (o = {}) => ({ issue: 7, pr: 70, head: HEAD, lane: "staging", required: ["build"], policy: "required", since: 0, syncs: 0, defaults: ["main"], ...o });

describe("parseMergeTrain", () => {
  it("is off unless on (or a YAML boolean true)", () => {
    assert.equal(parseMergeTrain(undefined), "off"); assert.equal(parseMergeTrain("off"), "off"); assert.equal(parseMergeTrain("yes"), "off");
    assert.equal(parseMergeTrain("on"), "on"); assert.equal(parseMergeTrain(" ON "), "on"); assert.equal(parseMergeTrain(true), "on");
  });
});

describe("trainVerdict", () => {
  const v = (o, e = {}, opts = {}) => trainVerdict(view(o), entry(e), { now: 1000, ...opts });
  it("green and clean merges; green and BEHIND updates the branch first", () => {
    assert.equal(v({}).action, "merge");
    assert.equal(v({ mergeStateStatus: "BEHIND" }).action, "update-branch");
  });
  it("a required failure (or a red DCO check) is red with the culprit checks; a non-required failure is not", () => {
    const r = v({ statusCheckRollup: [run("build", "FAILURE"), run("lint", "SUCCESS")] });
    assert.equal(r.action, "red"); assert.deepEqual(r.failed.map((c) => [c.name, c.url]), [["build", "https://ci/build"]]);
    assert.equal(v({ statusCheckRollup: [run("build", "SUCCESS"), run("DCO", "FAILURE")] }).action, "red");
    assert.equal(v({ statusCheckRollup: [run("build", "SUCCESS"), run("optional", "FAILURE")] }).action, "merge");
  });
  it("pending or missing required checks wait, then time out", () => {
    assert.equal(v({ statusCheckRollup: [run("build", null)] }).action, "wait");
    assert.equal(v({ statusCheckRollup: [] }).action, "wait");
    assert.equal(v({ statusCheckRollup: [] }, {}, { maxWaitMin: 1, now: 61_000 }).action, "timeout");
  });
  it("policy all gates every check but the report-only ones", () => {
    assert.equal(v({ statusCheckRollup: [run("build", "SUCCESS"), run("x", null), run("forgedock/verify", null)] }, { policy: "all" }).action, "wait");
    assert.equal(v({ statusCheckRollup: [run("build", "SUCCESS"), run("forgedock/verify", "FAILURE")] }, { policy: "all" }).action, "merge");
  });
  it("merged, closed, a moved head and a conflict come before the checks", () => {
    assert.equal(v({ state: "MERGED" }).action, "merged-elsewhere");
    assert.equal(v({ state: "CLOSED" }).action, "closed");
    assert.equal(v({ headRefOid: "b".repeat(40) }).action, "head-moved");
    assert.equal(v({ mergeable: "CONFLICTING", statusCheckRollup: [run("build", "FAILURE")] }).action, "conflict");
    assert.equal(v({ headRefOid: HEAD.slice(0, 12) }).action, "merge"); // an abbreviated head is the same head
  });
});

/** A fake gh: `views` is the sequence of `pr view` answers for the full read; records every call. */
const fakeGh = ({ views, mergeErr = null, afterMergeState = "OPEN", updateErr = null } = {}) => {
  const calls = [];
  const gh = async (a) => {
    calls.push(a);
    const s = a.join(" ");
    if (s.startsWith("pr view") && s.includes("statusCheckRollup")) return JSON.stringify(views.length > 1 ? views.shift() : views[0]);
    if (s.startsWith("pr view") && s.includes("mergeCommit")) return JSON.stringify({ mergeCommit: { oid: "c".repeat(40) } });
    if (s.startsWith("pr view") && s.endsWith("headRefOid")) return JSON.stringify({ headRefOid: "d".repeat(40) });
    if (s.startsWith("pr view") && s.endsWith("state")) return JSON.stringify({ state: afterMergeState });
    if (s.startsWith("pr merge") && mergeErr) throw Object.assign(new Error(mergeErr), { stderr: mergeErr });
    if (s.startsWith("pr update-branch") && updateErr) throw Object.assign(new Error(updateErr), { stderr: updateErr });
    if (s.startsWith("pr list")) return "[]";
    if (s.startsWith("issue view")) return JSON.stringify({ labels: [{ name: "workflow:in-review" }] });
    return "";
  };
  return { gh, calls, has: (prefix) => calls.filter((a) => a.join(" ").startsWith(prefix)) };
};

describe("makeMergeTrain.step", () => {
  it("merges a green PR at the reviewed head, then comments, closes, labels merged and deletes the lane branch", async () => {
    const f = fakeGh({ views: [view()] }), labels = [];
    const t = makeMergeTrain({ gh: f.gh, repo: "o/r", now: () => 120_000, transitionLabel: async (i, s) => labels.push([i, s]) });
    const s = await t.step(entry());
    assert.equal(s.state, "merged"); assert.deepEqual(s.mergedTo, { lane: "staging", pr: 70, sha: "c".repeat(40) });
    assert.deepEqual(f.has("pr merge")[0], ["pr", "merge", "70", "-R", "o/r", "--merge", "--match-head-commit", HEAD]);
    assert.ok(f.has("issue comment")[0].at(-1).startsWith(MERGE_TRAIN_MARKER));
    assert.deepEqual(f.has("issue close")[0], ["issue", "close", "7", "-R", "o/r", "--reason", "completed"]);
    assert.deepEqual(labels, [[7, "merged"]]);
    assert.deepEqual(f.has("api")[0], ["api", "-X", "DELETE", "repos/o/r/git/refs/heads/feat/issue-7"]);
  });
  it("never deletes a protected head branch", async () => {
    const f = fakeGh({ views: [view({ headRefName: "milestone/x" })] });
    await makeMergeTrain({ gh: f.gh, repo: "o/r" }).step(entry());
    assert.equal(f.has("api").length, 0);
  });
  it("red hands back ci.red naming the failing check and its URL; nothing merges", async () => {
    const f = fakeGh({ views: [view({ statusCheckRollup: [run("build", "FAILURE")] })] });
    const s = await makeMergeTrain({ gh: f.gh, repo: "o/r" }).step(entry());
    assert.equal(s.state, "handback"); assert.equal(s.outcome, "needs-human"); assert.equal(s.code, "ci.red");
    assert.match(s.detail, /build \(https:\/\/ci\/build\)/); assert.equal(f.has("pr merge").length, 0);
  });
  it("conflict hands back base.conflict; a moved head merge.head_mismatch; a timeout ci-pending", async () => {
    const step = async (o, opts = {}) => makeMergeTrain({ gh: fakeGh({ views: [view(o)] }).gh, repo: "o/r", ...opts }).step(entry());
    assert.equal((await step({ mergeable: "CONFLICTING" })).code, "base.conflict");
    assert.equal((await step({ headRefOid: "e".repeat(40) })).code, "merge.head_mismatch");
    const s = await step({ statusCheckRollup: [run("build", null)] }, { maxWaitMin: 1, now: () => 90_000 });
    assert.equal(s.outcome, "ci-pending");
  });
  it("BEHIND and green: update-branch (no rebase), the new head and the sync count ride back as an update", async () => {
    const f = fakeGh({ views: [view({ mergeStateStatus: "BEHIND" })] });
    const s = await makeMergeTrain({ gh: f.gh, repo: "o/r" }).step(entry());
    assert.deepEqual(s, { state: "wait", update: { head: "d".repeat(40), syncs: 1 } });
    assert.deepEqual(f.has("pr update-branch")[0], ["pr", "update-branch", "70", "-R", "o/r"]);
    const g = fakeGh({ views: [view({ mergeStateStatus: "BEHIND" })] });
    assert.equal((await makeMergeTrain({ gh: g.gh, repo: "o/r" }).step(entry({ syncs: TRAIN_MAX_SYNCS }))).code, "base.conflict");
    const c = fakeGh({ views: [view({ mergeStateStatus: "BEHIND" })], updateErr: "merge conflict between base and head" });
    assert.equal((await makeMergeTrain({ gh: c.gh, repo: "o/r" }).step(entry())).code, "base.conflict");
  });
  it("a release merge hold waits; a transient merge error retries; an error after a landed merge is merged", async () => {
    const held = fakeGh({ views: [view()] });
    assert.equal((await makeMergeTrain({ gh: held.gh, repo: "o/r", hold: async () => ({ held: true, reason: "release CI" }) }).step(entry())).state, "wait");
    assert.equal(held.has("pr merge").length, 0);
    const tr = fakeGh({ views: [view()], mergeErr: "GraphQL: Base branch was modified" });
    assert.deepEqual(await makeMergeTrain({ gh: tr.gh, repo: "o/r" }).step(entry()), { state: "wait", update: { mergeRetries: 1 } });
    const landed = fakeGh({ views: [view()], mergeErr: "HTTP 502", afterMergeState: "MERGED" });
    assert.equal((await makeMergeTrain({ gh: landed.gh, repo: "o/r" }).step(entry())).state, "merged");
  });
  it("an unreadable PR is a wait, never a throw", async () => {
    const t = makeMergeTrain({ gh: async () => { throw new Error("gh down"); }, repo: "o/r" });
    assert.deepEqual(await t.step(entry()), { state: "wait" });
  });
});

describe("formatTrainSummary", () => {
  it("counts merged and handed-back rows, the train wait p50 and base-syncs; null without train rows", () => {
    assert.equal(formatTrainSummary([{ outcome: "merged" }]), null);
    const line = formatTrainSummary([
      { outcome: "merged", train: { result: "merged", waited_min: 4, syncs: 1 } },
      { outcome: "merged", train: { result: "merged", waited_min: 10, syncs: 0 } },
      { outcome: "needs-human", code: "ci.red", train: { result: "needs-human", waited_min: 3, syncs: 0 } },
      { outcome: "pr-ready" },
    ]);
    assert.equal(line, "merge train: 2 merged (train wait p50 4 min), 1 handed back (ci.red 1), 1 base-sync(s), 1 still PR-ready (resume continues them)");
  });
});
