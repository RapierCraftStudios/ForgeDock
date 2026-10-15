// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateContract, applyAmendments, precheck, parseReview, checkCompleteness, decide, closePlan, followupItems, inIssue, isTestPath } from "./conformance.mjs";

const ISSUE = "## Requirements\n1. The scrape route must release the spend reservation on 429.\n2. The search route must release the spend reservation on 429.\n\n- [ ] Billing pricing is unchanged.";
const Q1 = "The scrape route must release the spend reservation on 429.";
const Q2 = "The search route must release the spend reservation on 429.";
const C = {
  requirements: [{ id: "R1", quote: Q1, disposition: "deliver" }, { id: "R2", quote: Q2, disposition: "deliver" }],
  deliverables: [{ id: "D1", path: "src/scrape.js" }, { id: "D2", path: "src/search.js" }],
  preserve: [{ id: "P1", what: "Billing pricing is unchanged. (src/billing.js)" }],
  validate: [{ id: "V1", command: "node --test test/leak.test.js" }],
};
const files = ["src/scrape.js", "src/search.js", "test/leak.test.js"];
const ctx = { contract: C, changedFiles: files, issueText: ISSUE, pathExists: (p) => p === "src/billing.js" };
const good = {
  issue_coverage: [{ quote: Q1, status: "covered" }, { quote: Q2, status: "covered" }, { quote: "Billing pricing is unchanged.", status: "covered" }],
  requirements: [{ id: "R1", status: "implemented", evidence: "src/scrape.js:7", validated_by: "V1" }, { id: "R2", status: "implemented", evidence: "src/search.js:7", validated_by: "V1" }],
  scope: [{ file: "src/scrape.js", authorized_by: "D1" }, { file: "src/search.js", authorized_by: "D2" }, { file: "test/leak.test.js", authorized_by: "test" }],
  preserve: [{ id: "P1", status: "intact", evidence: "src/billing.js:1" }], regressions: [], verdict: "CONFORMS", summary: "ok",
};
const row = (id, patch) => ({ ...good, requirements: good.requirements.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
const codes = (d) => d.failures.map((f) => f.code);

describe("contract", () => {
  it("a well-formed contract with verbatim quotes is valid", () => assert.deepEqual(validateContract(C, ISSUE), { ok: true, problems: [] }));
  it("quotes must be verbatim (whitespace and emphasis aside) and long enough", () => {
    assert.ok(inIssue("the  SCRAPE route must release the spend reservation on 429.", ISSUE));
    assert.ok(!inIssue("scrape should free money", ISSUE));
    assert.ok(!inIssue("429.", ISSUE), "too short to identify a requirement");
  });
  it("rejects paraphrases, a defer without why, not-applicable without evidence, missing validate, duplicate ids", () => {
    const v = validateContract({ ...C, validate: [], requirements: [
      { id: "R1", quote: "make scrape better", disposition: "deliver" }, { id: "R2", quote: Q2, disposition: "defer" },
      { id: "R2", quote: Q2, disposition: "not-applicable" }, { id: "R4", quote: Q1, disposition: "maybe" }] }, ISSUE);
    assert.equal(v.ok, false);
    for (const p of [/R1: quote is not verbatim/, /R2: defer needs a why/, /duplicated: R2/, /not-applicable needs file:line evidence/, /R4: disposition must be one of/, /no validate\[\] commands/]) assert.ok(v.problems.some((x) => p.test(x)), String(p));
    assert.equal(validateContract(null, ISSUE).ok, false);
  });
});

describe("amendments", () => {
  it("add-deliverable, add-requirement and defer apply with a why; defer is queued for tracking once", () => {
    const a = applyAmendments(C, [
      { kind: "add-deliverable", path: "src/shared.js", why: "both routes share the helper" },
      { kind: "add-requirement", requirement: { id: "R3", quote: "Billing pricing is unchanged.", disposition: "deliver" }, why: "missed" },
      { kind: "defer", requirement: "R2", why: "search is owned by another module" }]);
    assert.deepEqual(a.problems, []);
    assert.ok(a.contract.deliverables.some((d) => d.path === "src/shared.js"));
    assert.equal(a.contract.requirements.find((r) => r.id === "R2").disposition, "defer");
    assert.deepEqual(a.toTrack.map((r) => r.id), ["R2"]);
    assert.equal(a.applied.length, 3);
    assert.equal(C.requirements[1].disposition, "deliver", "the frozen contract is never mutated");
  });
  it("an amendment without a why, an unknown requirement or an unknown kind is a problem, not applied", () => {
    const a = applyAmendments(C, [{ kind: "add-deliverable", path: "x.js" }, { kind: "defer", requirement: "R9", why: "w" }, { kind: "rewrite", why: "w" }]);
    assert.equal(a.problems.length, 3); assert.equal(a.applied.length, 0);
  });
});

describe("precheck (deterministic, no reviewer)", () => {
  const res = { requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
  it("passes a complete, validated, in-scope change", () => assert.deepEqual(precheck({ contract: C, result: res, changedFiles: files }), { ok: true, failures: [] }));
  it("unauthorized file -> scope_creep; tests and ignored paths are always allowed", () => {
    assert.deepEqual(codes(precheck({ contract: C, result: res, changedFiles: [...files, "src/billing.js", ".forge-lean/x", "tests/test_x.py", "pkg/foo_test.go"], ignore: [".forge-lean/"] })), ["conformance.scope_creep"]);
    for (const t of ["test/a.js", "src/a.test.ts", "tests/test_a.py", "a_test.go", "spec/a.spec.js"]) assert.ok(isTestPath(t), t);
    assert.ok(!isTestPath("src/testing.js"));
  });
  it("failed or missing validation -> unimplemented", () => {
    assert.deepEqual(codes(precheck({ contract: C, result: { ...res, validation: [{ id: "V1", exit: 1 }] }, changedFiles: files })), ["conformance.unimplemented"]);
    assert.deepEqual(codes(precheck({ contract: C, result: { ...res, validation: [] }, changedFiles: files })), ["conformance.unimplemented"]);
  });
  it("a deliver requirement reported deferred without an amendment -> untracked_deferral; partial -> unimplemented", () => {
    const r = { ...res, requirements: [{ id: "R1", status: "deferred" }, { id: "R2", status: "partial" }] };
    assert.deepEqual(codes(precheck({ contract: C, result: r, changedFiles: files })), ["conformance.untracked_deferral", "conformance.unimplemented"]);
  });
  it("a contracted defer must carry a tracking issue", () => {
    const k = { ...C, requirements: [C.requirements[0], { ...C.requirements[1], disposition: "defer", why: "w" }] };
    assert.deepEqual(codes(precheck({ contract: k, result: res, changedFiles: files })), ["conformance.untracked_deferral"]);
    k.requirements[1].tracked = "#9";
    assert.equal(precheck({ contract: k, result: res, changedFiles: files }).ok, true);
  });
});

describe("conformance review: the engine computes the verdict from complete rows", () => {
  it("complete conforming rows conform", () => assert.equal(decide(good, ctx).state, "conforms"));
  it("a generic PASS (the old two-question reply) is incomplete, never conforming", () => {
    const d = decide({ verdict: "PASS", fixes_issue: true, regression: false, reason: "looks good" }, ctx);
    assert.equal(d.state, "review.incomplete");
    assert.ok(d.failures.every((f) => f.code === "review.incomplete"));
  });
  it("no JSON is unparseable", () => { assert.equal(parseReview("LGTM"), null); assert.equal(decide(null, ctx).state, "review.unparseable"); });
  it("incomplete: missing requirement row, missing scope row for a changed file, missing preserve row", () => {
    assert.equal(decide({ ...good, requirements: good.requirements.slice(1) }, ctx).state, "review.incomplete");
    assert.equal(decide({ ...good, scope: good.scope.slice(1) }, ctx).state, "review.incomplete");
    assert.equal(decide({ ...good, preserve: [] }, ctx).state, "review.incomplete");
  });
  it("incomplete: implemented without path:line, with evidence in a nonexistent file, or without validation", () => {
    assert.equal(decide(row("R1", { evidence: "looks fine" }), ctx).state, "review.incomplete");
    assert.equal(decide(row("R1", { evidence: "src/nope.js:3" }), ctx).state, "review.incomplete");
    assert.equal(decide(row("R1", { evidence: "src/billing.js:1" }), ctx).state, "conforms", "an existing unchanged file is valid evidence");
    assert.equal(decide(row("R1", { validated_by: "none" }), ctx).state, "review.incomplete");
  });
  it("incomplete: a coverage quote paraphrased instead of verbatim", () => {
    assert.equal(decide({ ...good, issue_coverage: [{ quote: "scrape should release money on rate limits", status: "covered" }] }, ctx).state, "review.incomplete");
  });
  it("omission: an issue requirement missing from or narrowed by the contract", () => {
    const d = decide({ ...good, issue_coverage: [...good.issue_coverage.slice(0, 2), { quote: "Billing pricing is unchanged.", status: "missing" }] }, ctx);
    assert.deepEqual(codes(d), ["conformance.omission"]);
  });
  it("contract mismatch: a deliver requirement partial or missing in the diff", () => {
    assert.deepEqual(codes(decide(row("R2", { status: "missing", evidence: "src/search.js:5" }), ctx)), ["conformance.unimplemented"]);
    assert.deepEqual(codes(decide(row("R2", { status: "deferred" }), ctx)), ["conformance.untracked_deferral"]);
  });
  it("scope creep, preserve violated or unverified, and regressions fail", () => {
    assert.deepEqual(codes(decide({ ...good, scope: [...good.scope.slice(0, 2), { file: "test/leak.test.js", authorized_by: "none", note: "rewrites fixtures" }] }, ctx)), ["conformance.scope_creep"]);
    assert.deepEqual(codes(decide({ ...good, preserve: [{ id: "P1", status: "violated", evidence: "src/billing.js:1" }] }, ctx)), ["conformance.preserve_violated"]);
    assert.deepEqual(codes(decide({ ...good, preserve: [{ id: "P1", status: "unverified" }] }, ctx)), ["conformance.preserve_violated"]);
    assert.deepEqual(codes(decide({ ...good, regressions: [{ at: "src/x.js:3", failure: "caller passes null" }] }, ctx)), ["conformance.regression"]);
  });
  it("CONFORMS with a failing row is nonconforming and flagged inconsistent; NONCONFORMING with no failing row fails closed", () => {
    const d = decide(row("R1", { status: "partial" }), ctx);
    assert.equal(d.state, "nonconforming"); assert.equal(d.inconsistent, true);
    assert.deepEqual(codes(decide({ ...good, verdict: "NONCONFORMING" }, ctx)), ["review.inconsistent"]);
  });
  it("checkCompleteness lists every problem", () => assert.ok(checkCompleteness({}, ctx).problems.length >= 5));
});

describe("close plan and follow-up items", () => {
  it("links every tracking issue once; nothing tracked when everything is delivered", () => {
    assert.deepEqual(closePlan(C), { reason: "completed", tracked: [] });
    const k = { requirements: [{ id: "R1", disposition: "deliver" }, { id: "R2", disposition: "defer", tracked: "#9" }, { id: "R3", disposition: "post-deploy", tracked: "#9" }] };
    assert.deepEqual(closePlan(k).tracked, ["#9"]);
  });
  it("follow-up keys are single-line, tab-free and stable", () => {
    const [i] = followupItems([{ id: "R2", quote: "a\tb\n`c`", disposition: "defer", why: "x\ny" }]);
    assert.equal(i.key, "R2: a b c"); assert.equal(i.why, "defer: x y"); assert.doesNotMatch(i.key + i.why, /[\t\n`]/);
  });
});
