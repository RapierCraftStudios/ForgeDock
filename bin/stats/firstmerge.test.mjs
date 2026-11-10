// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { firstMergeReport, medianMinutes, gatherFirstRunIssues, renderFirstMerge } from "./firstmerge.mjs";
import { parseArgs, buildReport } from "./index.mjs";
import { markerLine } from "../first-run.mjs";

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const iss = (n, startedMs, merges) => ({ number: n, body: `x\n${markerLine(startedMs)}`, closedByPullRequestsReferences: merges.map((m) => ({ mergedAt: new Date(m).toISOString() })) });

describe("stats --first-merge (#5290)", () => {
  it("measures earliest start to earliest merge", () => {
    const r = firstMergeReport({ repo: "o/r", issues: [iss(1, T0, [T0 + 12 * 60000]), iss(2, T0 + 60000, [T0 + 9 * 60000]), { number: 3, body: "plain" }] });
    assert.equal(r.minutes, 9);
    assert.equal(r.met, true);
    assert.equal(r.issues, 2);
  });
  it("is not met over 15 minutes and null when unmerged or absent", () => {
    assert.equal(firstMergeReport({ issues: [iss(1, T0, [T0 + 20 * 60000])] }).met, false);
    assert.equal(firstMergeReport({ issues: [iss(1, T0, [])] }).minutes, null);
    assert.equal(firstMergeReport({ issues: [] }).started, null);
  });
  it("takes the median across repos", () => {
    assert.equal(medianMinutes([{ minutes: 5 }, { minutes: 20 }, { minutes: 9 }, { minutes: null }]), 9);
  });
  it("buildReport reads GitHub only and rejects unreadable output", async () => {
    assert.equal(parseArgs(["--first-merge"]).firstMerge, true);
    const rep = await buildReport({ firstMerge: true, repo: "o/r" }, { gh: async () => JSON.stringify([iss(1, T0, [T0 + 600000])]) });
    assert.equal(rep.query.first_merge.minutes, 10);
    assert.match(renderFirstMerge(rep.query.first_merge), /10\.0 min.*met/);
    await assert.rejects(gatherFirstRunIssues({ gh: async () => "oops", repo: "o/r" }), /unreadable/);
  });
  it("--repo a,b reports the median across repos", async () => {
    const by = { "o/a": [iss(1, T0, [T0 + 5 * 60000])], "o/b": [iss(1, T0, [T0 + 25 * 60000])], "o/c": [iss(1, T0, [T0 + 9 * 60000])] };
    const gh = async (a) => JSON.stringify(by[a[a.indexOf("-R") + 1]]);
    const rep = await buildReport({ firstMerge: true, repo: "o/a,o/b,o/c" }, { gh });
    assert.equal(rep.query.first_merge.median_minutes, 9);
    assert.match(renderFirstMerge(rep.query.first_merge), /median time to first merged PR over 3 repos: 9\.0 min/);
  });
});
