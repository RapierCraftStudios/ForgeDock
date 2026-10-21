// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSelfReview, compareSelfReview } from "./selfreview.mjs";

const item = (question, answer = "yes", evidence = "src/a.py:3") => ({ question, answer, evidence });

describe("readSelfReview (#4374)", () => {
  it("only a fixed result is self-reviewed", () => {
    for (const r of [null, undefined, "x", { status: "blocked" }, { status: "invalid", self_review: [item("1")] }]) assert.equal(readSelfReview(r), null);
  });

  it("a fixed result without a non-empty self_review array is missing", () => {
    for (const self_review of [undefined, null, [], "yes", {}]) assert.deepEqual(readSelfReview({ status: "fixed", self_review }), { state: "missing", items: [], no: [] });
  });

  it("an entry without a question or an answer is invalid", () => {
    assert.equal(readSelfReview({ status: "fixed", self_review: [item("1"), { question: "2" }] }).state, "invalid");
    assert.equal(readSelfReview({ status: "fixed", self_review: [null] }).state, "invalid");
  });

  it("present: items normalized, the questions not answered yes listed", () => {
    const sr = readSelfReview({ status: "fixed", self_review: [item(" 1 ", "YES"), item("2", "no", 7), item(3, "partly", null)] });
    assert.equal(sr.state, "present");
    assert.deepEqual(sr.items, [item("1", "YES"), item("2", "no", "7"), { question: "3", answer: "partly", evidence: "" }]);
    assert.deepEqual(sr.no, ["2", "3"]);
  });
});

describe("compareSelfReview (#4374)", () => {
  const yes = readSelfReview({ status: "fixed", self_review: [item("1"), item("2")] });
  const no = readSelfReview({ status: "fixed", self_review: [item("1"), item("2", "no")] });

  it("all yes agrees with conforms and disagrees with nonconforming", () => {
    assert.deepEqual(compareSelfReview(yes, { state: "conforms" }), { agreed: true, reviewer: "conforms", self_no: [] });
    assert.deepEqual(compareSelfReview(yes, { state: "nonconforming" }), { agreed: false, reviewer: "nonconforming", self_no: [] });
  });

  it("a no agrees with nonconforming and disagrees with conforms", () => {
    assert.deepEqual(compareSelfReview(no, { state: "nonconforming" }), { agreed: true, reviewer: "nonconforming", self_no: ["2"] });
    assert.deepEqual(compareSelfReview(no, { state: "conforms" }), { agreed: false, reviewer: "conforms", self_no: ["2"] });
  });

  it("no comparison without a judgement on either side", () => {
    for (const s of ["review.incomplete", "review.unparseable", "review.inconsistent", "environment", undefined]) assert.equal(compareSelfReview(yes, { state: s }), null, String(s));
    assert.equal(compareSelfReview(null, { state: "conforms" }), null);
    assert.equal(compareSelfReview({ state: "missing", items: [], no: [] }, { state: "conforms" }), null);
    assert.equal(compareSelfReview(yes, null), null);
  });
});
