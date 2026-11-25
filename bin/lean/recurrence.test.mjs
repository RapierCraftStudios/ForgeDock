// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRecurrenceConfig, detectRecurrence, recursLinks, pathsOverlap, recurrenceFacts, designLaneNote, designContractFailures } from "./recurrence.mjs";

const row = (number, o = {}) => ({ number, kind: "PR", status: "merged", title: `fix leak ${number}`, matched: ["reservation", "leak"], ...o });
const NAMED = ["src/billing/reserve.js"];

describe("recurrence config (#5751)", () => {
  it("defaults to mode on, threshold 2, no hot areas or counters", () => {
    assert.deepEqual(parseRecurrenceConfig(undefined), { mode: "on", threshold: 2, hotAreas: [], counters: [] });
  });
  it("reads mode off, a threshold, list and block-map hot areas and counters", () => {
    const c = parseRecurrenceConfig({ mode: "off", threshold: "3", hot_areas: { billing: "src/billing/**, ./src/pay.js" }, counters: [{ name: "flags", pattern: "FLAG_[A-Z]+", paths: "src/**" }] });
    assert.equal(c.mode, "off");
    assert.equal(c.threshold, 3);
    assert.deepEqual(c.hotAreas, [{ name: "billing", paths: ["src/billing/**", "src/pay.js"] }]);
    assert.deepEqual(c.counters, [{ name: "flags", pattern: "FLAG_[A-Z]+", paths: ["src/**"] }]);
    assert.deepEqual(parseRecurrenceConfig({ counters: { exports: "^export (a|b) -- bin/*.mjs" } }).counters, [{ name: "exports", pattern: "^export (a|b)", paths: ["bin/*.mjs"] }]);
    assert.equal(parseRecurrenceConfig({ mode: false, threshold: 0 }).mode, "off");
    assert.equal(parseRecurrenceConfig({ threshold: 0 }).threshold, 2, "an invalid threshold keeps the default");
  });
});

describe("recurrence detection (#5751)", () => {
  it("two merged fixes on the same symptom touching a named path route to a design lane and record the reason", () => {
    const d = detectRecurrence({ rows: [row(10), row(11)], mergedPrFiles: { 10: ["src/billing/reserve.js"], 11: ["src/billing/reserve.js", "README.md"] }, namedPaths: NAMED });
    assert.equal(d.recurs, true);
    assert.equal(d.count, 2);
    assert.deepEqual(d.evidence.map((e) => e.number), [10, 11]);
    assert.match(d.reason, /^recurrence: 2 earlier merged fix\(es\) on the same symptom and area \(threshold 2\): #10 \(src\/billing\/reserve\.js\), #11/);
  });
  it("one matching fix does not route", () => {
    const d = detectRecurrence({ rows: [row(10)], mergedPrFiles: { 10: NAMED }, namedPaths: NAMED });
    assert.equal(d.recurs, false);
    assert.equal(d.count, 1);
    assert.equal(d.reason, "");
  });
  it("symptom matches without path overlap, unmerged rows and issues do not count", () => {
    const d = detectRecurrence({ rows: [row(10), row(11), row(12, { status: "closed unmerged" }), row(13, { kind: "issue", status: "completed" })],
      mergedPrFiles: { 10: ["src/other.js"], 11: ["docs/x.md"], 12: NAMED, 13: NAMED }, namedPaths: NAMED });
    assert.equal(d.recurs, false);
    assert.equal(d.count, 0);
    assert.equal(detectRecurrence({ rows: [row(10), row(11)], mergedPrFiles: { 10: NAMED, 11: NAMED }, namedPaths: [] }).recurs, false, "an issue naming no path has no area");
  });
  it("a directory named by the issue overlaps the files under it", () => {
    assert.equal(pathsOverlap("src/billing/reserve.js", "src/billing"), true);
    assert.equal(pathsOverlap("src/billingx.js", "src/billing"), false);
    assert.equal(detectRecurrence({ rows: [row(10), row(11)], mergedPrFiles: { 10: ["src/billing/a.js"], 11: ["src/billing/b.js"] }, namedPaths: ["src/billing/"] }).recurs, true);
  });
  it("Recurs #n links count: unknown files are the author's declaration, files elsewhere are not", () => {
    assert.deepEqual(recursLinks("Recurs #10, #11\nalso recurs of #12 and Recurs: #13"), [10, 11, 12, 13]);
    const d = detectRecurrence({ rows: [row(10)], mergedPrFiles: { 10: NAMED }, body: "Recurs #10, #20", namedPaths: NAMED });
    assert.equal(d.count, 2, "#10 counts once; #20 (files unknown) counts");
    assert.deepEqual(d.evidence.map((e) => [e.number, e.via]), [[10, "subject (reservation, leak)"], [20, "Recurs link"]]);
    assert.equal(detectRecurrence({ rows: [row(10)], mergedPrFiles: { 10: NAMED, 21: ["elsewhere.js"] }, body: "Recurs #21", namedPaths: NAMED }).recurs, false);
  });
  it("the threshold is configurable", () => {
    assert.equal(detectRecurrence({ rows: [row(10), row(11)], mergedPrFiles: { 10: NAMED, 11: NAMED }, namedPaths: NAMED, threshold: 3 }).recurs, false);
    assert.equal(detectRecurrence({ rows: [row(10)], mergedPrFiles: { 10: NAMED }, namedPaths: NAMED, threshold: 1 }).recurs, true);
  });
  it("recurrenceFacts reads subject history and each merged PR's files, with no LLM call", async () => {
    const calls = [];
    const gh = async (a) => {
      calls.push(a.join(" "));
      if (a.includes("search/issues")) return [10, 11].map((n) => JSON.stringify({ number: n, title: `fix ${n}`, pr: true, merged: true })).join("\n");
      const m = /pulls\/(\d+)\/files/.exec(a.join(" "));
      if (m) return m[1] === "10" ? "src/billing/reserve.js\n" : "src/billing/reserve.js\nx.md\n";
      throw new Error("unexpected");
    };
    const d = await recurrenceFacts({ io: { gh }, repo: "o/r", issue: 7, title: "reservation leak on 429", body: "See src/billing/reserve.js", namedPaths: NAMED, threshold: 2 });
    assert.equal(d.recurs, true);
    assert.deepEqual(d.evidence.map((e) => e.number), [11, 10]);
    assert.ok(calls.some((c) => c.includes("pulls/10/files")) && calls.some((c) => c.includes("pulls/11/files")));
  });
});

describe("design lane (#5751)", () => {
  const det = detectRecurrence({ rows: [row(10), row(11)], mergedPrFiles: { 10: NAMED, 11: NAMED }, namedPaths: NAMED });
  it("the plan note names the earlier fixes and asks why they failed, delete or replace, a measurable outcome and allows a split", () => {
    const n = designLaneNote(det);
    assert.match(n, /DESIGN LANE/);
    assert.match(n, /#10 fix leak 10/);
    assert.match(n, /why_failed/);
    assert.match(n, /delete\|replace\|extend/);
    assert.match(n, /"metric"/);
    assert.match(n, /split-required/);
    assert.equal(designLaneNote({ recurs: false }), "");
    assert.equal(designLaneNote(null), "");
  });
  it("a design lane's contract must carry why_failed, a disposition and a measurable outcome", () => {
    assert.equal(designContractFailures({}, det)[0].kind, "design_missing");
    assert.match(designContractFailures({}, det)[0].detail, /no design block/);
    assert.match(designContractFailures({ design: { why_failed: "", disposition: "replace", outcome: { metric: "m", target: 0 } } }, det)[0].detail, /why_failed is empty/);
    assert.deepEqual(designContractFailures({ design: { why_failed: "w", disposition: "delete", outcome: { metric: "m", target: 0 } } }, det), []);
    assert.deepEqual(designContractFailures({}, { recurs: false }), [], "an ordinary lane needs no design block");
  });
});

import { designDemanded } from "./recurrence.mjs";
describe("symptom match and one-time design demand (#5979)", () => {
  const files = { 10: NAMED, 11: NAMED };
  it("path-only overlap without a symptom match does not recur", () => {
    const rows = [row(10, { matched: ["billing"], title: "tidy billing" }), row(11, { matched: ["reserve"], title: "rename" })];
    const d = detectRecurrence({ rows, mergedPrFiles: files, namedPaths: NAMED, body: "the page is slow" });
    assert.equal(d.recurs, false);
    assert.equal(d.count, 0);
  });
  it("a code-shaped symptom plus path still recurs", () => {
    const rows = [row(10, { matched: ["reservation.leak"] }), row(11, { matched: ["reservation.leak"] })];
    assert.equal(detectRecurrence({ rows, mergedPrFiles: files, namedPaths: NAMED }).recurs, true);
  });
  it("a backticked signature of the issue in the row title is a symptom match", () => {
    const rows = [row(10, { matched: ["billing"], title: "fix `ERR_RESERVE` crash" }), row(11, { matched: ["billing"], title: "again ERR_RESERVE" })];
    assert.equal(detectRecurrence({ rows, mergedPrFiles: files, namedPaths: NAMED, body: "throws `ERR_RESERVE`" }).recurs, true);
  });
  it("a Recurs link is unchanged", () => {
    assert.equal(detectRecurrence({ rows: [], mergedPrFiles: { 5: NAMED, 6: NAMED }, body: "Recurs #5, #6", namedPaths: NAMED }).recurs, true);
  });
  it("a design block already demanded on an earlier run is not demanded again", () => {
    const det = { recurs: true, count: 2, demanded: true };
    const f = designContractFailures({}, det);
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "design_missing_repeated");
    assert.equal(designContractFailures({}, { ...det, demanded: false })[0].kind, "design_missing");
    assert.deepEqual(designContractFailures({ design: { why_failed: "w", disposition: "replace", outcome: { metric: "m", target: "t" } } }, det), []);
  });
  it("designDemanded reads an earlier NEEDS_HUMAN naming the design lane", () => {
    assert.equal(designDemanded([{ body: "<!-- FORGE:NEEDS_HUMAN -->\nrecurring issue (2 earlier fixes) routed to a design lane: no design block" }]), true);
    assert.equal(designDemanded([{ body: "<!-- FORGE:NEEDS_HUMAN -->\nother" }]), false);
  });
});
