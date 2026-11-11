// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testAdequacyRows, testAdequacyFailures, testAdequacyTelemetry, verdictText, adequacyClass, adequacyCounts, formatTestAdequacySummary, regressionRan, TEST_MISSING, TEST_WEAK } from "./testadequacy.mjs";
import { renderReview, renderShadowReview } from "./render.mjs";
import { blockingFailures } from "./conformance.mjs";
import { conformanceOutcomes } from "../stats/conformance-outcomes.mjs";

const contract = (extra = {}) => ({
  requirements: [{ id: "R1", quote: "q1", disposition: "deliver" }, { id: "R2", quote: "q2", disposition: "deliver" }, { id: "R3", quote: "q3", disposition: "post-deploy", check: "chk-a" }],
  deliverables: [{ id: "D1", path: "src/a.mjs", requirements: ["R1", "R2"] }, { id: "D2", path: "src/a.test.mjs", requirements: ["R1"] }],
  validate: [{ id: "V1", command: "node --test src/a.test.mjs" }], ...extra,
});
const green = { runs: [{ id: "V1", exit: 0 }] };

describe("testAdequacyRows verdict rules", () => {
  it("missing when no executed test covers the requirement, adequate when one ran green", () => {
    const rows = testAdequacyRows(contract(), green);
    assert.deepEqual(rows.map((r) => [r.id, r.verdict]), [["R1", "adequate"], ["R2", "missing"]]);
    assert.equal(rows[0].planned, "n/a"); assert.equal(rows[0].mutation, "n/a"); assert.equal(rows[0].regression, "n/a");
  });
  it("a test that was declared but never ran is missing", () => assert.equal(testAdequacyRows(contract(), { runs: [{ id: "V1", exit: 1 }] })[0].verdict, "missing"));
  it("weak when the mutation survived, with the reason", () => {
    const r = testAdequacyRows(contract(), { ...green, mutation: [{ id: "R1", status: "survived" }] })[0];
    assert.equal(r.verdict, "weak"); assert.match(verdictText(r), /^weak \(.*reverted/);
  });
  it("killed mutation keeps adequate; repro BASE=RAN HEAD=RAN is weak", () => {
    assert.equal(testAdequacyRows(contract(), { ...green, mutation: [{ id: "R1", status: "killed" }] })[0].mutation, "killed");
    assert.equal(testAdequacyRows(contract(), { ...green, repro: { base: "RAN", head: "RAN" } })[0].verdict, "weak");
    assert.equal(testAdequacyRows(contract(), { ...green, repro: { base: "FAILED", head: "RAN" } })[0].redgreen, "BASE=FAILED HEAD=RAN");
  });
  it("weak from the reviewer's test_adequacy row and from a regression set that did not run", () => {
    const review = { requirements: [{ id: "R1", test_adequacy: { verdict: "weak", reason: "asserts the URL rewrite only" } }] };
    assert.match(verdictText(testAdequacyRows(contract(), { ...green, review })[0]), /asserts the URL rewrite only/);
    const c = contract({ regression_set: ["V9"] });
    assert.equal(regressionRan(c, green), false);
    assert.equal(testAdequacyRows(c, green)[0].regression, "not run");
  });
  it("a repro test proved red on base and green on head is the executed proof (no evidence validate needed)", () => {
    const c = contract({ repro_test: { path: "src/r.test.mjs", command: "node --test src/r.test.mjs" } });
    const rows = testAdequacyRows(c, { repro: { base: "FAILED", head: "RAN" } });
    assert.deepEqual(rows.map((r) => r.verdict), ["adequate", "adequate"]); assert.equal(rows[1].test, "src/r.test.mjs");
    assert.equal(testAdequacyRows(c, { repro: { base: "RAN", head: "RAN" } })[0].verdict, "missing");
  });
  it("out-of-band requirements get no row", () => {
    const c = contract(); c.requirements[1].verify = "out_of_band";
    assert.deepEqual(testAdequacyRows(c, green).map((r) => r.id), ["R1"]);
  });
});

describe("testAdequacyFailures", () => {
  const rows = testAdequacyRows(contract(), { ...green, mutation: [{ id: "R1", status: "survived" }] });
  it("never fails a non-bug lane", () => assert.deepEqual(testAdequacyFailures(rows, { bug: false }), []));
  it("bug lane: missing always, weak only in the first round", () => {
    assert.deepEqual(testAdequacyFailures(rows, { bug: true, firstRound: true }).map((f) => f.code), [TEST_WEAK, TEST_MISSING]);
    assert.deepEqual(testAdequacyFailures(rows, { bug: true, firstRound: false }).map((f) => f.code), [TEST_MISSING]);
  });
  it("both kinds block in a shadow lane without conformance_kinds", () => {
    const f = testAdequacyFailures(rows, { bug: true });
    assert.equal(blockingFailures(f, { shadow: true }).block.length, 2);
  });
});

describe("telemetry, summary and rendering", () => {
  it("telemetry carries known facts only", () => {
    const rows = testAdequacyRows(contract(), green);
    assert.deepEqual(testAdequacyTelemetry(contract(), rows), { tests_declared: 1, tests_ran: 1, post_deploy_check_ids: "chk-a" });
    const t = testAdequacyTelemetry(contract({ repro_test: { command: "x" } }), rows, { repro: { base: "FAILED", head: "RAN" }, mutation: [{ status: "killed" }, { status: "survived" }], regression: true });
    assert.equal(t.repro_quality, "red_green"); assert.equal(t.mutation_killed, 1); assert.equal(t.regression_suite_ran, true);
  });
  it("class, counts and the batch line", () => {
    const rows = testAdequacyRows(contract(), green);
    assert.equal(adequacyClass(rows), "missing"); assert.deepEqual(adequacyCounts(rows), { adequate: 1, weak: 0, missing: 1 });
    assert.equal(formatTestAdequacySummary([{}]), null);
    assert.equal(formatTestAdequacySummary([{ conformance: { test_adequacy: { adequate: 1, weak: 0, missing: 1 } } }, { conformance: { test_adequacy: { adequate: 2, weak: 0, missing: 0 } } }]), "test adequacy: 2 lanes, 4 requirement(s): adequate 75%, weak 0%, missing 25%");
  });
  it("FORGE:REVIEW (enforced and shadow) renders the Test adequacy table", () => {
    const c = contract(), rows = testAdequacyRows(c, green), rv = { requirements: [], summary: "s" };
    assert.match(renderReview(rv, c, rows), /\*\*Test adequacy\*\*[\s\S]*\| R2 \|.*\| missing \|/);
    assert.match(renderShadowReview({ would: "conforms", review: rv, contract: c, adequacy: rows }), /\*\*Test adequacy\*\*/);
    assert.doesNotMatch(renderReview(rv, c), /Test adequacy/);
  });
  it("outcomes split reopen within 14 days by adequacy class", () => {
    const now = Date.parse("2026-12-01T00:00:00Z"), mk = (n, re) => ({ number: n, repo: "o/r", title: "t", body: "", mergedAt: "2026-11-01T00:00:00Z", closingIssues: [{ number: 100 + n, reopenedAt: re ? ["2026-11-10T00:00:00Z"] : [] }] });
    const prs = [mk(1, true), mk(2, false)];
    const verdicts = new Map([["pr:1", { state: "conforms", kinds: [], test_adequacy: "missing" }], ["pr:2", { state: "conforms", kinds: [], test_adequacy: "adequate" }]]);
    const r = conformanceOutcomes({ prs, verdicts, minN: 1, now });
    assert.equal(r.repos["o/r"].by_adequacy.missing.defects, 1);
    assert.equal(r.repos["o/r"].by_adequacy.adequate.defects, 0);
  });
});
