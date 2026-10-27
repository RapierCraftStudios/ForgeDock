// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { compoundingReport, renderCompounding, bucketLabel, gitProbes } from "./compounding.mjs";
import { parseArgs } from "./index.mjs";

const NOW = Date.parse("2026-10-24T00:00:00Z"), DAY = 86400000, S = (d) => Math.floor((NOW - d * DAY) / 1000);
const run = (issue, daysAgo, version = "1.0.0") => ({ issue, reason: "merged", version, endTs: new Date(NOW - daysAgo * DAY).toISOString() });
const guard = (issue, sha) => ({ v: 1, issue, merge_sha: sha, tests: [{ path: "t.mjs", ids: [] }], hunks: [] });
// shas: a (issue 1, 40d ago), b (issue 2, 10d ago), c (issue 3, 1d ago)
const TIMES = { a: S(40), b: S(10), c: S(1) };
const fakeGit = (blames = {}) => ({ time: (s) => TIMES[s] ?? null, oldRanges: (s) => [{ file: "f.mjs", start: 1, end: 3 }], blame: (rev) => blames[rev] ?? [] });
const base = { runs: [run(1, 40), run(2, 10), run(3, 1)], guards: [guard(1, "a"), guard(2, "b"), guard(3, "c")], now: NOW, minN: 1 };

test("reintroduction (b): a later fix whose old lines blame to an earlier fix within 90 days", () => {
  const r = compoundingReport({ ...base, git: fakeGit({ "b^": ["a"] }) });
  assert.deepEqual(r.rolling.reintroduction, { guarded: 2, reintroduced: 0, rate: 0 }); // 30d window holds fixes 2, 3; the broken fix is #1 (40d ago)
  assert.equal(r.sources.blame_hits, 1);
  const all = Object.values(r.by_lane_age)[0];
  assert.deepEqual(all.reintroduction, { guarded: 3, reintroduced: 1, rate: 0.333 });
});

test("reintroduction (b): older than 90 days or unknown time does not count; unresolved is reported, not zeroed", () => {
  const far = { ...base, guards: [guard(1, "a"), guard(2, "b")], runs: [run(1, 200), run(2, 10)] };
  const r = compoundingReport({ ...far, git: { ...fakeGit({ "b^": ["a"] }), time: (s) => ({ a: S(200), b: S(10) })[s] ?? null } });
  assert.equal(r.sources.blame_hits, 0);
  const u = compoundingReport({ ...base, git: { time: () => null, oldRanges: () => null, blame: () => null } });
  assert.equal(u.sources.blame_unresolved, 3);
  assert.equal(u.sources.blame_hits, 0);
});

test("reintroduction (a) and reopen-after-close: reopen after the lane closed the issue", () => {
  const reopens = [{ issue: 2, ts: new Date(NOW - 5 * DAY).toISOString() }, { issue: 3, ts: new Date(NOW - 3 * DAY).toISOString() /* before close? no: close was 1d ago */ }];
  const r = compoundingReport({ ...base, reopens, git: fakeGit() });
  assert.equal(r.rolling.reopen_after_close.reopened, 1); // issue 2 reopened after its close; issue 3's reopen predates its close
  assert.equal(r.rolling.reintroduction.reintroduced, 1);
  assert.equal(r.rolling.lanes, 2);
});

test("guard and decision counts are n/a until a kind is recorded, then counted per window", () => {
  const none = compoundingReport({ ...base, git: fakeGit() });
  assert.equal(none.rolling.guard.broken_caught, null);
  assert.equal(none.rolling.decisions.violations, null);
  const events = [{ event: "guard_broken", issue: 2, ts: new Date(NOW - DAY).toISOString(), version: "1.0.0" }, { event: "guard_broken", issue: 1, ts: new Date(NOW - 60 * DAY).toISOString(), version: "1.0.0" }];
  const r = compoundingReport({ ...base, events, git: fakeGit() });
  assert.equal(r.rolling.guard.broken_caught, 1);
  assert.equal(r.rolling.guard.tests_run, null);
  assert.equal(r.by_release["1.0.0"].guard.broken_caught, 2);
});

test("lane-age buckets by merge order and rendering", () => {
  assert.deepEqual([1, 100, 101, 500, 501, null].map((n) => bucketLabel(n, [100, 500])), ["1-100", "1-100", "101-500", "101-500", "501+", "unranked"]);
  const runs = Array.from({ length: 4 }, (_, i) => run(i + 1, 40 - i));
  const r = compoundingReport({ runs, guards: [], buckets: [2], now: NOW, minN: 1, git: fakeGit() });
  assert.deepEqual(Object.keys(r.by_lane_age), ["1-2", "3+"]);
  assert.equal(r.by_lane_age["3+"].lanes, 2);
  assert.match(renderCompounding(r), /by lane age:\n  1-2: 2 lanes, reintroduction n\/a \(0\/0\)/);
});

test("gitProbes degrades to null outside a repo or for an unknown sha", () => {
  const g = gitProbes("/nonexistent-dir-for-compounding");
  assert.equal(g.time("deadbeef"), null);
  assert.equal(g.oldRanges("deadbeef"), null);
  assert.equal(g.blame("deadbeef^", "x", 1, 2), null);
});

test("parseArgs: --compounding takes --window and --bucket; --bucket alone is rejected", () => {
  const o = parseArgs(["--compounding", "--window", "30d", "--bucket", "50,200"]);
  assert.equal(o.compounding, true);
  assert.deepEqual(o.bucket, [50, 200]);
  assert.throws(() => parseArgs(["--bucket", "10"]), /needs --compounding/);
  assert.throws(() => parseArgs(["--compounding", "--bucket", "9,5"]), /increasing/);
});
