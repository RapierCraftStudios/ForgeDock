// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DEFAULT_RISK_RULES, deriveFacts, riskOf, verifyExistsIn, buildClassifyRecord, applySourceRules, validateClassification, labelsOf, renderClassify } from "./release-classify.mjs";

const policy = {
  units: { api: { paths: ["services/api/**"] }, web: { paths: ["web/**"] } },
  couplings: [{ paths: ["shared/**"], affects: ["api", "web"] }],
  contracts: [{ producer: "api", consumers: ["web"], paths: ["services/api/routers/**"] }],
};

describe("deriveFacts", () => {
  it("units come from the map, shared modules and contract from paths", () => {
    const f = deriveFacts(policy, ["services/api/a.py", "shared/detection/x.py", "services/api/routers/r.py"]);
    assert.deepEqual(f.units.sort(), ["api", "web"]);
    assert.deepEqual(f.shared_modules, ["shared/detection"]);
    assert.equal(f.contract, true);
    assert.equal(f.migrations, "none");
  });
  it("a migration path is breaking unless marked HOTFIX-SAFE; HOTFIX-UNSAFE always breaks", () => {
    const p = "infra/migrations/001.sql";
    assert.equal(deriveFacts(policy, [p]).migrations, "breaking");
    assert.equal(deriveFacts(policy, [p], { texts: { [p]: "-- HOTFIX-SAFE\nalter" } }).migrations, "additive");
    assert.equal(deriveFacts(policy, [p, "a.py"], { texts: { [p]: "-- HOTFIX-SAFE", "a.py": "# HOTFIX-UNSAFE" } }).migrations, "breaking");
  });
});

describe("riskOf", () => {
  it("first matching rule wins (migration high before contract medium)", () => {
    const f = deriveFacts(policy, ["infra/migrations/1.sql", "services/api/routers/r.py"]);
    assert.deepEqual(riskOf(policy, f), { risk: "high", rule: 1, forces: "release" });
  });
  it("contract is medium, a plain one-unit diff is low, a large diff is medium", () => {
    assert.equal(riskOf(policy, deriveFacts(policy, ["services/api/routers/r.py"])).risk, "medium");
    assert.equal(riskOf(policy, deriveFacts(policy, ["web/a.js"])).risk, "low");
    assert.equal(riskOf(policy, deriveFacts(policy, ["web/a.js"], { diffLines: 401 })).risk, "medium");
  });
  it("policy risk.rules replace the defaults and high_paths globs match", () => {
    const p = { ...policy, risk: { rules: [{ when: { paths: ["web/billing/**"] }, risk: "high" }] } };
    assert.equal(riskOf(p, deriveFacts(p, ["web/billing/x.js"])).risk, "high");
    assert.equal(riskOf(p, deriveFacts(p, ["web/other.js"])).risk, "low");
  });
});

describe("verifyExistsIn", () => {
  const rec = { exists_in: "live", exists_in_evidence: { cite: "a.py:2", repro: { command: "pytest x", red_on_live: true, green_after: true } } };
  const red = () => 1;
  const git = async (a) => { if (a[0] === "cat-file") { if (a[2].endsWith("missing.py")) throw new Error("nope"); return ""; } return "l1\nl2\nl3"; };
  it("keeps live when the line exists on the live sha and the repro is red then green", async () => {
    assert.equal((await verifyExistsIn(rec, { git, liveSha: "abc", run: red })).exists_in, "live");
  });
  it("downgrades to unknown and release otherwise", async () => {
    for (const r of [{ ...rec, exists_in_evidence: { cite: "missing.py:2", repro: rec.exists_in_evidence.repro } }, { ...rec, exists_in_evidence: { cite: "a.py:9", repro: rec.exists_in_evidence.repro } }, { ...rec, exists_in_evidence: { cite: "a.py:2" } }]) {
      const o = await verifyExistsIn(r, { git, liveSha: "abc", run: red });
      assert.equal(o.exists_in, "unknown"); assert.equal(o.lane_hint, "release");
    }
    assert.equal((await verifyExistsIn(rec, { git, liveSha: null, run: red })).exists_in, "unknown");
  });
});

describe("verifyExistsIn repro and defaults (#5557)", () => {
  const git = async (a) => (a[0] === "cat-file" ? "" : "l1\nl2\nl3");
  const mk = (green) => ({ exists_in: "live", exists_in_evidence: { cite: "a.py:2", repro: { command: "false", red_on_live: true, green_after: green } } });
  it("a repro that passes (not red) on the live sha downgrades to unknown + release", async () => {
    const o = await verifyExistsIn(mk(null), { git, liveSha: "abc", run: async () => ({ exit: 0 }) });
    assert.equal(o.exists_in, "unknown"); assert.equal(o.lane_hint, "release");
  });
  it("green_after null is accepted while the repro is red", async () => {
    const o = await verifyExistsIn(mk(null), { git, liveSha: "abc", run: async () => ({ exit: 2 }) });
    assert.equal(o.exists_in, "live"); assert.equal(o.exists_in_evidence.repro.green_after, null);
  });
  it("without a run callback live cannot be verified; staging-only needs no evidence", async () => {
    assert.equal((await verifyExistsIn(mk(null), { git, liveSha: "abc" })).exists_in, "unknown");
    assert.equal((await verifyExistsIn({ exists_in: "staging-only" }, { git })).exists_in, "staging-only");
  });
  it("round trip: a record in the prompt shape survives as live in a fixture git repo", async () => {
    const d = tmpDir("classify-rt-");
    try {
      const g = (...a) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
      g("init", "-q"); writeFileSync(join(d, "a.py"), "x = 1\ny = 2\n"); g("add", "."); g("commit", "-qm", "c");
      const sha = g("rev-parse", "HEAD").trim();
      const rec = JSON.parse(JSON.stringify({ type: "bug", severity: "P2", exists_in: "live", flag: "none", exists_in_evidence: { cite: "a.py:2", repro: { command: "exit 1", red_on_live: true, green_after: null } } }));
      const o = await verifyExistsIn(rec, { git: async (a) => g(...a), liveSha: sha, run: async (cmd) => { try { execFileSync("sh", ["-c", cmd], { cwd: d }); return 0; } catch (e) { return e.status ?? 1; } } });
      assert.equal(o.exists_in, "live");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("six built-in defaults apply in order when the policy has no rules", () => {
    assert.equal(DEFAULT_RISK_RULES.length, 6);
    const r = (files, o) => riskOf({}, deriveFacts(policy, files, o));
    assert.deepEqual(r(["infra/migrations/1.sql"]), { risk: "high", rule: 1, forces: "release" });
    assert.equal(r(["shared/billing_x.py"]).rule, 2);
    assert.equal(r(["shared/detection/x.py"]).rule, 3);
    assert.equal(r(["services/api/routers/r.py"]).rule, 4);
    assert.equal(r(["services/api/a.py", "web/a.js"]).rule, 5);
    assert.equal(r(["web/a.js"], { diffLines: 500 }).rule, 6);
    assert.deepEqual(r(["web/a.js"]), { risk: "low", rule: "default" });
  });
  it("validateClassification checks field types and hotfixMarkers drive migrations", () => {
    assert.ok(validateClassification({ type: "bug", severity: "P2", exists_in: "unknown", units: "api", ready: "yes", confidence: 2, deps: [1], source: "x", exists_in_evidence: { repro: { command: "c", red_on_live: "y" } } }).length >= 6);
    assert.deepEqual(validateClassification({ type: "bug", severity: "P2", exists_in: "live", exists_in_evidence: { cite: "a:1", repro: { command: "c", red_on_live: true, green_after: null } }, epic: null }), []);
    assert.equal(deriveFacts(policy, ["a.py"], { hotfixMarkers: { unsafe: true } }).migrations, "breaking");
    assert.equal(deriveFacts(policy, ["infra/migrations/1.sql"], { hotfixMarkers: { safe: ["infra/migrations/1.sql"] } }).migrations, "additive");
  });
});

describe("text-only and record building", () => {
  it("text-only caps confidence at 0.5 and never trusts migrations none", () => {
    const o = applySourceRules({ source: "text-only", confidence: 0.9, migrations: "none" }, policy);
    assert.equal(o.confidence, 0.5); assert.notEqual(o.migrations, "none");
  });
  it("buildClassifyRecord ignores LLM-typed units and migrations and forces release on a migration", () => {
    const f = deriveFacts(policy, ["infra/migrations/1.sql"]);
    const r = buildClassifyRecord({ type: "bug", severity: "P2", exists_in: "unknown", units: ["web"], migrations: "none", risk: "low" }, policy, f);
    assert.deepEqual(r.units, []); assert.equal(r.migrations, "breaking"); assert.equal(r.risk, "high"); assert.equal(r.lane_hint, "release");
  });
  it("validates enums, builds namespaced labels and a comment body", () => {
    assert.ok(validateClassification({ type: "x", severity: "P9", exists_in: "live" }).length >= 2);
    assert.deepEqual(validateClassification({ type: "bug", severity: "P2", exists_in: "unknown" }), []);
    const r = buildClassifyRecord({ type: "bug", severity: "P2", exists_in: "unknown" }, policy, deriveFacts(policy, ["web/a.js"]));
    assert.deepEqual(labelsOf(r), ["type:bug", "priority:P2", "where:unknown", "unit:web", "mig:none", "risk:low"]);
    assert.match(renderClassify(r), /"units"/);
    assert.ok(labelsOf({ ...r, lane_hint: "release" }).includes("lane:release"), "lane_hint adds a lane:* label");
    assert.ok(!labelsOf({ ...r, lane_hint: "none" }).some((l) => l.startsWith("lane:")));
  });
});
