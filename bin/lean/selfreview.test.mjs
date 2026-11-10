// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSelfReview, compareSelfReview, selfReviewFindings, selfCheckFailures, firstReviewRecord, sectionOfKind, FINDING_PITFALLS } from "./selfreview.mjs";
import { selfCheck, selfCheckState, formatCheckTable } from "./precheck.mjs";

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

describe("selfReviewFindings (#5345)", () => {
  const contract = { requirements: [{ id: "R1", quote: "q", disposition: "deliver" }], deliverables: [{ id: "D1", path: "src/a.js" }], preserve: [{ id: "P1", what: "src/keep.js behaviour unchanged" }], validate: [] };
  it("catches scope creep and a preserved path touched without authorization", () => {
    const f = selfReviewFindings({ contract, changedFiles: ["src/a.js", "src/keep.js", "src/b.js"] });
    assert.ok(f.some((x) => x.code === "conformance.scope_creep" && x.section === "deliverables"));
    assert.ok(f.some((x) => x.code === "conformance.preserve_violated" && /P1: src\/keep\.js/.test(x.detail)));
  });
  it("catches an unimplemented requirement only once the builder reported statuses", () => {
    assert.deepEqual(selfReviewFindings({ contract, changedFiles: ["src/a.js"] }), []);
    const f = selfReviewFindings({ contract, result: { requirements: [{ id: "R1", status: "missing" }] }, changedFiles: ["src/a.js"] });
    assert.ok(f.some((x) => x.code === "conformance.unimplemented" && x.section === "requirements"));
  });
  it("a red review section makes the check fail and the record red, so the lane is fixed before review", async () => {
    const review = selfReviewFindings({ contract, changedFiles: ["src/b.js"] });
    const r = await selfCheck({ review, contract, plan: { commands: [], budgetMs: 0, perCommandMs: 1 }, run: async () => ({ rc: 0 }) });
    assert.equal(r.ok, false);
    assert.match(formatCheckTable(r), /FAIL review {2}conformance\.scope_creep/);
    const rec = { fingerprint: "x", ok: r.ok, review: r.review.map((f) => ({ code: f.code, detail: f.detail })) };
    assert.equal(selfCheckState(rec, "x"), "red");
    assert.deepEqual(selfCheckFailures(rec).map((f) => f.code), review.map((f) => f.code));
    assert.equal((await selfCheck({ contract, plan: { commands: [], budgetMs: 0, perCommandMs: 1 }, run: async () => ({ rc: 0 }) })).ok, true);
  });
  it("pitfalls cover the recurring kinds and map to sections", () => {
    assert.deepEqual(Object.keys(FINDING_PITFALLS).sort(), ["conformance.omission", "conformance.preserve_violated", "conformance.scope_creep"]);
    assert.equal(sectionOfKind("conformance.preserve_violated"), "preserve");
  });
});

describe("firstReviewRecord (#5345)", () => {
  it("null without a round; otherwise the first judgement, rounds, type and surfaces", () => {
    assert.equal(firstReviewRecord({}), null);
    const r = firstReviewRecord({ rounds: [{ state: "fails", failures: ["conformance.scope_creep"] }, { state: "conforms", failures: [] }], labels: [{ name: "bug" }], files: ["src/a.js"] });
    assert.deepEqual([r.state, r.kinds, r.rounds, r.clean, r.type], ["fails", ["conformance.scope_creep"], 2, false, "bug"]);
    assert.equal(firstReviewRecord({ rounds: [{ state: "review.incomplete", failures: [] }] }).incomplete, true);
  });
});

describe("planner tightening (#5345 R5)", () => {
  it("every contract section first-round findings map to has a planner rule, rendered in the plan prompt", async () => {
    const { PLANNER_TIGHTENING, KIND_SECTION } = await import("./selfreview.mjs");
    const { builderPlanPrompt } = await import("./prompts.mjs");
    for (const s of new Set(Object.values(KIND_SECTION).filter((x) => ["requirements", "deliverables", "preserve"].includes(x)))) assert.ok(PLANNER_TIGHTENING[s], s);
    const p = builderPlanPrompt(1);
    for (const x of Object.values(PLANNER_TIGHTENING)) assert.ok(p.includes(x));
  });
});
