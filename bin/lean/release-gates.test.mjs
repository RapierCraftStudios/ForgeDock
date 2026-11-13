// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import {
  validateCatalogue, parseCatalogue, gateRecord, telemetryLine, parseTelemetry, summarize, formatGatesReport, planDemotions, applyDemotions,
  parseGatesConfig, isSafetyGate, admission, gatesFromCli, effectiveGateMode, REQUIRED,
} from "./release-gates.mjs";
import { runControl } from "./release-control.mjs";

const GATE = { id: "g1", protects_against: "#12", where: "deploy.yml", determinism: "high", pre_merge_artifact: "fixtures/g1.json", version: "v1", mode: "block", owner: "ops", review_by: "2027-01-01", on_uncertainty: "inconclusive", failure_triggers: "blocks deploy", proportionality: "one deploy at risk" };
const cat = (...gates) => ({ schema: 1, gates });
const T0 = Date.parse("2026-11-01T00:00:00Z");
const runs = (gate, n, fb, at = "2026-11-01T00:00:00Z") => Array.from({ length: n }, (_, i) => ({ gate, outcome: i < fb ? "fail" : "pass", class: i < fb ? "FB" : "unknown", minutes: 2, at }));

describe("catalogue schema", () => {
  it("accepts a valid catalogue", () => assert.deepEqual(validateCatalogue(cat(GATE)), []));
  it("reports each missing field", () => {
    for (const k of REQUIRED) { const { [k]: _, ...g } = GATE; assert.match(validateCatalogue(cat(g)).join(), new RegExp(`${k}: required`)); }
  });
  it("rejects a bad mode, unknown key, duplicate id and bad date", () => {
    assert.match(validateCatalogue(cat({ ...GATE, mode: "nope" })).join(), /mode: "nope" is not one of block\|skip\|rollback\|freeze\|warn\|red/);
    assert.match(validateCatalogue(cat({ ...GATE, extra: 1 })).join(), /extra: unknown key/);
    assert.match(validateCatalogue(cat(GATE, GATE)).join(), /duplicate g1/);
    assert.match(validateCatalogue(cat({ ...GATE, review_by: "soon" })).join(), /review_by/);
    assert.match(validateCatalogue({ gates: [] }).join(), /schema/);
  });
  it("parses yaml", () => assert.deepEqual(validateCatalogue(parseCatalogue("schema: 1\ngates: []\n").catalogue), []));
});

describe("telemetry", () => {
  it("a class without evidence is unknown; with evidence it is kept", () => {
    assert.equal(gateRecord({ gate: "g", outcome: "fail", class: "FB", minutes: 3 }).class, "unknown");
    assert.equal(gateRecord({ gate: "g", outcome: "fail", class: "FB", evidence: "run 9: rerun green" }).class, "FB");
    assert.equal(gateRecord({ gate: "g", outcome: "boom" }), null);
  });
  it("emits and re-reads the documented json line", () => {
    const rec = gateRecord({ gate: "g", outcome: "pass", minutes: 4 });
    assert.deepEqual(JSON.parse(telemetryLine(rec)), { schema: "forgedock.release.gate/v1", gate: "g", outcome: "pass", class: "unknown", minutes: 4 });
    assert.deepEqual(parseTelemetry(`noise\n${telemetryLine(rec)}\n`), [rec]);
  });
});

describe("demotion", () => {
  const cfg = parseGatesConfig({ gates: { demote_fb_rate: 5, demote_window: 100 } });
  it("defaults to 5% over 20 runs", () => assert.deepEqual([parseGatesConfig(null).demoteFbRate, parseGatesConfig(null).demoteWindow], [5, 20]));
  it("6% is demoted, 5% is not, an allowlisted gate at 50% never is", () => {
    assert.deepEqual(planDemotions(runs("a", 100, 6), cfg).map((p) => p.gate), ["a"]);
    assert.deepEqual(planDemotions(runs("a", 100, 5), cfg), []);
    assert.deepEqual(planDemotions(runs("backup-freshness", 100, 50), cfg), []);
    assert.deepEqual(planDemotions(runs("migration:x", 100, 50), cfg), []);
    assert.deepEqual(planDemotions(runs("a", 99, 50), cfg), [], "an incomplete window never decides");
  });
  it("only the last window counts, and a live demotion is not repeated", () => {
    assert.deepEqual(planDemotions([...runs("a", 50, 50), ...runs("a", 100, 0)], cfg), []);
    const live = { a: { until: new Date(T0 + 1e9).toISOString(), mode: "warn" } };
    assert.deepEqual(planDemotions(runs("a", 100, 9), cfg, { gateModes: live, now: T0 }), []);
    assert.equal(effectiveGateMode("a", "block", live, T0), "warn");
    assert.equal(effectiveGateMode("a", "block", live, T0 + 2e9), "block");
  });
  it("applyDemotions files an issue and records an audited, expiring demotion; promotion without fixture is refused", async () => {
    const state = { files: {}, controls: "", issues: [], active: { epoch: 1, lease: null } };
    const io = {
      now: () => T0,
      gh: async (a) => { state.issues.push(a); return "https://github.com/o/r/issues/42\n"; },
      api: async (m, p, body) => {
        if (m === "GET" && /git\/ref\/heads\/_active$/.test(p)) return { object: { sha: "h" } };
        if (m === "GET" && /contents\/active\.json/.test(p)) return { content: Buffer.from(JSON.stringify(state.active)).toString("base64") };
        if (m === "GET" && /contents\/controls\.jsonl/.test(p)) return { content: Buffer.from(state.controls).toString("base64") };
        if (m === "GET" && /git\/commits\//.test(p)) return { tree: { sha: "t" } };
        if (m === "POST" && /git\/trees/.test(p)) { for (const t of body.tree) state.files[t.path] = t.content; return { sha: "t1" }; }
        if (m === "POST" && /git\/commits/.test(p)) return { sha: "c1" };
        if (m === "PATCH" && /git\/refs/.test(p)) { state.active = JSON.parse(state.files["active.json"]); state.controls = state.files["controls.jsonl"]; return {}; }
        throw new Error(`unrouted ${m} ${p}`);
      },
    };
    const policy = { gates: { demote_fb_rate: 5, demote_window: 100 } };
    const res = await applyDemotions({ io, repo: "o/r", policy, records: [...runs("a", 100, 6), ...runs("backup-freshness", 100, 50)], now: T0 });
    assert.deepEqual(res, [{ gate: "a", ok: true, issue: 42 }]);
    assert.equal(state.issues.length, 1);
    assert.equal(state.active.gateModes.a.mode, "warn");
    assert.ok(Date.parse(state.active.gateModes.a.until) > T0);
    assert.match(state.controls, /"verb":"demote"/);
    const refused = await runControl("promote", ["a", "--reason", "x"], { io, repo: "o/r", now: T0 });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /fixture/);
    assert.ok(state.active.gateModes.a);
    assert.equal(isSafetyGate("identity-preflight"), true);
  });
});

describe("admission checklist", () => {
  it("fails an added gate missing any of the five answers, passes with them", () => {
    assert.deepEqual(admission(cat(), cat(GATE)), []);
    const drops = [["pre_merge_artifact"], ["version"], ["on_uncertainty"], ["failure_triggers"], ["proportionality"], ["owner"], ["review_by"]];
    for (const [k] of drops) { const { [k]: _, ...g } = GATE; assert.equal(admission(cat(), cat(g)).length, 1, k); }
    assert.equal(admission(cat(), cat({ ...GATE, on_uncertainty: "fail" })).length, 1);
  });
  it("only added or changed entries are checked", () => {
    const old = { id: "old", mode: "block" };
    assert.deepEqual(admission(cat(old), cat(old)), []);
    assert.match(admission(cat(old), cat({ ...old, mode: "warn" })).join(), /changed without/);
  });
});

describe("report and cli", () => {
  const history = [...runs("a", 4, 1, "2026-10-30T00:00:00Z"), ...runs("b", 2, 0, "2026-10-30T00:00:00Z"), ...runs("a", 3, 0, "2026-08-01T00:00:00Z")];
  const rows = summarize(history, { sinceMs: 30 * 86_400_000, now: T0 });
  it("reproduces hand-computed counts", () => {
    assert.deepEqual(rows, [{ gate: "a", runs: 4, fails: 1, fb: 1, minutes: 8, fb_share: 25 }, { gate: "b", runs: 2, fails: 0, fb: 0, minutes: 4, fb_share: 0 }]);
  });
  it("text and json goldens", () => {
    assert.deepEqual(formatGatesReport(rows), ["gate\truns\tfails\tfb\tfb_share\tminutes", "a\t4\t1\t1\t25%\t8", "b\t2\t0\t0\t0%\t4"]);
    assert.equal(formatGatesReport(rows, { json: true })[0], '{"schema":"forgedock.release.gates/v1","gates":[{"gate":"a","runs":4,"fails":1,"fb":1,"minutes":8,"fb_share":25},{"gate":"b","runs":2,"fails":0,"fb":0,"minutes":4,"fb_share":0}]}');
  });
  const mk = (git) => { const io = { out: [], calls: [], now: () => T0, print(l) { this.out.push(l); }, git, gh: async (a) => { io.calls.push(a); return ""; }, api: async (...a) => { io.calls.push(a); return {}; } }; return io; };
  it("with no catalogue every subcommand is a no-op with zero writes", async () => {
    const cwd = tmpDir("gates-");
    const io = mk(() => { throw new Error("absent"); });
    for (const argv of [[], ["check"], ["demote"], ["--json"]]) assert.equal(await gatesFromCli(argv, { io, cwd, history: runs("a", 100, 50), repo: "o/r" }), 0);
    assert.deepEqual(io.calls, []);
  });
  it("check compares the worktree catalogue with the base ref", async () => {
    const cwd = tmpDir("gates-");
    mkdirSync(join(cwd, ".forge"));
    const { id, ...noId } = GATE; void noId;
    const { owner: _o, ...noOwner } = GATE;
    const yaml = (g) => `schema: 1\ngates:\n  - ${JSON.stringify(g)}\n`;
    const base = mk(() => "schema: 1\ngates: []\n");
    writeFileSync(join(cwd, ".forge/gates.yaml"), yaml(noOwner));
    assert.equal(await gatesFromCli(["check", "--base", "origin/main"], { io: base, cwd }), 1);
    assert.match(base.out.join("\n"), /owner/);
    writeFileSync(join(cwd, ".forge/gates.yaml"), yaml(GATE));
    const ok = mk(() => "schema: 1\ngates: []\n");
    assert.equal(await gatesFromCli(["check"], { io: ok, cwd }), 0);
  });
  it("report prints from history when a catalogue exists", async () => {
    const io = mk(() => "schema: 1\ngates: []\n");
    assert.equal(await gatesFromCli(["--since", "30d", "--json"], { io, history }), 0);
    assert.equal(JSON.parse(io.out[0]).gates.length, 2);
    assert.equal(await gatesFromCli(["--since", "zz"], { io, history }), 1);
  });
});
