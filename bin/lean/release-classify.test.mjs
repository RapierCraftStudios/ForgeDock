// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveFacts, riskOf, verifyExistsIn, buildClassifyRecord, applySourceRules, validateClassification, labelsOf, renderClassify } from "./release-classify.mjs";

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
  const rec = { exists_in: "live", exists_in_evidence: { cite: "a.py:2", repro: { red_on_live: true, green_after: true } } };
  const git = async (a) => { if (a[0] === "cat-file") { if (a[2].endsWith("missing.py")) throw new Error("nope"); return ""; } return "l1\nl2\nl3"; };
  it("keeps live when the line exists on the live sha and the repro is red then green", async () => {
    assert.equal((await verifyExistsIn(rec, { git, liveSha: "abc" })).exists_in, "live");
  });
  it("downgrades to unknown and release otherwise", async () => {
    for (const r of [{ ...rec, exists_in_evidence: { cite: "missing.py:2", repro: rec.exists_in_evidence.repro } }, { ...rec, exists_in_evidence: { cite: "a.py:9", repro: rec.exists_in_evidence.repro } }, { ...rec, exists_in_evidence: { cite: "a.py:2" } }]) {
      const o = await verifyExistsIn(r, { git, liveSha: "abc" });
      assert.equal(o.exists_in, "unknown"); assert.equal(o.lane_hint, "release");
    }
    assert.equal((await verifyExistsIn(rec, { git, liveSha: null })).exists_in, "unknown");
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
    assert.deepEqual(labelsOf(r), ["type:bug", "where:unknown", "unit:web", "mig:none", "risk:low"]);
    assert.match(renderClassify(r), /"units"/);
  });
});
