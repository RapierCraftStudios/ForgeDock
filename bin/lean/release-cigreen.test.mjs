// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6164: the default ci-green step: wait for required checks, rerun a failed check once, flake = green + issue, real red = one fix round.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ciGreenStep, ciGreenWait, flakyTestName, blockSetOf, ciGreenKeys, addTiming } from "./release-cigreen.mjs";
import { RELEASE_STEPS, readReleaseConfig } from "./release.mjs";

const H = "c".repeat(40);
const link = (id) => `https://github.com/o/r/actions/runs/${id}/job/1`;
/** Seam over a script of check snapshots: `snaps[i]` is what the i-th `checks` call returns (the last repeats). */
function seam(snaps, o = {}) {
  const log = []; let i = 0, t = 0;
  return {
    log,
    now: () => t, sleep: async (ms) => { t += ms; log.push("sleep"); },
    isDraft: async () => o.draft ?? false,
    headOf: async () => H,
    checks: async () => snaps[Math.min(i++, snaps.length - 1)],
    required: async () => o.required ?? ["build"],
    runAttempt: async () => o.attempt ?? 1,
    failedLog: async () => o.log ?? "not ok 3 - parses the thing\n  error: boom",
    rerunFailed: async (id) => { log.push(`rerun:${id}`); },
    fileFlake: async (a) => { log.push(`flake:${a.check}:${a.test}`); return 77; },
  };
}
const ctx = (s, extra = {}) => ({ io: { ciGreen: s, print() {} }, repo: "o/r", def: "main", config: {}, state: { steps: { "release-pr": { done: true, result: { pr: 7 } } } }, save() {}, ...extra });
const row = (bucket, id = 1) => ({ name: "build", bucket, link: link(id) });

describe("ci-green step (#6164)", () => {
  it("is a default release step between release-pr and review", () => {
    const i = RELEASE_STEPS.indexOf("ci-green");
    assert.equal(RELEASE_STEPS[i - 1], "release-pr"); assert.equal(RELEASE_STEPS[i + 1], "review");
  });
  it("waits while required checks are pending, then continues when green", async () => {
    const s = seam([[row("pending")], [row("pending")], [row("pass")]]);
    const r = await ciGreenStep(ctx(s));
    assert.equal(r.green, true); assert.equal(s.log.filter((x) => x === "sleep").length, 2);
  });
  it("a required check that has not reported yet is pending, not green", async () => {
    const s = seam([[], [row("pass")]]);
    assert.equal((await ciGreenStep(ctx(s))).green, true); assert.equal(s.log.length, 1);
  });
  it("blocks when checks stay pending past the wait cap", async () => {
    const r = await ciGreenStep(ctx(seam([[row("pending")]]), { config: { ciGreen: { maxWaitMin: 1 } } }));
    assert.equal(r.blocked, true); assert.match(r.reason, /still pending after 1 min \(build\)/);
  });
  it("a failure that passes on one rerun is green, files a flaky-test issue naming the test, and does not block", async () => {
    const s = seam([[row("fail", 5)], [row("pending", 5)], [row("pass", 5)]]);
    const c = ctx(s);
    const r = await ciGreenStep(c);
    assert.equal(r.green, true);
    assert.deepEqual(s.log.filter((x) => x !== "sleep"), ["rerun:5", "flake:build:parses the thing"]);
    assert.deepEqual(r.flakes, [{ check: "build", test: "parses the thing", issue: 77 }]);
    assert.equal(c.state.ciGreen.flakes.length, 1);
  });
  it("a check still red after its one rerun is real: one fix round, then wait again; green afterwards continues", async () => {
    const s = seam([[row("fail", 5)], [row("fail", 5)], [row("pass", 6)]]);
    const c = ctx(s, { io: { ciGreen: s, print() {}, review: {} } });
    let fixed = 0;
    c.fixRoundStub = () => { fixed++; c.state.fixloop = { heads: { [H]: { rounds: 1 } } }; return { head: "d".repeat(40) }; };
    const r = await ciGreenWait(c, 7, { noFix: true });
    assert.equal(r.red, true); assert.deepEqual(r.failing, ["build"]); assert.equal(fixed, 0, "noFix never starts a fix");
    assert.deepEqual(s.log.filter((x) => x.startsWith("rerun")), ["rerun:5"], "rerun exactly once");
  });
  it("red after the fix round is spent blocks instead of fixing again", async () => {
    const s = seam([[row("fail", 5)]]);
    const c = ctx(s); c.state.fixloop = { heads: { [H]: { rounds: 1 } } };
    c.state.ciGreen = { heads: { [H]: { reran: ["build"], firstFail: {}, filed: [] } }, flakes: [] };
    const r = await ciGreenWait(c, 7);
    assert.equal(r.blocked, true); assert.match(r.reason, /one fix round is spent/);
  });
  it("respects the rerun attempt cap (#6014): no rerun past it, the check stays red", async () => {
    const s = seam([[row("fail", 5)]], { attempt: 3 });
    const r = await ciGreenWait(ctx(s), 7, { noFix: true });
    assert.equal(r.red, true); assert.ok(!s.log.some((x) => x.startsWith("rerun")));
  });
  it("a draft release PR (host preflight mode) is skipped: CI starts at mark-ready", async () => {
    const r = await ciGreenStep(ctx(seam([[row("fail")]], { draft: true })));
    assert.match(r.skipped, /draft/);
  });
  it("the open-finding gate runs first: an open review-finding issue blocks before any CI is read", async () => {
    const s = seam([[row("pass")]]); let read = 0; const checks = s.checks; s.checks = async (a) => { read++; return checks(a); };
    s.openGate = async () => "RESULT: BLOCK DEPLOY (open finding #12)";
    const r = await ciGreenStep(ctx(s));
    assert.equal(r.blocked, true); assert.match(r.reason, /^open-finding gate: .*#12/); assert.equal(read, 0);
    s.openGate = async () => null;
    assert.equal((await ciGreenStep(ctx(s))).green, true);
  });
  it("records ci_green_min in state.timing", async () => {
    const c = ctx(seam([[row("pass")]]));
    await ciGreenStep(c);
    assert.equal(typeof c.state.timing.ci_green_min, "number");
    addTiming(c, "review_passes", 2, { raw: true }); assert.equal(c.state.timing.review_passes, 2);
  });
});

describe("helpers (#6164)", () => {
  it("flakyTestName reads tap, node runner, jest, pytest and cargo logs", () => {
    assert.equal(flakyTestName("ok 1 - a\nnot ok 2 - writes the file"), "writes the file");
    assert.equal(flakyTestName("  ✖ retries once (12.3ms)"), "retries once");
    assert.equal(flakyTestName("  ● suite › case"), "suite › case");
    assert.equal(flakyTestName("FAILED tests/test_a.py::test_b - boom"), "tests/test_a.py::test_b");
    assert.equal(flakyTestName("test mod::it_works ... FAILED"), "mod::it_works");
    assert.equal(flakyTestName("no pattern here"), null);
  });
  it("block severity defaults to CRITICAL+HIGH; forge.yaml only tightens or loosens it", () => {
    assert.deepEqual([...blockSetOf({})], ["CRITICAL", "HIGH"]);
    assert.deepEqual([...blockSetOf({ blockSeverity: "CRITICAL" })], ["CRITICAL"]);
    assert.deepEqual([...blockSetOf({ blockSeverity: "MEDIUM" })], ["CRITICAL", "HIGH", "MEDIUM"]);
    assert.deepEqual(ciGreenKeys({ block_severity: "medium", ci_green_max_wait_min: "25" }), { blockSeverity: "MEDIUM", ciGreen: { maxWaitMin: 25 } });
    assert.deepEqual(ciGreenKeys({}), {}, "no key switches the flow off; absent keys leave the defaults");
    assert.deepEqual(readReleaseConfig("release:\n  block_severity: critical\n").blockSeverity, "CRITICAL");
  });
});
