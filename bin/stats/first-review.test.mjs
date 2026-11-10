// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { firstReviewReport, firstReviewLanes, renderFirstReview } from "./first-review.mjs";

const rec = (issue, o = {}) => ({ event: "run_terminal", issue, ts: `2026-01-${String(issue % 28 + 1).padStart(2, "0")}`, repo: "o/r", reason: "merged", first_review: { state: "conforms", kinds: [], rounds: 1, clean: true, incomplete: false, type: "bug", surfaces: [], ...o } });

describe("stats --first-review (#5345)", () => {
  it("reports rate, incomplete share, splits and first-round kinds with their contract section", () => {
    const records = [rec(1), rec(2), rec(3, { clean: false, state: "fails", kinds: ["conformance.omission"], rounds: 2 }), rec(4, { clean: false, incomplete: true, state: "review.incomplete", type: "feature" })];
    const r = firstReviewReport({ records, repo: "o/r", minN: 2 });
    assert.equal(r.lanes, 4);
    assert.equal(r.overall.clean_rate, 0.5);
    assert.equal(r.overall.incomplete_rate, 0.25);
    assert.equal(r.met, false);
    assert.equal(r.by_type.bug.n, 3);
    assert.equal(r.by_repo["o/r"].n, 4);
    assert.equal(r.first_round_kinds["conformance.omission"], 1);
    assert.equal(r.finding_sections.requirements, 1);
    assert.match(renderFirstReview(r), /contract section: requirements/);
  });
  it("keeps the latest record per issue and ignores lanes without first_review", () => {
    assert.equal(firstReviewLanes([rec(1), { event: "run_terminal", issue: 2 }, { ...rec(1, { clean: false }), ts: "2027-01-01" }]).length, 1);
    assert.match(renderFirstReview(firstReviewReport({ records: [] })), /no lanes/);
  });
  it("a long clean streak is a light-lane candidate, but a risk surface never is", () => {
    const safe = Array.from({ length: 5 }, (_, i) => rec(i + 1));
    assert.equal(firstReviewReport({ records: safe, minN: 3, streak: 3 }).by_type.bug.light_candidate, true);
    const risky = Array.from({ length: 5 }, (_, i) => rec(i + 1, { surfaces: ["risk:auth"] }));
    const r = firstReviewReport({ records: risky, minN: 3, streak: 3 });
    assert.equal(r.by_type.bug.light_candidate, false);
    assert.equal(r.by_surface["risk:auth"].light_candidate, false);
    assert.equal(r.overall.light_candidate, false);
  });
});
