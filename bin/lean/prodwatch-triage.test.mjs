// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fingerprint, signalRef, cluster, parseAlertRules, classifyCluster, validateCluster, tallyClusters, CLASSES, DEFAULT_RULES, trailerOf } from "./prodwatch-triage.mjs";
import { parseSources, normalizeMemo } from "./prodwatch-sources.mjs";
import { loadPolicy } from "./decision-engine.mjs";

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/prodwatch/${f}`, import.meta.url), "utf8"));
const SRC = { name: "memos" };
const sig = (title, body, extra = {}) => ({ id: "x", source: "s", title, severity: "P2", owner: null, first_seen: null, last_seen: null, body, ...extra });
const spy = (answers) => { const calls = []; return { calls, exec: async (c) => { calls.push(c); return answers(c) ?? { code: 1, stdout: "" }; } }; };

describe("fingerprint", () => {
  it("is stable across ids, timestamps, hosts and numbers, and differs for other text", () => {
    const a = sig("Pool exhausted on db-1.example", "at 2026-10-29T10:00:00Z request 3c6ef362 waited 17s");
    const b = sig("Pool exhausted on db-9.example", "at 2026-10-30T23:59:59Z request ffee0011 waited 4s");
    assert.equal(fingerprint(a), fingerprint(b));
    assert.notEqual(fingerprint(a), fingerprint(sig("Disk full", "volume at 90 percent")));
    assert.match(fingerprint(a), /^[0-9a-f]{12}$/);
  });
});

describe("cluster", () => {
  const memos = fx("memos.json").map((m) => normalizeMemo(m.id, m.text, SRC));
  it("70 anonymised memos give the expected clusters; 15 pg copies are one", () => {
    const exp = fx("expected.json");
    assert.equal(memos.length, exp.memos);
    const cs = cluster(memos);
    assert.equal(cs.length, exp.clusters.length);
    assert.deepEqual(cs.map((c) => c.count), exp.clusters.map((c) => c.count).sort((x, y) => y - x));
    assert.equal(cs[0].count, 15);
    assert.match(cs[0].signals[0].title, /Postgres/);
    const classes = cs.map((c) => classifyCluster(c, DEFAULT_RULES));
    const want = {};
    for (const c of exp.clusters) want[c.class] = (want[c.class] ?? 0) + 1;
    const got = {};
    for (const c of classes) got[c] = (got[c] ?? 0) + 1;
    assert.deepEqual(got, want);
    assert.equal(exp.clusters.filter((c) => !["transient", "expected-class"].includes(c.class)).length, 8, "8 issue clusters");
  });
  it("dedups against an open issue carrying a SIGNAL_REF; the rest stay new", () => {
    const [pg, other] = cluster(memos);
    const open = [{ number: 77, body: `Fix pool\n${signalRef(pg.fingerprint)}` }, { number: 78, body: "no marker" }];
    const cs = cluster(memos, open);
    assert.equal(cs.find((c) => c.fingerprint === pg.fingerprint).duplicateOf, 77);
    assert.equal(cs.find((c) => c.fingerprint === other.fingerprint).duplicateOf, null);
  });
  it("carries worst severity, owner and the seen window", () => {
    const [c] = cluster([sig("A", "b", { severity: "P2", first_seen: "2026-01-02", last_seen: "2026-01-03", owner: "o" }), sig("A", "b", { severity: "P0", first_seen: "2026-01-01", last_seen: "2026-01-02" })]);
    assert.deepEqual([c.severity, c.owner, c.first_seen, c.last_seen, c.count], ["P0", "o", "2026-01-01", "2026-01-03", 2]);
  });
});

describe("classifyCluster and rules", () => {
  const one = (title, body = "", sev = "P2") => cluster([sig(title, body, { severity: sev })])[0];
  it("covers all six classes with the defaults", () => {
    assert.deepEqual(CLASSES, ["incident", "defect", "monitoring-bug", "expected-class", "deploy-fallout", "transient"]);
    assert.equal(classifyCluster(one("Nightly backup completed")), "expected-class");
    assert.equal(classifyCluster(one("Alert is a false positive")), "monitoring-bug");
    assert.equal(classifyCluster(one("Transient timeout")), "transient");
    assert.equal(classifyCluster(one("Errors after the deploy")), "deploy-fallout");
    assert.equal(classifyCluster(one("Service down")), "incident");
    assert.equal(classifyCluster(one("Odd latency")), "defect");
    assert.equal(classifyCluster(one("Odd latency", "", "P0")), "incident");
  });
  it("reads rules from the policy text loadPolicy returns, repo rules before defaults", () => {
    const text = "# Star\n\nAlert rules:\n- expected-class: /canary/\n- transient: blip, wobble\n- nonsense: x\n- defect: /(/\n\nOther text\n";
    const policy = loadPolicy({ io: { readFile: (p) => { if (p.endsWith("NORTHSTAR.md")) return text; throw new Error("nope"); } } });
    const { rules, warnings } = parseAlertRules(policy.policyText);
    assert.equal(warnings.length, 2);
    assert.equal(classifyCluster(one("Canary check ok"), rules), "expected-class");
    assert.equal(classifyCluster(one("A wobble"), rules), "transient");
    assert.equal(classifyCluster(one("Nightly backup completed"), rules), "expected-class", "defaults still apply");
    assert.equal(parseAlertRules("").rules.length, DEFAULT_RULES.length);
  });
});

describe("validateCluster", () => {
  const sources = parseSources({ sql: { kind: "sql", run: "PSQL {sql}", queries: [{ name: "pool", sql: "select 1" }] } });
  const pg = (extra = {}) => ({ ...cluster([sig("Pool exhausted", "p", { query: "pool" })])[0], ...extra });
  const rows = { code: 0, stdout: JSON.stringify([{ pool: 1 }]) };
  it("attaches reproduced evidence and files only with evidence; runs only declared commands", async () => {
    const io = spy((c) => (c === "PSQL select 1" ? rows : null));
    const v = await validateCluster(pg(), { sources, ...io });
    assert.equal(v.fileable, true);
    assert.ok(v.evidence.length >= 1);
    assert.deepEqual(io.calls, ["PSQL select 1"]);
    const none = await validateCluster(pg({ signals: [sig("Pool exhausted", "p", { query: "other" })] }), { sources, ...spy(() => rows), match: () => false });
    assert.equal(none.fileable, false);
    assert.equal(none.reason, "no reproduced evidence");
    assert.equal((await validateCluster(pg(), { sources: [], exec: async () => rows })).reason, "no read-only queries declared");
  });
  it("never files expected-class or a duplicate, and does not even query", async () => {
    const io = spy(() => rows);
    const e = await validateCluster(pg({ class: "expected-class" }), { sources, ...io });
    const d = await validateCluster(pg({ duplicateOf: 5 }), { sources, ...io });
    assert.deepEqual([e.fileable, d.fileable, io.calls.length], [false, false, 0]);
    assert.match(d.reason, /#5/);
  });
  it("a monitoring-bug is fileable when the queries ran clean and found nothing; a failing query is not", async () => {
    const clean = await validateCluster(pg({ class: "monitoring-bug", signals: [sig("Alert false positive", "x")] }), { sources, exec: async () => ({ code: 0, stdout: "[]" }) });
    assert.equal(clean.fileable, true);
    const broken = await validateCluster(pg({ class: "monitoring-bug", signals: [sig("Alert false positive", "x")] }), { sources, exec: async () => ({ code: 2, stdout: "" }) });
    assert.equal(broken.fileable, false);
    assert.ok(broken.errors.length);
  });
  it("tallyClusters counts expected-class clusters without filing them", async () => {
    const vs = [await validateCluster(pg(), { sources, exec: async () => rows }), await validateCluster(pg({ class: "expected-class", count: 11 }), { sources })];
    const t = tallyClusters(vs);
    assert.equal(t.fileable, 1);
    assert.equal(t.byClass["expected-class"], 1);
    assert.equal(t.clusters, 2);
  });
});

describe("trailer-only markers (#4879)", () => {
  it("trailerOf returns only the trailing run of FORGE markers", () => {
    const body = `a <!-- FORGE:SIGNAL_REF fp=aaaaaaaaaaaa --> b\n\n${signalRef("bbbbbbbbbbbb")}\n<!-- FORGE:PRODWATCH source=am -->\n`;
    const t = trailerOf(body);
    assert.ok(t.includes("bbbbbbbbbbbb") && t.includes("source=am") && !t.includes("aaaaaaaaaaaa"));
    assert.equal(trailerOf("no markers"), "");
    assert.equal(trailerOf(undefined), "");
  });
  it("cluster ignores a SIGNAL_REF outside the trailer", () => {
    const sig = [{ title: "db down", body: "x" }];
    const fp = fingerprint(sig[0]);
    const spoof = { number: 9, body: `quote ${signalRef(fp)} more text` };
    assert.equal(cluster(sig, [spoof])[0].duplicateOf ?? null, null);
    const real = { number: 10, body: `text\n\n${signalRef(fp)}\n` };
    assert.equal(cluster(sig, [real])[0].duplicateOf, 10);
  });
});
