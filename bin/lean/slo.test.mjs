// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SLO, SLO_CLOSE_GREEN_MS, SLO_UPDATE_MS, evaluateSlo, fileSloIssues, parseSloConfig } from "./slo.mjs";

const eff = (o = {}) => ({ batch: "b1", repo: "o/r", at: "t", concurrency: { ready: 0, lowSinceMin: 0, windowMin: 15 }, repeats: [], commentsPerIssue: { max: 0, issues: [] }, phases: {}, idle: { share: {} }, ...o });
const codes = (o) => evaluateSlo(eff(o), DEFAULT_SLO).map((b) => b.code);
const fakeGh = () => { const calls = []; return { calls, gh: async (a) => { calls.push(a); return a[1] === "list" ? "[]" : a[1] === "create" ? "https://github.com/x/y/issues/42\n" : ""; } }; };

describe("#5987 SLOs", () => {
  it("defaults and file_issues off", () => {
    const c = parseSloConfig({});
    assert.equal(c.fileIssues, false); assert.equal(c.repeatMax, 3); assert.equal(c.concurrencyMin, 0.6);
    assert.equal(parseSloConfig({ orchestrate: { slo: { file_issues: "true", repeat_max: "5", attempts_max: "bad" } } }).repeatMax, 5);
    assert.equal(parseSloConfig({ orchestrate: { file_issues: "true" } }).fileIssues, true);
    assert.equal(parseSloConfig({ orchestrate: { slo: { attempts_max: "bad" } } }).attemptsMax, 2);
  });

  it("each SLO breaches past its limit and not at it", () => {
    assert.deepEqual(codes({ concurrency: { ready: 3, lowSinceMin: 30, achieved: 1, ceiling: 4, windowMin: 15 } }), ["concurrency"]);
    assert.deepEqual(codes({ concurrency: { ready: 0, lowSinceMin: 90 } }), [], "nothing ready is not a breach");
    assert.deepEqual(codes({ repeats: [{ signature: "s", count: 3, issues: [1] }] }), ["repeat"]);
    assert.deepEqual(codes({ repeats: [{ signature: "s", count: 2, issues: [1] }] }), []);
    assert.deepEqual(codes({ attemptsPerMerged: 2.5 }), ["attempts"]);
    assert.deepEqual(codes({ attemptsPerMerged: 2 }), []);
    assert.deepEqual(codes({ commentsPerIssue: { max: 21, issues: [{ issue: 5, comments: 21 }] } }), ["comments"]);
    assert.deepEqual(codes({ interventionsPerDay: 7 }), ["interventions"]);
    assert.deepEqual(codes({ interventionsPerDay: 6 }), []);
    assert.deepEqual(codes({ phases: { fix: { ratio: 1.6 } } }), ["phase"]);
    assert.deepEqual(codes({ phases: { fix: { ratio: 1.5 } } }), []);
    assert.deepEqual(codes({ capacityRefusalsPerHour: 21 }), ["capacity"]);
    assert.deepEqual(codes({ idle: { share: { hold: 0.3, "no-ready": 0.9 } } }), ["idle-hold"]);
  });

  it("files nothing unless enabled", async () => {
    const f = fakeGh(), b = evaluateSlo(eff({ interventionsPerDay: 9 }), DEFAULT_SLO);
    const r = await fileSloIssues({ eff: eff(), breaches: b, gh: f.gh, cfg: DEFAULT_SLO, now: 1e9 });
    assert.equal(f.calls.length, 0); assert.deepEqual(r.slo.sigs, {});
  });

  it("one issue per signature, a re-breach inside 6 h is silent, after 6 h a counter comment, 24 h green closes", async () => {
    const f = fakeGh(), cfg = { ...DEFAULT_SLO, fileIssues: true }, b = evaluateSlo(eff({ interventionsPerDay: 9, attemptsPerMerged: 5 }), cfg);
    let now = 1e12, e = eff();
    const pass = async (br) => { const r = await fileSloIssues({ eff: e, breaches: br, gh: f.gh, cfg, now }); e = { ...e, slo: r.slo }; return r; };
    let r = await pass(b);
    assert.equal(f.calls.filter((c) => c[1] === "create").length, 2, "one create per signature");
    assert.equal(e.slo.sigs["slo:interventions:o/r"].issue, 42);
    now += SLO_UPDATE_MS - 1; r = await pass(b);
    assert.deepEqual(r.actions, [], "no update inside 6 h");
    now += 2; r = await pass(b);
    assert.deepEqual(r.actions.map((a) => [a.op, a.count]), [["comment", 2], ["comment", 2]]);
    now += 1000; r = await pass([]);
    assert.deepEqual(r.actions, []);
    now += SLO_CLOSE_GREEN_MS - 1; r = await pass([]);
    assert.deepEqual(r.actions, []);
    now += 2; r = await pass([]);
    assert.deepEqual(r.actions.map((a) => a.op), ["close", "close"]);
    assert.deepEqual(e.slo.sigs, {});
  });

  it("adopts an open issue found by signature instead of creating a second", async () => {
    const calls = [], cfg = { ...DEFAULT_SLO, fileIssues: true }, b = evaluateSlo(eff({ interventionsPerDay: 9 }), cfg);
    const gh = async (a) => { calls.push(a); return a[1] === "list" ? JSON.stringify([{ number: 7, body: `<!-- forge-slo: ${b[0].sig} -->` }]) : ""; };
    const r = await fileSloIssues({ eff: eff(), breaches: b, gh, cfg, now: 1 });
    assert.equal(r.slo.sigs[b[0].sig].issue, 7); assert.ok(!calls.some((c) => c[1] === "create"));
  });

  it("a gh failure never throws", async () => {
    const cfg = { ...DEFAULT_SLO, fileIssues: true };
    const r = await fileSloIssues({ eff: eff(), breaches: evaluateSlo(eff({ interventionsPerDay: 9 }), cfg), gh: async () => { throw new Error("down"); }, cfg, now: 1 });
    assert.deepEqual(r.slo.sigs, {});
  });
});
