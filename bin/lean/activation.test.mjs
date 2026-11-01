// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readRollouts, detectNewOffKeys, activationFailures, dormancyReport, coversFlag } from "./activation.mjs";
import { precheck } from "./conformance.mjs";

const cfg = { files: ["config/rollouts.json"], days: 14 };
const DIFF = [
  "diff --git a/config/rollouts.json b/config/rollouts.json", "--- a/config/rollouts.json", "+++ b/config/rollouts.json", "@@ -1,3 +1,5 @@",
  '+  "clearance_exit_routing": false,', '+  "already_on": true,', '-  "old_flag": true', '+  "old_flag": false,',
  "diff --git a/src/other.json b/src/other.json", "--- a/src/other.json", "+++ b/src/other.json", '+  "elsewhere": false,',
].join("\n");
const Q_SHADOW = "Hit > 0 and unbound < 5% in shadow within a week";
const contract = (reqs) => ({ requirements: reqs, deliverables: [], preserve: [], validate: [] });
const pre = (c, newOffKeys) => precheck({ contract: c, result: { requirements: c.requirements.map((r) => ({ id: r.id, status: "implemented" })) }, changedFiles: [], newOffKeys });

describe("activation rows (#4769)", () => {
  it("reads the forge.yaml rollouts registry", () => {
    assert.deepEqual(readRollouts("/x", () => 'rollouts:\n  files: "a.json, b.py"\n  dormant_days: 30\n'), { files: ["a.json", "b.py"], days: 30 });
    assert.equal(readRollouts("/x", () => "engine:\n  path: core\n"), null);
    assert.equal(readRollouts("/x", () => { throw new Error("none"); }), null);
  });

  it("a registry diff yields only new off keys in declared files", () => {
    assert.deepEqual(detectNewOffKeys(cfg, DIFF), ["clearance_exit_routing"]);
    assert.deepEqual(detectNewOffKeys(null, DIFF), []);
  });

  it("a contract without an activation row fails; an owner:promote row or a named deliver row passes", () => {
    const base = { id: "R1", quote: "Ship the clearance routing change", disposition: "deliver" };
    const keys = detectNewOffKeys(cfg, DIFF);
    const bad = pre(contract([base]), keys);
    assert.equal(bad.ok, false); assert.ok(bad.failures.some((f) => f.kind === "activation_missing"));
    const owner = { id: "R2", quote: "Turn it on after shadow", disposition: "defer", bucket: "owner:promote:clearance_exit_routing", why: "w" };
    assert.equal(pre(contract([base, owner]), keys).ok, true);
    assert.equal(pre(contract([base, { ...owner, bucket: "owner:promote:clearance_*" }]), keys).ok, true);
    assert.equal(pre(contract([{ ...base, why: "also flips clearance_exit_routing to the first cohort" }]), keys).ok, true);
    assert.equal(coversFlag({ disposition: "defer", bucket: "owner:promote:other" }, "clearance_exit_routing"), false);
  });

  it("no new off key leaves precheck unchanged", () => {
    assert.equal(pre(contract([{ id: "R1", quote: Q_SHADOW, disposition: "deliver" }]), []).ok, true);
    assert.equal(pre(contract([{ id: "R1", quote: Q_SHADOW, disposition: "deliver" }]), null).ok, true);
  });

  it("an 'in shadow' AC fails when the change ships off with no activation row, and passes with one", () => {
    const ac = { id: "R1", quote: Q_SHADOW, disposition: "deliver" };
    const fails = activationFailures(contract([ac]), ["clearance_exit_routing"]);
    assert.ok(fails.some((f) => f.kind === "mode_unreachable" && /R1 names shadow/.test(f.detail)));
    const row = { id: "R2", quote: "Promote it", disposition: "defer", bucket: "owner:promote:clearance_exit_routing", why: "w" };
    assert.deepEqual(activationFailures(contract([ac, row]), ["clearance_exit_routing"]), []);
  });
});

describe("dormancy report (#4769)", () => {
  const now = Date.parse("2026-10-29T00:00:00Z");
  const introduced = [
    { flag: "EXTRACTION_V2_CANARY_PCT", parent: 21002, since: "2026-06-17" },
    { flag: "clearance_exit_routing", parent: 36817, since: "2026-10-10" },
    { flag: "recent_flag", parent: 1, since: "2026-10-25" },
    { flag: "now_on", parent: 2, since: "2026-01-01" },
    { flag: "egress_country_exploration", parent: 36623, since: "2026-09-01" },
  ];
  const flagState = async (f) => (f === "now_on" ? "on" : "off");
  it("lists still-off flags past N days with days dormant and parent", async () => {
    const r = await dormancyReport({ introduced, flagState, now });
    assert.deepEqual(r.map((x) => [x.flag, x.parent, x.days]), [["EXTRACTION_V2_CANARY_PCT", 21002, 134], ["egress_country_exploration", 36623, 58], ["clearance_exit_routing", 36817, 19]]);
    assert.deepEqual((await dormancyReport({ introduced, flagState, now, days: 60 })).map((x) => x.flag), ["EXTRACTION_V2_CANARY_PCT"]);
  });
  it("a keep-off decision (exact or wildcard) silences the entry", async () => {
    const r = await dormancyReport({ introduced, flagState, now, decisions: [{ flag: "EXTRACTION_V2_*", decision: "keep-off" }, { flag: "egress_country_exploration", decision: "promote" }] });
    assert.deepEqual(r.map((x) => x.flag), ["egress_country_exploration", "clearance_exit_routing"]);
  });
});
