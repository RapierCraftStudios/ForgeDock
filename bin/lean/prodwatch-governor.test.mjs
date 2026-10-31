// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { admit } from "./prodwatch-governor.mjs";
import { cluster, classifyCluster, DEFAULT_RULES } from "./prodwatch-triage.mjs";
import { normalizeMemo } from "./prodwatch-sources.mjs";

const NOW = "2026-10-31T12:00:00Z";
const cl = (fp, cls, extra = {}) => ({ fingerprint: fp, class: cls, severity: "P2", count: 1, fileable: true, duplicateOf: null, signals: [{ title: `t ${fp}` }], first_seen: null, last_seen: null, ...extra });
const fps = (r) => r.file.map((c) => c.fingerprint);

describe("admit", () => {
  it("admits everything and no summary under the limits", () => {
    const r = admit([cl("a", "defect"), cl("b", "incident")], { governor: { max_issues_per_hour: 5 }, now: NOW });
    assert.deepEqual(fps(r), ["b", "a"]);
    assert.equal(r.summary, null);
  });
  it("incidents are admitted before defects", () => {
    const r = admit([cl("d1", "defect", { count: 9 }), cl("i1", "incident", { severity: "P3" }), cl("d2", "defect")], { governor: { max_issues_per_hour: 1 }, now: NOW });
    assert.deepEqual(fps(r), ["i1"]);
  });
  it("max_issues_per_hour counts only filings in the last hour", () => {
    const state = { filed: ["2026-10-31T11:30:00Z", "2026-10-31T10:00:00Z"] };
    const r = admit([cl("a", "defect"), cl("b", "defect")], { governor: { max_issues_per_hour: 2 }, state, now: NOW });
    assert.equal(r.file.length, 1);
    assert.ok(r.summary);
  });
  it("max_open_prod_issues is a standing cap", () => {
    const r = admit([cl("a", "defect"), cl("b", "defect"), cl("c", "defect")], { governor: { max_open_prod_issues: 3 }, openProdIssues: [{ number: 1 }, { number: 2 }], now: NOW });
    assert.equal(r.file.length, 1);
    assert.match(r.summary.body, /max_open_prod_issues/);
  });
  it("max_cost_usd_per_round caps by per-cluster cost", () => {
    const r = admit([cl("a", "defect"), cl("b", "defect"), cl("c", "defect")], { governor: { max_cost_usd_per_round: 1, cost_per_issue_usd: 0.4 }, now: NOW });
    assert.equal(r.file.length, 2);
    assert.match(r.summary.body, /max_cost_usd_per_round/);
  });
  it("files ONE summary listing every deferred cluster", () => {
    const r = admit(Array.from({ length: 6 }, (_, i) => cl(`f${i}`, "defect")), { governor: { max_issues_per_hour: 2 }, now: NOW });
    assert.equal(r.file.length, 2);
    assert.equal(r.summary.body.split("\n").filter((l) => l.startsWith("- ")).length, 4);
    assert.doesNotMatch(r.summary.body, /SIGNAL_REF/);
  });
  it("skips non-fileable, duplicate and expected-class clusters, never mutates input, is deterministic", () => {
    const input = [cl("a", "defect", { fileable: false }), cl("b", "defect", { duplicateOf: 7 }), cl("c", "expected-class"), cl("d", "defect"), cl("e", "defect")];
    const snap = JSON.stringify(input);
    const r1 = admit(input, { governor: { max_issues_per_hour: 1 }, now: NOW });
    assert.deepEqual(fps(r1), ["d"]);
    assert.equal(r1.summary.body.split("\n").filter((l) => l.startsWith("- ")).length, 1);
    assert.equal(JSON.stringify(input), snap);
    assert.deepEqual(admit(input, { governor: { max_issues_per_hour: 1 }, now: NOW }), r1);
  });
  it("a missing governor is unlimited; a zero limit defers everything into one summary", () => {
    assert.equal(admit([cl("a", "defect")], { now: NOW }).file.length, 1);
    const r = admit([cl("a", "defect"), cl("b", "defect")], { governor: { max_issues_per_hour: 0 }, now: NOW });
    assert.equal(r.file.length, 0);
    assert.ok(r.summary);
  });
  it("a 70-memo storm is bounded to the cap plus one summary", () => {
    const memos = JSON.parse(readFileSync(new URL("./fixtures/prodwatch/memos.json", import.meta.url), "utf8")).map((m) => normalizeMemo(m.id, m.text, { name: "memos" }));
    const cs = cluster(memos).map((c) => ({ ...c, class: classifyCluster(c, DEFAULT_RULES), fileable: true }));
    const r = admit(cs, { governor: { max_issues_per_hour: 3 }, now: NOW });
    assert.ok(r.file.length <= 3);
    assert.ok(r.summary);
  });
});
