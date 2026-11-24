// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codeForTerminalReason } from "../engine/outcome-codes.mjs";
import { createMergeTrain, formatTrainSummary, judgeChecks, p50, waitP90, rollupStates } from "./mergetrain.mjs";

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
    assert.equal(formatTrainSummary({ merged: 3, handedBack: { "ci.red": 1, "base.conflict": 1 }, waits: [60000, 120000], syncs: 2 }), "merge train: merged 3, handed back 2 (base.conflict 1, ci.red 1), wait p50 1.0 min p90 2.0 min, base-syncs 2 (lane 0), base.conflict 1 (lane 0)");
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
  it("a candidate red on the bare base tip too deletes the ref, hands back nothing and goes on serially, without re-batching (#5838)", async () => {
    const w = batchWorld(bprs(), { runs: [{ name: "build", status: "completed", conclusion: "failure" }] }); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock }); fill(t);
    assert.deepEqual([...await t.tick(), ...await t.tick(), ...await t.tick()], []);
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

/** #5838: candidate refs whose sha names the PR heads merged into them; `bad(heads)` says whether `build` fails on that tree. */
function bisectWorld(prs, { bad, baseRed = false, rerunGreen = false, stuck = null } = {}) {
  const f = fake(prs); const refs = new Map(); const reruns = new Set(); let ids = 100; const runIds = new Map();
  const shaOf = (r) => `t_${r.replaceAll("/", "~")}_${refs.get(r).join(",")}`;
  const runOf = (sha) => { if (!runIds.has(sha)) runIds.set(sha, ids++); return runIds.get(sha); };
  const gh = async (a) => {
    const s = a.join(" ");
    if (s.includes("/git/ref/heads/") && !s.includes("forge-train")) return JSON.stringify({ object: { sha: "base" } });
    if (s.includes("/git/ref/heads/forge-train")) return JSON.stringify({ object: { sha: shaOf(s.split("/git/ref/heads/")[1]) } });
    if (s.startsWith("api -X POST repos/o/r/git/refs")) { f.calls.push(a); refs.set(a[5].slice(15), []); return "{}"; }
    if (s.startsWith("api -X POST repos/o/r/merges")) { f.calls.push(a); refs.get(a.find((x) => x.startsWith("base=")).slice(5)).push(a.find((x) => x.startsWith("head=")).slice(5, 6)); return "{}"; }
    if (s.startsWith("api -X DELETE repos/o/r/git/refs/heads/forge-train")) { f.calls.push(a); refs.delete(a[3].split("/heads/")[1]); return ""; }
    if (s.startsWith("api -X POST repos/o/r/actions/jobs/")) { f.calls.push(a); reruns.add(Number(a[3].split("/")[5])); return ""; }
    if (s.includes("/check-runs")) {
      f.calls.push(a);
      const sha = a[1].split("/")[4];
      if (sha === "base") return JSON.stringify({ check_runs: [{ id: 1, name: "build", status: "completed", conclusion: baseRed ? "failure" : "success", html_url: "https://ci/base" }] });
      const heads = sha.split("_")[2].split(",");
      if (stuck && stuck(heads)) return JSON.stringify({ check_runs: [{ id: runOf(sha), name: "build", status: "in_progress", conclusion: null }] });
      const id = runOf(sha), out = [{ id, name: "build", status: "completed", conclusion: bad(heads) ? "failure" : "success", html_url: `https://ci/${heads.join("")}` }];
      if (reruns.has(id)) out.push({ id: id + 1000, name: "build", status: "completed", conclusion: rerunGreen || !bad(heads) ? "success" : "failure", html_url: `https://ci/${heads.join("")}/rerun` });
      return JSON.stringify({ check_runs: out });
    }
    return f.gh(a);
  };
  return { gh, calls: f.calls, refs };
}
const four = () => Object.fromEntries([5, 6, 7, 8].map((pr, i) => [pr, { head: hd(String(i + 1)), checks: [ok("build")] }]));
const fill4 = (t) => [5, 6, 7, 8].forEach((pr, i) => t.add(eb(i + 1, pr, hd(String(i + 1)))));
const ticks = async (t, n) => { const out = []; for (let i = 0; i < n; i++) out.push(...await t.tick()); return out; };

describe("mergetrain bisection (#5838)", () => {
  it("isolates the culprit of 4 within ceil(log2 4)+1 runs; only it is handed back, the innocents merge in the next batch", async () => {
    const w = bisectWorld(four(), { bad: (h) => h.includes("3") }); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock }); fill4(t);
    const ev = await ticks(t, 6);
    const hb = ev.filter((e) => e.kind === "handback");
    assert.deepEqual(hb.map((e) => [e.issue, e.code]), [[3, "ci.red"]]);
    const batchId = [...w.calls.filter((a) => a[3] === "repos/o/r/git/refs")][0][5].split("/").at(-1);
    assert.deepEqual(hb[0].culprit, { pr: 7, check: "build", url: "https://ci/3", batch: batchId });
    assert.match(hb[0].detail, new RegExp(`broke the merged tree of train batch ${batchId}.*build`));
    const runsSpent = t.stats().candidateRuns - 1; // the original candidate run is not a bisection step
    assert.ok(runsSpent <= Math.ceil(Math.log2(4)) + 1, `spent ${runsSpent}`);
    assert.equal(t.stats().bisections, 1); assert.equal(t.stats().culprits, 1);
    // half candidates hold the FIFO first half: PRs 5,6 then 7
    assert.deepEqual(w.calls.filter((a) => a[3] === "repos/o/r/merges" && /bisect/.test(a.at(-1))).map((a) => a.at(-1).split("#")[1]), ["5", "6", "7"]);
    const rest = await ticks(t, 4);
    assert.deepEqual(rest.filter((e) => e.kind === "merged").map((e) => e.issue), [1, 2, 4]);
    assert.equal(t.stats().batches, 2, "the innocents shared a second batch");
    assert.equal(w.calls.filter((a) => a[1] === "update-branch").length, 0, "no serial fallback, no lane rerun");
    assert.equal(w.refs.size, 0, "every candidate ref deleted");
    assert.match(formatTrainSummary(t.stats()), /batches 2, candidate CI runs \d+ \(1 red\), bisections 1, culprits 1/);
  });
  it("a red base tip calls onBaseRed, hands back no PR and builds no candidate on that tip again", async () => {
    const w = bisectWorld(four(), { bad: () => true, baseRed: true }); let clock = 0; const reported = [];
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock, onBaseRed: async (r) => { reported.push(r); } }); fill4(t);
    const ev = await ticks(t, 4);
    assert.ok(!ev.some((e) => e.kind === "handback"));
    assert.equal(reported.length, 1);
    assert.equal(reported[0].baseSha, "base"); assert.deepEqual(reported[0].checks.map((c) => c.name), ["build"]);
    assert.equal(t.stats().bisections, 0); assert.equal(t.stats().redBase, 1); assert.equal(t.size(), 4);
    await ticks(t, 2);
    assert.equal(w.calls.filter((a) => a[3] === "repos/o/r/git/refs").length, 1, "no new candidate on the red tip");
    assert.equal(JSON.parse(JSON.stringify(t.snapshot())).redBases.staging, "base");
  });
  it("a known-flaky check green on its one rerun merges the batch without bisection", async () => {
    const w = bisectWorld(four(), { bad: () => true, rerunGreen: true }); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock, flaky: ["build"] }); fill4(t);
    const ev = await ticks(t, 4);
    assert.equal(w.calls.filter((a) => String(a[3]).includes("/actions/jobs/")).length, 1, "rerun once");
    assert.deepEqual(ev.map((e) => e.kind), ["merged", "merged", "merged", "merged"]);
    assert.equal(t.stats().bisections, 0); assert.equal(t.stats().culprits, 0);
  });
  it("a half that never finishes exhausts the budget: the whole batch falls back to serial phase-1 merging", async () => {
    const w = bisectWorld(four(), { bad: (h) => h.includes("3"), stuck: (h) => h.length === 2 }); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, batchTimeoutMs: 5, now: () => (clock += 3) }); fill4(t);
    const ev = await ticks(t, 6);
    assert.ok(!ev.some((e) => e.kind === "handback"));
    assert.equal(t.snapshot().batches.length, 0);
    assert.ok(t.snapshot().entries.every((e) => e.noBatch), "every member serial");
  });
  it("a spent run budget goes serial instead of building another half", async () => {
    const w = bisectWorld(four(), { bad: (h) => h.includes("3") }); let clock = 0;
    const saved = { entries: [5, 6, 7, 8].map((pr, i) => ({ ...eb(i + 1, pr, hd(String(i + 1))), since: 1 })), stats: { merged: 0, handedBack: {}, waits: [], syncs: 0, batches: 1, candidateRuns: 3 },
      batches: [{ id: "x", base: "staging", baseSha: "base", prs: [5, 6, 7, 8].map((pr, i) => ({ issue: i + 1, pr, head: hd(String(i + 1)) })), candidate: "forge-train/staging/x", candSha: "t_forge-train~staging~x_1,2,3,4", state: "bisecting", startedAt: 1,
        bisect: { runs: 3, budget: 3, failed: [{ name: "build", url: "u" }], frame: [3, 4], step: "probe", stale: [], at: 1, halves: 2 } }] };
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, saved, now: () => ++clock });
    assert.deepEqual(await t.tick(), []);
    assert.ok(t.snapshot().entries.every((e) => e.noBatch)); assert.equal(t.snapshot().batches.length, 0);
    assert.equal(w.calls.filter((a) => a[3] === "repos/o/r/git/refs").length, 0);
  });
  it("a resume mid-bisection re-reads the half's checks and rebuilds nothing; a phase-2a snapshot still restores", async () => {
    const w = bisectWorld(four(), { bad: (h) => h.includes("3") }); let clock = 0;
    const t = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, now: () => ++clock }); fill4(t);
    await ticks(t, 3); // build, red -> rerun, rerun red -> probe
    await t.tick(); // probe green -> first half built
    const snap = JSON.parse(JSON.stringify(t.snapshot()));
    assert.equal(snap.batches[0].bisect.step, "half");
    const built = w.calls.filter((a) => a[3] === "repos/o/r/git/refs" || a[3] === "repos/o/r/merges").length;
    const t2 = createMergeTrain({ gh: w.gh, repo: "o/r", batchSize: 4, saved: snap, now: () => ++clock });
    await t2.tick();
    assert.equal(w.calls.filter((a) => a[3] === "repos/o/r/git/refs" || a[3] === "repos/o/r/merges").length, built + 2, "only the next half (one ref + one merge)");
    assert.deepEqual(t2.snapshot().batches[0].bisect.frame, [3, 4]);
    const old = createMergeTrain({ gh: w.gh, repo: "o/r", saved: { entries: [], stats: { merged: 1, handedBack: {}, waits: [], syncs: 0, batches: 1, candidateRuns: 1 }, batches: [] } });
    assert.deepEqual([old.stats().bisections, old.stats().culprits], [0, 0]);
  });
});

describe("mergetrain phase 3 (#5839)", () => {
  it("replays the post-merge record: notes are posted and a keepOpen record leaves the issue open", async () => {
    const f = fake({ 5: { head: H, checks: [ok("build")] }, 6: { head: H, checks: [ok("build")], base: "main" } });
    const t = createMergeTrain({ gh: f.gh, repo: "o/r" });
    t.add(entry(1, 5, { postMerge: { keepOpen: true, notes: [{ marker: "FORGE:TRACKED", body: "left open" }] } }));
    await t.tick();
    assert.ok(f.calls.some((a) => a[0] === "issue" && a[1] === "comment" && a.join(" ").includes("FORGE:TRACKED")));
    assert.ok(!f.calls.some((a) => a[0] === "issue" && a[1] === "close"), "keepOpen: not closed");
    t.add(entry(2, 6, { lane: "main" }));
    await t.tick();
    assert.ok(f.calls.some((a) => a[0] === "issue" && a[1] === "close"), "a plain entry closes");
  });
  it("counts base.conflict hand-backs and lane-side counts per batch; p90 in the report line", async () => {
    const f = fake({ 5: { head: H, mergeable: "CONFLICTING", checks: [ok("build")] } });
    const t = createMergeTrain({ gh: f.gh, repo: "o/r" }); t.add(entry(1, 5, { laneSide: { syncs: 2, baseConflicts: 1 } }));
    const ev = await t.tick();
    assert.equal(ev[0].code, "base.conflict");
    const st = t.stats();
    assert.equal(st.baseConflicts, 1); assert.deepEqual(st.laneSide, { syncs: 2, baseConflicts: 1 });
    assert.match(formatTrainSummary({ ...st, waits: [60000, 120000, 600000] }), /p90 10\.0 min.*base\.conflict 1 \(lane 1\)/);
    assert.equal(waitP90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  });
  it("snapshot round-trips the record and counts; a phase-2 snapshot restores as zero", () => {
    const t = createMergeTrain({ gh: async () => "", repo: "o/r" });
    t.add(entry(1, 5, { postMerge: { keepOpen: false, notes: [] }, laneSide: { syncs: 1, baseConflicts: 0 } }));
    const snap = JSON.parse(JSON.stringify(t.snapshot()));
    const t2 = createMergeTrain({ gh: async () => "", repo: "o/r", saved: snap });
    assert.deepEqual(t2.snapshot().entries[0].postMerge, { keepOpen: false, notes: [] }); assert.equal(t2.stats().laneSide.syncs, 1);
    const old = { entries: [], stats: { merged: 2, handedBack: {}, waits: [], syncs: 1 } };
    const t3 = createMergeTrain({ gh: async () => "", repo: "o/r", saved: old });
    assert.deepEqual([t3.stats().baseConflicts, t3.stats().laneSide], [0, { syncs: 0, baseConflicts: 0 }]);
    t3.restore(old); assert.equal(t3.stats().baseConflicts, 0);
  });
});
