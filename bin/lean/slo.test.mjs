// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEfficiency } from "./efficiency.mjs";
import { DEFAULT_SLO, ledgerPass, SLO_CLOSE_GREEN_MS, SLO_UPDATE_MS, evaluateSlo, fileSloIssues, parseSloConfig } from "./slo.mjs";

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

  // R8: replay of the slow batches (11-20..11-24), rows in the shape orchestrate.mjs update() writes; no recorded batch is checked in files exactly one issue per breached signature; a healthy batch files none
  const replay = async (rows, running) => {
    const NOW = Date.parse("2026-11-24T12:00:00Z"), calls = [], cfg = { ...DEFAULT_SLO, fileIssues: true };
    const prev = { v: 1, samples: Array.from({ length: 40 }, (_, i) => ({ t: NOW - (40 - i) * 60000, running, ceiling: 12, ready: 5 })) };
    let stored = prev;
    const batch = { id: "b", dir: "d", readLog: () => rows, store: { peek: () => null } };
    const gh = async (a) => { calls.push(a); return a[1] === "list" ? "[]" : a[1] === "create" ? `https://github.com/x/y/issues/${100 + calls.length}\n` : ""; };
    const operator = Array.from({ length: 5 }, (_, i) => ({ at: NOW - (100 - i) * 60000, kind: i % 2 ? "requeue" : "hold" }));
    const run = () => ledgerPass({ batch, sample: null, operator, cfg, gh, now: NOW, repo: "o/r", compute: computeEfficiency, readEff: () => stored, writeEff: (_d, e) => { stored = e; } });
    const first = await run(), second = await run();
    return { first, second, creates: calls.filter((c) => c[1] === "create") };
  };
  it("fixture replay: slow batch files one issue per signature, healthy files none", async () => {
    const at = (m, r) => ({ at: new Date(Date.parse("2026-11-24T12:00:00Z") - m * 60000).toISOString(), ...r });
    const slow = [
      ...[1, 2, 3, 4].map((i) => at(300 - i, { issue: 7, outcome: "engine-error", reason: "sandbox.capacity", minutes: 30 })),
      at(200, { issue: 7, outcome: "merged", minutes: 20 }), at(190, { issue: 8, outcome: "ci-failed", minutes: 10 }), at(180, { issue: 8, outcome: "merged", minutes: 10 }),
      at(110, { issue: null, outcome: "added", detail: "9" }), at(105, { issue: 9, outcome: "deferred", code: "run.interrupted", detail: "interrupted: upgrade; requeued" }),
    ];
    const r = await replay(slow, 3);
    const sigs = r.first.breaches.map((b) => b.sig);
    for (const c of ["concurrency", "repeat", "attempts", "interventions"]) assert.ok(sigs.includes(`slo:${c}:o/r`), c);
    assert.equal(r.creates.length, new Set(sigs).size, "one create per signature, the second pass adds none");
    assert.equal(r.second.actions.length, 0);
    const ok = await replay([at(60, { issue: 1, outcome: "merged", minutes: 20 })], 11);
    assert.equal(ok.creates.length, 0);
  });
});
