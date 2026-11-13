// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNightlyConfig, classifyTier, readNightly, blocksRelease, fileNightlyRed } from "./release-nightly.mjs";

const cfg = parseNightlyConfig({ workflow: "nightly.yml", branch: "staging", t3_jobs: "hands e2e", t4_jobs: "trivy", unskippable: "migration" });
const NOW = Date.parse("2026-11-12T12:00:00Z");
const hAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

describe("nightly (#5569)", () => {
  it("config is null when unset and has the 24h/168h defaults", () => {
    assert.equal(parseNightlyConfig(undefined), null);
    assert.equal(cfg.t0t2Hours, 24); assert.equal(cfg.t3t4Hours, 168); assert.equal(cfg.blockRelease, true);
  });
  it("classifies tiers by prefix, then config, else T2", () => {
    assert.equal(classifyTier("T1 unit api", cfg), 1);
    assert.equal(classifyTier("Hands e2e", cfg), 3);
    assert.equal(classifyTier("Trivy scan", cfg), 4);
    assert.equal(classifyTier("lint", cfg), 2);
  });
  it("blocks only a release, only by T0-T2 or unskippable reds, never T3/T4", () => {
    const reds = [{ name: "T1 unit", tier: 1 }, { name: "Hands e2e", tier: 3 }, { name: "migration safety", tier: 3 }];
    assert.deepEqual(blocksRelease({ lane: "release", reds, cfg }).map((r) => r.name), ["T1 unit", "migration safety"]);
    assert.deepEqual(blocksRelease({ lane: "release", reds: [reds[1]], cfg }), []);
    assert.deepEqual(blocksRelease({ lane: "train", reds, cfg }), []);
    assert.deepEqual(blocksRelease({ lane: "p0", reds, cfg }), []);
    assert.deepEqual(blocksRelease({ lane: "release", reds, cfg: { ...cfg, blockRelease: false } }), []);
  });
  it("reads T0-T2 from the newest run and T3/T4 from the newest weekly run", async () => {
    const jobs = { 1: [{ name: "T1 unit", conclusion: "failure" }, { name: "lint", conclusion: "success" }], 2: [{ name: "Hands e2e", conclusion: "failure" }] };
    const gh = async (a) => /workflows/.test(a[1]) ? JSON.stringify({ workflow_runs: [{ id: 1, created_at: hAgo(2) }, { id: 2, created_at: hAgo(30) }] }) : JSON.stringify({ jobs: jobs[/runs\/(\d)/.exec(a[1])[1]] });
    const n = await readNightly({ gh, repo: "o/r", cfg, now: NOW });
    assert.deepEqual(n.reds.map((r) => [r.name, r.tier, r.run]), [["T1 unit", 1, 1], ["Hands e2e", 3, 2]]);
    assert.equal(n.stale, false);
    assert.equal(await readNightly({ gh: async () => "x", repo: "o/r", cfg, now: NOW }), null);
  });
  it("files one nightly-red issue and edits it afterwards; green files nothing", async () => {
    const calls = []; let open = [];
    const gh = async (a) => { calls.push(a.slice(0, 2).join(" ")); if (a[1] === "list") return JSON.stringify(open); if (a[1] === "create") return "https://github.com/o/r/issues/77"; return ""; };
    const reds = [{ name: "T1 unit", tier: 1, run: 1 }];
    assert.equal(await fileNightlyRed({ gh, repo: "o/r", reds: [], run: 1 }), null);
    assert.deepEqual(await fileNightlyRed({ gh, repo: "o/r", reds, run: 1 }), { issue: 77, created: true });
    open = [{ number: 77 }];
    assert.deepEqual(await fileNightlyRed({ gh, repo: "o/r", reds, run: 2 }), { issue: 77, created: false });
    assert.deepEqual(calls, ["issue list", "issue create", "issue list", "issue edit"]);
  });
});
