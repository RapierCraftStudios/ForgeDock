// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codeForTerminalReason } from "../engine/outcome-codes.mjs";
import { createMergeTrain, formatTrainSummary, judgeChecks, p50, rollupStates } from "./mergetrain.mjs";

const H = "a".repeat(40);
/** A fake gh over `prs`: {pr: {state, head, mergeable, mergeState, base, branch, checks}}; records every call. */
function fake(prs, { mergeError = null } = {}) {
  const calls = [];
  const gh = async (a) => {
    calls.push(a);
    const sub = a.slice(0, 2).join(" ");
    if (sub === "pr view") {
      const p = prs[a[2]];
      if (a.includes("headRefOid") && !a.join(",").includes("state,")) return JSON.stringify({ headRefOid: p.head });
      if (a.join(",").endsWith("state")) return JSON.stringify({ state: p.state ?? "OPEN" });
      return JSON.stringify({ state: p.state ?? "OPEN", headRefOid: p.head, headRefName: p.branch ?? `feat/${a[2]}`, mergeable: p.mergeable ?? "MERGEABLE", mergeStateStatus: p.mergeState ?? "CLEAN", baseRefName: p.base ?? "staging", statusCheckRollup: p.checks ?? [] });
    }
    if (sub === "pr merge") { if (mergeError) throw mergeError; prs[a[2]].state = "MERGED"; return ""; }
    if (sub === "pr update-branch") { prs[a[2]].mergeState = "CLEAN"; prs[a[2]].head = "b".repeat(40); return ""; }
    if (sub === "issue view") return JSON.stringify({ labels: [{ name: "workflow:in-progress" }] });
    return "";
  };
  return { gh, calls };
}
const ok = (name) => ({ name, conclusion: "SUCCESS" });
const entry = (issue, pr, extra = {}) => ({ issue, pr, head: H, required: ["build"], policy: "required", lane: "staging", ...extra });

describe("mergetrain (#5836)", () => {
  it("merges a green PR at the reviewed head, then closes, labels and deletes the branch", async () => {
    const f = fake({ 5: { head: H, checks: [ok("build")] } });
    const t = createMergeTrain({ gh: f.gh, repo: "o/r" }); t.add(entry(1, 5));
    const ev = await t.tick();
    assert.deepEqual(ev.map((e) => [e.kind, e.issue]), [["merged", 1]]);
    assert.deepEqual(f.calls.find((a) => a[1] === "merge").slice(-2), ["--match-head-commit", H]);
    assert.ok(f.calls.some((a) => a[0] === "issue" && a[1] === "close" && a.includes("completed")));
    assert.ok(f.calls.some((a) => a[0] === "issue" && a[1] === "edit" && a.includes("workflow:merged")));
    assert.ok(f.calls.some((a) => a.join(" ").includes("DELETE repos/o/r/git/refs/heads/feat/5")));
    assert.equal(t.size(), 0);
  });
  it("merges at most one PR per base per poll; another base merges in the same poll", async () => {
    const f = fake({ 5: { head: H, checks: [ok("build")] }, 6: { head: H, checks: [ok("build")] }, 7: { head: H, base: "milestone/x", checks: [ok("build")] } });
    const t = createMergeTrain({ gh: f.gh, repo: "o/r" }); t.add(entry(1, 5)); t.add(entry(2, 6)); t.add(entry(3, 7, { lane: "milestone/x" }));
    assert.deepEqual((await t.tick()).map((e) => e.issue), [1, 3]);
    assert.deepEqual((await t.tick()).map((e) => e.issue), [2]);
  });
  it("keeps a pending PR waiting and does not merge it", async () => {
    const f = fake({ 5: { head: H, checks: [{ name: "build", status: "IN_PROGRESS", conclusion: "" }] } });
    const t = createMergeTrain({ gh: f.gh, repo: "o/r" }); t.add(entry(1, 5));
    assert.deepEqual(await t.tick(), []);
    assert.equal(t.size(), 1);
    assert.ok(!f.calls.some((a) => a[1] === "merge"));
  });
  it("updates a green PR that is behind its base, then merges once the head is current", async () => {
    const f = fake({ 5: { head: H, mergeState: "BEHIND", checks: [ok("build")] } });
    const t = createMergeTrain({ gh: f.gh, repo: "o/r" }); t.add(entry(1, 5));
    assert.deepEqual(await t.tick(), []);
    assert.ok(f.calls.some((a) => a.slice(0, 3).join(" ") === "pr update-branch 5"));
    assert.equal(t.stats().syncs, 1);
    assert.equal(t.snapshot().entries[0].head, "b".repeat(40), "the train adopts the synced head");
  });
  it("hands a red PR back as ci.red naming the failing checks and their URLs", async () => {
    const f = fake({ 5: { head: H, checks: [{ name: "build", conclusion: "FAILURE", detailsUrl: "https://ci/run/9" }] } });
    const t = createMergeTrain({ gh: f.gh, repo: "o/r" }); t.add(entry(1, 5));
    const [e] = await t.tick();
    assert.equal(e.kind, "handback"); assert.equal(e.code, "ci.red");
    assert.match(e.detail, /- build https:\/\/ci\/run\/9/);
    assert.equal(t.stats().handedBack["ci.red"], 1);
    assert.ok(!f.calls.some((a) => a[1] === "merge"));
  });
  it("hands a conflicting PR back as base.conflict and a moved head as merge.head_mismatch", async () => {
    const f = fake({ 5: { head: H, mergeable: "CONFLICTING", checks: [ok("build")] }, 6: { head: "c".repeat(40), checks: [ok("build")] } });
    const t = createMergeTrain({ gh: f.gh, repo: "o/r" }); t.add(entry(1, 5)); t.add(entry(2, 6));
    assert.deepEqual((await t.tick()).map((e) => e.code), ["base.conflict", "merge.head_mismatch"]);
    assert.ok(!f.calls.some((a) => a[1] === "merge"));
  });
  it("a merge refused because the head moved is handed back; a transient failure is retried", async () => {
    const moved = fake({ 5: { head: H, checks: [ok("build")] } }, { mergeError: Object.assign(new Error("Head branch was modified"), { stderr: "" }) });
    const t = createMergeTrain({ gh: moved.gh, repo: "o/r" }); t.add(entry(1, 5));
    assert.equal((await t.tick())[0].code, "merge.head_mismatch");
    const flaky = fake({ 5: { head: H, checks: [ok("build")] } }, { mergeError: new Error("502 bad gateway") });
    const t2 = createMergeTrain({ gh: flaky.gh, repo: "o/r" }); t2.add(entry(1, 5));
    assert.deepEqual(await t2.tick(), []); assert.equal(t2.size(), 1);
  });
  it("persists through snapshot and restore, with stats and the p50 wait", async () => {
    let clock = 0;
    const f = fake({ 5: { head: H, checks: [ok("build")] }, 6: { head: H, base: "other", checks: [ok("build")] } });
    const t = createMergeTrain({ gh: f.gh, repo: "o/r", now: () => clock }); t.add(entry(1, 5)); t.add(entry(2, 6, { lane: "other" }));
    clock = 60000; await t.tick();
    const snap = JSON.parse(JSON.stringify(t.snapshot()));
    const t2 = createMergeTrain({ gh: f.gh, repo: "o/r" }); t2.restore(snap);
    assert.equal(t2.stats().merged, 2); assert.deepEqual(t2.stats().waits, [60000, 60000]);
    assert.equal(p50([30000, 60000, 90000]), 60000); assert.equal(p50([]), null);
  });
  it("pr-ready carries the awaiting_merge code", () => assert.equal(codeForTerminalReason("pr-ready"), "awaiting_merge"));
  it("formats the batch report line", () => {
    assert.equal(formatTrainSummary({ merged: 3, handedBack: { "ci.red": 1, "base.conflict": 1 }, waits: [60000, 120000], syncs: 2 }), "merge train: merged 3, handed back 2 (base.conflict 1, ci.red 1), wait p50 1.0 min, base-syncs 2");
    assert.equal(formatTrainSummary({ merged: 0, handedBack: {}, waits: [], syncs: 0 }), null);
  });
  it("judges policy all and required checks", () => {
    const st = rollupStates([ok("a"), { name: "b", status: "IN_PROGRESS" }]);
    assert.equal(judgeChecks(st, { required: ["a"] }).green, true);
    assert.equal(judgeChecks(st, { required: ["a", "missing"] }).green, false);
    assert.equal(judgeChecks(st, { policy: "all" }).green, false);
  });
});

/** #5837: a fake gh with candidate-ref support on top of `fake`. `conflict` = PR heads whose candidate merge 409s. */
function batchWorld(prs, { conflict = [], runs = [{ name: "build", status: "completed", conclusion: "success" }], mergeRefuse = null } = {}) {
  const f = fake(prs); const refs = new Set(); let checkRuns = runs;
  const gh = async (a) => {
    const s = a.join(" ");
    if (s.includes("/git/ref/heads/") && !s.includes("forge-train")) return JSON.stringify({ object: { sha: "c".repeat(40) } });
    if (s.includes("/git/ref/heads/forge-train")) { f.calls.push(a); return JSON.stringify({ object: { sha: "d".repeat(40) } }); }
    if (s.startsWith("api -X POST repos/o/r/git/refs")) { f.calls.push(a); refs.add(a[5].slice(15)); return "{}"; }
    if (s.startsWith("api -X POST repos/o/r/merges")) { f.calls.push(a); const head = a.find((x) => x.startsWith("head=")).slice(5); if (conflict.includes(head)) throw Object.assign(new Error("Merge conflict (HTTP 409)"), { stderr: "" }); return "{}"; }
    if (s.startsWith("api -X DELETE repos/o/r/git/refs/heads/forge-train")) { f.calls.push(a); refs.delete(a[3].split("/heads/")[1]); return ""; }
    if (s.startsWith("api -X POST repos/o/r/actions")) { f.calls.push(a); return ""; }
    if (s.includes("/check-runs")) { f.calls.push(a); return JSON.stringify({ check_runs: checkRuns }); }
    if (s.includes("compare/")) return JSON.stringify({ files: [{ filename: "x.js" }] });
    if (a[0] === "pr" && a[1] === "view" && a.includes("files")) return JSON.stringify({ files: [{ path: "x.js" }, { path: "y.js" }] });
    if (a[0] === "pr" && a[1] === "merge" && mergeRefuse === a[2]) { f.calls.push(a); throw new Error("base branch policy prohibits the merge"); }
    return f.gh(a);
  };
  return { gh, calls: f.calls, refs, setRuns: (r) => { checkRuns = r; } };
}
const hd = (c) => c.repeat(40);
const bprs = () => ({ 5: { head: hd("1"), mergeState: "BEHIND", checks: [ok("build")] }, 6: { head: hd("2"), mergeState: "BEHIND", checks: [ok("build")] }, 7: { head: hd("3"), mergeState: "BEHIND", checks: [ok("build")] } });
const eb = (issue, pr, head) => entry(issue, pr, { head });
const fill = (t) => { t.add(eb(1, 5, hd("1"))); t.add(eb(2, 6, hd("2"))); t.add(eb(3, 7, hd("3"))); };

describe("mergetrain batches (#5837)", () => {
  it("N BEHIND PRs share one candidate CI run, no update-branch, merged FIFO at their heads", async () => {
    const w = batchWorld(bprs()); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock }); fill(t);
    assert.deepEqual(await t.tick(), []); // builds + validating
    assert.ok(w.refs.size === 1 && [...w.refs][0].startsWith("forge-train/staging/"));
    const merges = w.calls.filter((a) => a[0] === "api" && a[3] === "repos/o/r/merges");
    assert.equal(merges.length, 3);
    assert.ok(merges.every((a) => a.includes("base=" + [...w.refs][0])), "merge into the candidate, never a rebase");
    assert.equal(t.snapshot().batches[0].state, "validating");
    assert.deepEqual(await t.tick(), []); // candidate checks green -> merging
    const all = await t.tick(); // merges the batch in order
    assert.deepEqual(all.map((e) => e.issue), [1, 2, 3]);
    const pm = w.calls.filter((a) => a[1] === "merge").map((a) => [a[2], a.at(-1)]);
    assert.deepEqual(pm.slice(0, 3), [["5", hd("1")], ["6", hd("2")], ["7", hd("3")]]);
    assert.equal(w.calls.filter((a) => a[1] === "update-branch").length, 0);
    assert.equal(w.refs.size, 0, "candidate ref deleted when finished");
    assert.equal(t.stats().candidateRuns, 1);
    assert.equal(t.stats().merged, 3);
    assert.match(formatTrainSummary(t.stats()), /batches 1, candidate CI runs 1/);
  });
  it("a conflict on the candidate removes only that PR, as base.conflict with the files; the rest merge", async () => {
    const w = batchWorld(bprs(), { conflict: [hd("2")] }); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock }); fill(t);
    const ev = await t.tick();
    assert.deepEqual(ev.map((e) => [e.kind, e.issue, e.code]), [["handback", 2, "base.conflict"]]);
    assert.match(ev[0].detail, /x\.js/);
    assert.deepEqual(t.snapshot().batches[0].prs.map((p) => p.pr), [5, 7]);
    await t.tick(); await t.tick();
    assert.deepEqual(w.calls.filter((a) => a[1] === "merge").map((a) => a[2]), ["5", "7"]);
  });
  it("a protection refusal keeps the PR in the train and holds order", async () => {
    const w = batchWorld(bprs(), { mergeRefuse: "5" }); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock }); fill(t);
    await t.tick(); await t.tick(); await t.tick();
    assert.equal(t.size(), 3);
    assert.deepEqual([...new Set(w.calls.filter((a) => a[1] === "merge").map((a) => a[2]))], ["5"]);
  });
  it("a restored validating batch re-reads the candidate checks and does not rebuild it", async () => {
    const w = batchWorld(bprs(), { runs: [{ name: "build", status: "in_progress", conclusion: null }] }); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock }); fill(t);
    await t.tick();
    const snap = JSON.parse(JSON.stringify(t.snapshot()));
    const before = w.calls.filter((a) => a[3] === "repos/o/r/git/refs" || a[3] === "repos/o/r/merges").length;
    const t2 = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, saved: snap, now: () => ++clock });
    await t2.tick();
    assert.equal(w.calls.filter((a) => a[3] === "repos/o/r/git/refs" || a[3] === "repos/o/r/merges").length, before);
    assert.equal(t2.snapshot().batches[0].state, "validating");
    assert.equal(t2.stats().candidateRuns, 1);
  });
  it("a red candidate deletes the ref and falls back to serial handling, without re-batching", async () => {
    const w = batchWorld(bprs(), { runs: [{ name: "build", status: "completed", conclusion: "failure" }] }); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock }); fill(t);
    await t.tick(); await t.tick();
    assert.equal(w.refs.size, 0);
    assert.equal(t.snapshot().batches.length, 0);
    assert.equal(t.stats().candidateRed, 1);
    await t.tick();
    assert.equal(w.calls.filter((a) => a[3] === "repos/o/r/git/refs").length, 1, "no second candidate");
    assert.ok(w.calls.some((a) => a[1] === "update-branch"), "serial sync resumed");
  });
  it("batchSize 1 keeps the serial train: no candidate calls", async () => {
    const w = batchWorld(bprs());
    const t = createMergeTrain({ gh: w.gh, repo: "o/r" }); fill(t);
    await t.tick();
    assert.ok(!w.calls.some((a) => a[0] === "api" && String(a[3]).includes("merges")));
    assert.equal(t.stats().batches, 0);
  });
  it("the summary line stays unchanged without batches", () => {
    assert.ok(!/batches/.test(formatTrainSummary({ merged: 1, handedBack: {}, waits: [0], syncs: 0 })));
  });
});
