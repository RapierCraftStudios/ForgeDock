// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { batchRowsFromDisk, buildScorecard, renderScorecard, scorecardComment, parseScorecardArgs, runScorecard, gatherScorecard, SCORECARD_MARKER } from "./scorecard.mjs";

const run = (version, i, o = {}) => ({ version, issue: i, finished: true, reason: "merged", remediated: false, wallMs: 600000, verified: true,
  phases: { implement: { usd: 2, ms: 300000 } }, builderAttempts: [{ attempt: 1 }], ...o });
const many = (v, n, f) => Array.from({ length: n }, (_, i) => run(v, i, f?.(i)));

describe("scorecard", () => {
  it("computes metrics from fixtures; sources that are absent are null", () => {
    const sc = buildScorecard({ records: many("1.0.0", 10), release: "1.0.0", minN: 5 });
    assert.equal(sc.values.first_pass_rate, 1);
    assert.equal(sc.values.minutes_per_merge, 10);
    assert.equal(sc.values.usd_per_merge, 2);
    assert.equal(sc.values.active_min, 5);
    assert.equal(sc.values.stuck_issues, 0);
    assert.equal(sc.values.interventions_per_batch, null);
    assert.equal(sc.values.needs_human_genuine, null); // no LANE_AUDIT
    assert.equal(sc.values.revert_rate, null);
  });
  it("splits needs-human by LANE_AUDIT class and averages interventions per batch", () => {
    const laneAudits = [...Array(3).fill({ class: "genuine" }), ...Array(2).fill({ class: "pipeline" })];
    const batchRows = [{ interventions: 2 }, { interventions: 4 }];
    const sc = buildScorecard({ records: many("1.0.0", 5), laneAudits, batchRows, release: "1.0.0", minN: 2 });
    assert.equal(sc.values.needs_human_genuine, 3);
    assert.equal(sc.values.needs_human_pipeline, 2);
    assert.equal(sc.values.interventions_per_batch, 3);
  });
  it("is null below min-n", () => {
    assert.equal(buildScorecard({ records: many("1.0.0", 3), release: "1.0.0" }).values.first_pass_rate, null);
  });
  it("flags a regression against the previous release", () => {
    const records = [...many("1.0.0", 10), ...many("1.1.0", 10, (i) => (i < 5 ? { remediated: true } : {}))];
    const sc = buildScorecard({ records, release: "1.1.0" });
    assert.equal(sc.against, "1.0.0");
    assert.equal(sc.verdicts.first_pass_rate, "regressed");
    assert.ok(sc.regressions.includes("rework_rate"));
    assert.equal(sc.verdicts.minutes_per_merge, "flat");
  });
  it("never throws on bad input and renders with the marker", () => {
    const sc = buildScorecard({ records: [null, 5], release: "x" });
    assert.deepEqual(sc.regressions, []);
    const recs = [...many("1.0.0", 10), ...many("1.1.0", 10, () => ({ remediated: true }))];
    const out = scorecardComment(buildScorecard({ records: recs, release: "1.1.0" }));
    assert.ok(out.startsWith(SCORECARD_MARKER));
    assert.match(renderScorecard(buildScorecard({ records: recs, release: "1.1.0" })), /Regressions vs 1\.0\.0: .*first-pass merge rate/);
    assert.match(renderScorecard(sc), /n\/a/);
  });
  it("parses CLI args; --release is required", async () => {
    assert.deepEqual(parseScorecardArgs(["--repo", "o/r", "--release", "v1", "--json"]).release, "v1");
    assert.match(parseScorecardArgs(["--bogus"]).error, /unknown/);
    assert.match(parseScorecardArgs(["--release"]).error, /needs a value/);
    assert.equal(await runScorecard(["--repo", "o/r"]), 2);
  });
  it("uses only the injected fetcher (no network)", async () => {
    const fetch = async ({ repo }) => ({ records: [], items: [], repo });
    const sc = await gatherScorecard({ repo: "o/r", release: "v1" }, { fetch, gh: async () => { throw new Error("no network"); } });
    assert.equal(sc.values.n, 0);
  });
  it("reads batch logs from disk: interventions are applied requeues of that repo's batches", () => {
    const root = tmpDir("sc-");
    const mk = (id, repo, st) => { mkdirSync(join(root, id), { recursive: true }); writeFileSync(join(root, id, "plan.json"), JSON.stringify({ repo })); writeFileSync(join(root, id, "state.json"), JSON.stringify(st)); };
    mk("b-1", "o/r", { requeueApplied: ["a", "b"] });
    mk("b-2", "o/r", {});
    mk("b-3", "x/y", { requeueApplied: ["a"] });
    assert.deepEqual(batchRowsFromDisk("o/r", root), [{ batch: "b-1", interventions: 2 }, { batch: "b-2", interventions: 0 }]);
  });
});
