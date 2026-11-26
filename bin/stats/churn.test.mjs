// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { churnStats, formatChurnLines, readChurn } from "./churn.mjs";

const c = (marker, extra = "") => ({ body: `<!-- FORGE:${marker} -->\n${extra}` });
describe("comment churn (#5979)", () => {
  const issues = [
    { issue: 1, comments: [c("NEEDS_HUMAN", "sig=aaaaaaaaaaaa"), c("PARKED", "sig=aaaaaaaaaaaa"), c("DEPENDENCY"), { body: "a person wrote this" }] },
    { issue: 2, comments: [c("STATUS")] },
  ];
  it("counts FORGE comments per issue and repeated failures", () => {
    const s = churnStats(issues);
    assert.deepEqual(s.perIssue, [{ issue: 1, comments: 3, repeats: 1 }, { issue: 2, comments: 1, repeats: 0 }]);
    assert.equal(s.max, 3);
    assert.equal(s.median, 2);
    assert.equal(s.repeated, 1);
  });
  it("different signatures are not a repeat", () => {
    assert.equal(churnStats([{ issue: 3, comments: [c("NEEDS_HUMAN", "sig=aaaaaaaaaaaa"), c("NEEDS_HUMAN", "sig=bbbbbbbbbbbb")] }]).repeated, 0);
  });
  it("formats lines, and none for no issues", () => {
    assert.match(formatChurnLines(churnStats(issues))[0], /comments per issue: max 3, median 2 \(#1: 3, #2: 1\); repeated failures: 1/);
    assert.deepEqual(formatChurnLines(churnStats([])), []);
  });
  it("readChurn never throws", async () => {
    assert.deepEqual(await readChurn({ gh: async () => { throw new Error("x"); }, repo: "o/r", issues: [1] }), []);
    assert.deepEqual(await readChurn({ gh: null, repo: "o/r", issues: null }), []);
  });
});
