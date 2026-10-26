// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "./aggregate.mjs";
import { parseArgs } from "./index.mjs";
import { METRICS_MARKER, metricsComment, postMetrics, releaseMetrics, renderReleaseMetrics } from "./release.mjs";

const trig = (fp) => [{ trigger: "build" }, ...(fp ? [] : [{ trigger: "review" }])];
function runs(version, n, { usd, wall, fp, human }) {
  return Array.from({ length: n }, (_, i) => ({
    source: "github", repo: "o/r", version, issue: i + (version === "1.2.0" ? 100 : 0),
    finished: true, usageEvents: 1, reason: i < human ? "needs-human" : "merged", wallMs: wall, endTs: "2026-10-01T00:00:00Z",
    phases: { build: { usd, cr: 1, ms: 1 } }, builderAttempts: trig(i < fp),
  }));
}
const groupsFor = (all, minN = 10) => aggregate({ runs: all }, { minN }).groups;

describe("releaseMetrics (#4628)", () => {
  const prev = runs("1.1.0", 12, { usd: 2, wall: 600000, fp: 6, human: 1 });
  it("compares each metric with the previous release and never reports a pass", () => {
    const cur = runs("1.2.0", 12, { usd: 3, wall: 300000, fp: 11, human: 1 });
    const rm = releaseMetrics(groupsFor([...prev, ...cur]), { minN: 10 });
    const v = rm.versions[1];
    assert.equal(v.against, "1.1.0");
    assert.deepEqual(v.verdicts, { usd_median: "regressed", wall_p50_ms: "improved", first_pass_rate: "improved", needs_human_rate: "flat" });
    assert.equal(rm.versions[0].verdicts.usd_median, null);
    assert.ok(!JSON.stringify(rm).includes("pass\""));
  });
  it("is null below min n, and the verdict is null when either side is", () => {
    const cur = runs("1.2.0", 3, { usd: 9, wall: 1, fp: 0, human: 3 });
    const rm = releaseMetrics(groupsFor([...prev, ...cur]), { minN: 10 });
    const v = rm.versions[1];
    assert.deepEqual([v.usd_median, v.wall_p50_ms, v.first_pass_rate, v.needs_human_rate], [null, null, null, null]);
    assert.deepEqual(Object.values(v.verdicts), [null, null, null, null]);
    assert.match(renderReleaseMetrics(rm), /n\/a/);
  });
  it("skips unknown versions", () => {
    const rm = releaseMetrics(groupsFor(runs(null, 12, { usd: 1, wall: 1, fp: 1, human: 0 })), { minN: 1 });
    assert.deepEqual(rm.versions, []);
  });
});

describe("FORGE:METRICS comment (#4628)", () => {
  const rm = releaseMetrics([], { minN: 10, repo: "o/r" });
  it("carries the marker and the JSON snapshot", () => {
    const b = metricsComment(rm);
    assert.ok(b.startsWith(METRICS_MARKER));
    assert.deepEqual(JSON.parse(/```json\n(.*)\n```/s.exec(b)[1]), rm);
  });
  it("creates the comment, then updates it", async () => {
    const calls = [];
    const mk = (list) => (args) => { calls.push(args.join(" ")); return args[0] === "api" && args.length === 3 ? JSON.stringify(list) : ""; };
    assert.equal(await postMetrics({ gh: mk([{ id: 1, body: "x" }]), repo: "o/r", pr: 7, body: "b" }), "created");
    assert.match(calls.at(-1), /-X POST repos\/o\/r\/issues\/7\/comments/);
    assert.equal(await postMetrics({ gh: mk([{ id: 5, body: `${METRICS_MARKER}\nold` }]), repo: "o/r", pr: 7, body: "b" }), "updated");
    assert.match(calls.at(-1), /-X PATCH repos\/o\/r\/issues\/comments\/5/);
  });
});

describe("--by / --post-metrics parsing (#4628)", () => {
  it("accepts version and a PR number; rejects the rest", () => {
    assert.equal(parseArgs(["--by", "version", "--post-metrics", "12"]).postMetrics, 12);
    assert.throws(() => parseArgs(["--by", "repo"]), /--by must be version/);
    assert.throws(() => parseArgs(["--post-metrics", "12"]), /needs --by version/);
    assert.throws(() => parseArgs(["--by", "version", "--post-metrics", "x"]), /PR number/);
  });
});
