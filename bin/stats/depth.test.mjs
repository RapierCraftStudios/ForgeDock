// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { INSUFFICIENT, buildDepth, depthReport, depthRows, gatherDefects, promotion, renderDepth } from "./depth.mjs";
import { parseArgs, HELP } from "./index.mjs";

const T0 = Date.parse("2026-10-01T00:00:00Z"), MIN = 60000, DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

/** One synthetic RUN_START..RUN_TERMINAL slice. */
function slice({ issue = 1, repo = "o/r", at = T0, verdict = "eligible", reasons = [], signals = ["repro"], shape = "full", reason = "merged",
  cost = 1, wall = 30 * MIN, model = 25 * MIN, size = "S", pr = 100 + issue, rework = false, conformance = [], verifier = 0, elig = true, ff = null } = {}) {
  const ev = [{ event: "RUN_START", issue, repo, ts: iso(at) }];
  if (elig) ev.push({ event: "LIGHT_ELIGIBILITY", mode: "shadow", verdict, light: false, reasons: reasons.map((code) => ({ code, detail: "" })), signals: signals.map((code) => ({ code, detail: "" })) });
  if (ff) ev.push({ event: "FASTFORWARD_ELIGIBILITY", mode: "on", verdict: ff.eligible ? "eligible" : "ineligible", light: ff.eligible && !ff.shadow, reasons: [], signals: [], ...ff });
  if (shape === "light") ev.push({ event: "LIGHT_DONE" });
  if (shape === "upgraded") ev.push({ event: "LIGHT_UPGRADE", reasons: [] });
  ev.push({ event: "PHASE_ATTEMPT_USAGE", phase: "implement", trigger: "build", cost_usd_delta: cost });
  if (rework) ev.push({ event: "PHASE_ATTEMPT_USAGE", phase: "implement", trigger: "review", cost_usd: 0 });
  for (const c of conformance) ev.push({ event: "CONFORMANCE", state: c.state, failures: c.failures });
  if (verifier) ev.push({ event: "VERIFIER", findings: verifier });
  ev.push({ event: "PR_OPENED", pr });
  ev.push({ event: "RUN_TERMINAL", reason, ts: iso(at + wall), wall_ms: wall, model_ms: model, turns: { size } });
  return ev;
}

test("depthRows: one row per slice with LIGHT_ELIGIBILITY and RUN_TERMINAL, filtered by repo and since", () => {
  const ev = [...slice({ issue: 7, reasons: ["hotspot"], verdict: "ineligible", rework: true, conformance: [{ state: "fails", failures: [1, 2] }], verifier: 3 }),
    ...slice({ issue: 7, elig: false }), ...slice({ issue: 7, at: T0 + DAY, shape: "light", reason: "needs-human", repo: "O/R" })];
  const rows = depthRows(ev, { repo: "o/r" });
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  assert.deepEqual([a.issue, a.verdict, a.reasons, a.signals, a.shape, a.merged, a.firstPass, a.cost, a.findings, a.conformanceFailures, a.size, a.pr],
    [7, "ineligible", ["hotspot"], ["repro"], "full", true, false, 1, 5, 1, "S", 107]);
  assert.deepEqual([b.shape, b.needsHuman, b.merged, b.firstPass], ["light", true, false, true]);
  assert.equal(depthRows(ev, { repo: "x/y" }).length, 0);
  assert.equal(depthRows(ev, { sinceMs: T0 + DAY / 2 }).length, 1);
});

const rowsOf = (...slices) => slices.flatMap((s) => depthRows(slice(s)));

test("depthReport: verdict cells carry merge, first-pass, needs-human, median cost, wall, findings and defect rate", () => {
  const rows = rowsOf({ issue: 1, cost: 1 }, { issue: 2, cost: 3, rework: true, verifier: 2 }, { issue: 3, cost: 2, reason: "needs-human" },
    { issue: 4, verdict: "ineligible", reasons: ["size"], signals: ["size_M"] });
  const defects = new Map([[1, { defect: true }], [2, { defect: false }]]);
  const rep = depthReport({ rows, defects, minN: 1 });
  const e = rep.by_verdict.eligible;
  assert.deepEqual([e.n, e.merge_rate, e.needs_human_rate, e.median_cost_usd, e.median_wall_min, e.median_wall_over_model, e.findings_per_lane, e.share_with_findings, e.defect_rate, e.defects_n],
    [3, 0.6667, 0.3333, 2, 30, 1.2, 0.67, 0.3333, 0.5, 2]);
  assert.equal(e.first_pass_rate, 0.6667);
  assert.equal(rep.by_verdict.ambiguous.n, 0);
  assert.equal(rep.by_verdict.ineligible.n, 1);
  assert.deepEqual(Object.keys(rep.by_code), ["repro", "size", "size_M"]);
  assert.equal(rep.by_code.repro.n, 3);
  assert.equal(rep.by_code.size.n, 1);
});

test("promotion: met, not met and insufficient data below min-n, with n per cell", () => {
  const light = (i, o = {}) => ({ issue: i, shape: "light", cost: 1, wall: 12 * MIN, model: 10 * MIN, ...o });
  const full = (i, o = {}) => ({ issue: 100 + i, cost: 1, ...o });
  const rows = rowsOf(light(1), light(2), full(1), full(2), full(3, { size: "L" }));
  const p = promotion(rows, new Map([[1, { defect: false }], [2, { defect: false }], [101, { defect: false }], [102, { defect: true }]]), 2);
  assert.deepEqual(p.sizes, ["S"]);
  assert.deepEqual([p.n_treatment, p.n_control], [2, 2], "size L control excluded");
  assert.deepEqual([p.checks.cost.value, p.checks.cost.met, p.checks.cost.n_treatment, p.checks.cost.n_control], [1, true, 2, 2]);
  assert.deepEqual([p.checks.wall.value, p.checks.wall.met], [1.2, true]);
  assert.deepEqual([p.checks.defects.value, p.checks.defects.limit, p.checks.defects.met], [0, 0.5, true]);
  assert.equal(p.met, true);
  assert.match(p.note, /config decision/);
  const costly = promotion(rowsOf(light(1, { cost: 5 }), light(2, { cost: 5 }), full(1), full(2)), new Map(), 2);
  assert.equal(costly.checks.cost.met, false);
  assert.equal(costly.checks.defects.verdict, INSUFFICIENT);
  assert.equal(costly.met, false);
  const few = promotion(rows, new Map(), 10);
  assert.deepEqual([few.met, few.checks.cost.verdict, few.checks.cost.met, few.checks.wall.verdict], [INSUFFICIENT, INSUFFICIENT, null, INSUFFICIENT]);
});

const fakeGh = (o = {}) => async (args) => {
  const path = args.find((x) => /^(search|repos)\//.test(x)) ?? "";
  if (o.fail) throw new Error("gh down");
  const ev = /issues\/(\d+)\/events/.exec(path);
  if (ev) return ev[1] === "2" ? JSON.stringify({ issue: 2, ts: iso(T0 + 2 * DAY) }) : "";
  if (path.startsWith("search/issues")) return [
    { number: 300, title: "Revert \"feat: x (#101)\"", body: "", labels: [], merged_at: iso(T0 + DAY) },
    { number: 301, title: "fix: y", body: "", labels: [], merged_at: iso(T0 + 2 * DAY) },
    { number: 302, title: "fix: late", body: "", labels: [], merged_at: iso(T0 + 30 * DAY) },
    { number: 303, title: "fix: rewrite z", body: "", labels: [], merged_at: iso(T0 + 2 * DAY) },
    { number: 304, title: "fix: regression from #105", body: "", labels: [], merged_at: iso(T0 + 3 * DAY) },
  ].map((x) => JSON.stringify(x)).join("\n");
  const m = /pulls\/(\d+)$/.exec(path);
  return m ? `sha${m[1]}` : "";
};
// Local git: fix PR 303 rewrites lines of PR 104; every other fix PR (301 touches a shared file) rewrites someone else's lines.
const fakeGit = { oldRanges: (sha) => [{ file: "src/shared.js", start: 1, end: 5 }], blame: (rev) => (rev === "sha303^" ? ["sha104"] : ["sha999"]) };

test("depth defect: unrelated fix on a shared file is not a defect, one rewriting the lane's lines is", async () => {
  const rows = rowsOf({ issue: 3 }, { issue: 4 });
  const d = await gatherDefects({ repo: "o/r", gh: fakeGh(), rows, git: fakeGit });
  assert.deepEqual(d.get(3), { reopen: false, revert: false, cited: false, same_hunks: false, defect: false }, "fix 301/303 touch the shared file but not this PR's lines; 302 is out of window");
  assert.deepEqual(d.get(4), { reopen: false, revert: false, cited: false, same_hunks: true, defect: true });
});

test("gatherDefects: reverted, reopened, cited and same_hunks; no git is n/a unless another signal; gh failure is null, never false", async () => {
  const rows = rowsOf({ issue: 1 }, { issue: 2 }, { issue: 3 }, { issue: 5 });
  const d = await gatherDefects({ repo: "o/r", gh: fakeGh(), rows, git: fakeGit });
  assert.deepEqual(d.get(1), { reopen: false, revert: true, cited: false, same_hunks: false, defect: true });
  assert.deepEqual(d.get(2), { reopen: true, revert: false, cited: false, same_hunks: false, defect: true });
  assert.deepEqual(d.get(5), { reopen: false, revert: false, cited: true, same_hunks: false, defect: true });
  const nogit = await gatherDefects({ repo: "o/r", gh: fakeGh(), rows });
  assert.deepEqual(nogit.get(3), { reopen: false, revert: false, cited: false, same_hunks: null, defect: null }, "unresolved same_hunks is n/a, not a defect");
  assert.equal(nogit.get(1).defect, true, "another signal still decides");
  const rep = depthReport({ rows, defects: nogit, minN: 1 });
  assert.equal(rep.defects_unresolved, 1);
  assert.match(renderDepth(rep), /1 unresolved/);
  const bad = await gatherDefects({ repo: "o/r", gh: fakeGh({ fail: true }), rows, git: fakeGit });
  assert.deepEqual(bad.get(1), { reopen: null, revert: null, cited: null, same_hunks: null, defect: null });
  assert.equal(depthReport({ rows, defects: bad, minN: 1 }).by_verdict.eligible.defect_rate, null);
});

test("gatherDefects (#5318): per-issue events, windowed search, a warm cache makes zero gh calls, progress is reported", async () => {
  const dir = tmpDir("depth-cache-");
  const env = { FORGE_STATS_CACHE_DIR: join(dir, "cache") };
  const rows = rowsOf({ issue: 1 }, { issue: 2 }, { issue: 3 });
  const now = T0 + 60 * DAY, git = fakeGit;
  const calls = [];
  const gh = async (args) => { calls.push(args[2]); return fakeGh()(args); };
  const prog = [];
  const cold = await gatherDefects({ repo: "o/r", gh, rows, now, env, useCache: true, git, onProgress: (p) => prog.push(p) });
  assert.equal(cold.get(2).reopen, true);
  assert.ok(!calls.some((c) => c.includes("/issues/events")), "no repo-wide events crawl");
  assert.ok(calls.some((c) => /merged%3A\d{4}-\d{2}-\d{2}\.\./.test(c)), "search bounded to the merge window");
  assert.equal(prog.at(-1).done, 3);
  const n = calls.length;
  const warm = await gatherDefects({ repo: "o/r", gh, rows, now, env, useCache: true, git });
  assert.equal(calls.length, n, "warm run makes no gh calls");
  assert.deepEqual([...warm], [...cold]);
  await gatherDefects({ repo: "o/r", gh, rows, now, env, useCache: true, refresh: true, git });
  assert.ok(calls.length > n, "--refresh re-reads");
  const fresh = calls.length;
  await gatherDefects({ repo: "o/r", gh, rows, now: T0 + DAY, env, useCache: true, git });
  assert.ok(calls.length > fresh, "a row inside its window is never served from the cache");
});

test("depthReport recommendation: decision, eligible share, would-be saving and defect rate; rendered", () => {
  const rows = rowsOf({ issue: 1, shape: "light", cost: 0.5 }, { issue: 2, cost: 2 }, { issue: 3, cost: 2 }, { issue: 4, verdict: "ineligible" });
  const rep = depthReport({ rows, defects: new Map([[2, { defect: true }], [3, { defect: false }]]), minN: 1 });
  const rc = rep.recommendation;
  assert.equal(rc.eligible_n, 3);
  assert.equal(rc.eligible_share, 0.75);
  assert.equal(rc.would_be_saving_usd, 3, "2 eligible full lanes x (2 - 0.5)");
  assert.equal(rc.eligible_defect_rate, 0.5);
  assert.ok(["promote", "do not promote", INSUFFICIENT].includes(rc.decision));
  assert.match(renderDepth(rep), /^recommendation: .*eligible share 75% \(n=3\), would-be saving \$3\.00/m);
  assert.equal(depthReport({ rows: [], minN: 10 }).recommendation.decision, INSUFFICIENT);
});

test("#5426 fast-forward report: eligibility rate over lanes with an investigation verdict, outcomes of fast-forwarded merges", () => {
  const rows = rowsOf({ issue: 1, shape: "light", ff: { eligible: true } }, { issue: 2, shape: "light", ff: { eligible: true } },
    { issue: 3, shape: "upgraded", ff: { eligible: true }, reason: "needs-human" }, { issue: 4, ff: { eligible: false } }, { issue: 5, ff: { eligible: true, shadow: true } },
    { issue: 6 });
  assert.deepEqual(rows.map((x) => x.ff?.eligible ?? null), [true, true, true, false, true, null]);
  const defects = new Map([[1, { defect: true, revert: true }], [2, { defect: false, revert: false }]]);
  const f = depthReport({ rows, defects }).fast_forward;
  assert.equal(f.lanes, 5); assert.equal(f.eligible_n, 4); assert.equal(f.eligibility_rate, 0.8); assert.equal(f.shadow_n, 1);
  assert.equal(f.fast_forwarded.n, 2); assert.equal(f.fast_forwarded.merge_rate, 1);
  assert.equal(f.fast_forwarded.defect_rate, 0.5); assert.equal(f.fast_forwarded.revert_rate, 0.5); assert.equal(f.fast_forwarded.reverts_n, 2);
  assert.equal(f.upgraded.n, 1); assert.equal(f.upgraded.needs_human_rate, 1);
  assert.equal(f.full_lane.n, 2, "ineligible and shadow lanes ran the full lane");
  const text = renderDepth(depthReport({ rows, defects }));
  assert.match(text, /fast-forward \(#5426.*5 lane\(s\).*eligible 80% \(n=4, 1 shadow\)/);
  assert.match(text, /fast-forwarded: n=2.*reverts 50% \(n=2\)/);
  assert.equal(depthReport({ rows: rowsOf({ issue: 9 }) }).fast_forward.lanes, 0);
  assert.ok(!/fast-forward \(#5426/.test(renderDepth(depthReport({ rows: rowsOf({ issue: 9 }) }))), "no line without data");
});
