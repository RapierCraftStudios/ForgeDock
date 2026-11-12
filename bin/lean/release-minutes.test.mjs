// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseBudgetConfig, jobMinutes, releaseMinutes, trailingMedian, applyOnExceed, withinTolerance, monthlyModel, historyFromRoot, waveReport } from "./release-minutes.mjs";
import { runRelease, readReleaseConfig, newReleaseId, releaseFromCli } from "./release.mjs";

const job = (s, e) => ({ started_at: `2026-11-12T10:00:${s}Z`, completed_at: `2026-11-12T10:0${e}`, billable_ms: 0 });
const T = (m, s = "00") => ({ started_at: "2026-11-12T10:00:00Z", completed_at: `2026-11-12T10:${String(m).padStart(2, "0")}:${s}Z` });

describe("release minutes (#5569)", () => {
  it("sums ceil per job and ignores billable_ms and unfinished jobs", () => {
    assert.equal(jobMinutes({ jobs: [T(1, "01"), T(2, "00"), { started_at: "2026-11-12T10:00:00Z", completed_at: null }] }), 2 + 2);
    assert.equal(jobMinutes(null), 0);
  });
  it("sums the jobs of every run since the release started", async () => {
    const gh = async (a) => /\/jobs/.test(a[1]) ? JSON.stringify({ jobs: [T(1, "30")] }) : JSON.stringify({ workflow_runs: [{ id: 1 }, { id: 2 }] });
    assert.deepEqual(await releaseMinutes({ gh, repo: "o/r", sinceMs: 0 }), { runs: 2, minutes: 4 });
    assert.equal(await releaseMinutes({ gh: async () => "x", repo: "o/r", sinceMs: 0 }), null);
  });
  it("trailing median is per lane over the last n", () => {
    const rec = [{ lane: "release", minutes: 900 }, { lane: "release", minutes: 500 }, { lane: "release", minutes: 600 }, { lane: "train", minutes: 90 }];
    assert.equal(trailingMedian(rec, "release"), 600);
    assert.equal(trailingMedian(rec, "train"), 90);
    assert.equal(trailingMedian(rec, "p0"), null);
    assert.equal(trailingMedian([{ minutes: 1 }, { minutes: 3 }], "release"), 2);
  });
  it("on_exceed matrix; p0 and ignore never block", () => {
    const base = { forecast: 600, remaining: 100 };
    for (const v of ["local-first", "hold", "proceed"]) assert.equal(applyOnExceed({ ...base, cfg: parseBudgetConfig({ on_exceed: v }) }).action, v);
    assert.equal(parseBudgetConfig({ on_exceed: "bogus" }).onExceed, "local-first");
    assert.equal(applyOnExceed({ ...base, lane: "p0", cfg: parseBudgetConfig({ on_exceed: "hold" }) }).action, "proceed");
    assert.equal(applyOnExceed({ ...base, cfg: parseBudgetConfig({ on_exceed: "hold", ignore: "true" }) }).action, "proceed");
    assert.equal(applyOnExceed({ forecast: 50, remaining: 100, cfg: parseBudgetConfig({ on_exceed: "hold" }) }).action, "proceed");
    assert.equal(applyOnExceed({ forecast: null, remaining: 100, cfg: parseBudgetConfig({ on_exceed: "hold" }) }).action, "proceed");
  });
  it("25% tolerance and the monthly report", () => {
    assert.equal(withinTolerance(100, 125), true); assert.equal(withinTolerance(100, 126), false); assert.equal(withinTolerance(0, 1), false);
    const m = monthlyModel([{ name: "trains", model: 2700, measured: 3000 }, { name: "releases", model: 7500, measured: null }]);
    assert.equal(m.model, 10200); assert.equal(m.measured, 3000); assert.equal(m.within, true);
    assert.match(m.lines[1], /measured n\/a/);
  });
  it("reads recorded minutes from the release cache", () => {
    const root = tmpDir("rm");
    mkdirSync(join(root, "a")); writeFileSync(join(root, "a", "state.json"), JSON.stringify({ lane: "release", minutes: { total: 480 } }));
    mkdirSync(join(root, "b")); writeFileSync(join(root, "b", "state.json"), "{}");
    assert.deepEqual(historyFromRoot(root), [{ lane: "release", minutes: 480 }]);
    assert.deepEqual(historyFromRoot(join(root, "none")), []);
  });
});

describe("release report (#5569)", () => {
  it("compares the first 3 waves with the model and says when it is outside 25%", () => {
    const rec = (...m) => m.map((minutes) => ({ lane: "release", minutes }));
    assert.match(waveReport(rec(480, 520, 560)).lines.at(-1), /within 25%/);
    assert.match(waveReport(rec(900, 900, 900)).lines.at(-1), /OUTSIDE 25%/);
    assert.match(waveReport(rec(500)).lines.at(-1), /1\/3 waves/);
  });
  it("`forgedock release report` prints it", async () => {
    const root = tmpDir("rep"), cwd = tmpDir("repcwd"), out = [];
    mkdirSync(join(root, "a")); writeFileSync(join(root, "a", "state.json"), JSON.stringify({ minutes: { total: 500 } }));
    const code = await releaseFromCli(["report"], { cwd, env: { FORGEDOCK_RELEASE_DIR: root }, io: { print: (l) => out.push(l) } });
    assert.equal(code, 0); assert.match(out.join("\n"), /release wave 1: model 500 min, measured 500/);
  });
});

describe("runRelease managed gate (#5569)", () => {
  const mkIo = (over = {}) => {
    const calls = [], printed = [];
    const api = async (m, p) => { calls.push(`${m} ${p}`); if (m === "GET" && /git\/ref\/heads/.test(p)) { const e = new Error("HTTP 404"); e.status = 404; throw e; } if (m === "GET") return { tree: { sha: "t" } }; return { sha: "s" }; };
    return { calls, printed, now: () => 1_700_000_000_000, print: (l) => printed.push(l), api, git: () => "", sleep: async () => {}, runningLanes: async () => [], batches: async () => [], setParallel: async () => {},
      gh: async (a) => { calls.push(a.join(" ")); if (over.gh) { const r = over.gh(a); if (r !== undefined) return r; } return "[]"; }, ...over.io };
  };
  const stub = { preflight: async () => ({ skipped: true }) };
  const steps = new Proxy({}, { get: () => async () => ({ skipped: true }) });
  const red = (a) => /workflows/.test(a[1] ?? "") ? JSON.stringify({ workflow_runs: [{ id: 1, created_at: new Date(1_700_000_000_000 - 3600_000).toISOString() }] })
    : /runs\/1\/jobs/.test(a[1] ?? "") ? JSON.stringify({ jobs: [{ name: "T1 unit", conclusion: "failure" }] })
    : a[0] === "issue" && a[1] === "list" ? "[]" : a[0] === "issue" ? "https://github.com/o/r/issues/5" : undefined;
  const cfg = (extra = "") => readReleaseConfig(`release:\n  managed: true\nnightly:\n  workflow: nightly.yml\n${extra}`);

  it("a red T1 nightly blocks a release, files nightly-red, and never blocks p0", async () => {
    const io = mkIo({ gh: red });
    const r = await runRelease({ io, repo: "o/r", config: cfg(), root: tmpDir("g1"), id: newReleaseId(), steps, opts: {} });
    assert.equal(r.status, "blocked"); assert.equal(r.step, "gate"); assert.match(r.reason, /T1 unit/);
    assert.ok(io.calls.some((c) => /^issue create .*nightly-red/.test(c)));
    const p0 = await runRelease({ io: mkIo({ gh: red }), repo: "o/r", config: cfg(), root: tmpDir("g2"), id: newReleaseId(), steps, opts: { lane: "p0" } });
    assert.equal(p0.status, "done");
    assert.ok(!io.calls.some((c) => /git\/refs/.test(c)), "a blocked gate writes no ledger");
  });
  it("managed off makes no nightly or minutes call", async () => {
    const io = mkIo({ gh: red });
    const r = await runRelease({ io, repo: "o/r", config: readReleaseConfig("nightly:\n  workflow: nightly.yml\n"), root: tmpDir("g3"), id: newReleaseId(), steps, opts: {} });
    assert.equal(r.status, "done");
    assert.deepEqual(io.calls, []);
  });
});
