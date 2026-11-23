// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainMetrics, cascadeMetrics, chainsReport, formatChainLines } from "./chains.mjs";

const M = 60000;
const row = (issue, a, e, extra = {}) => ({ issue, admitted_at: a * M, ended_at: e * M, outcome: "merged", ...extra });

describe("chain metrics (#5834)", () => {
  it("depth, wall time and per-link overlap for a depth-3 chain", () => {
    const m = chainMetrics([row(1, 0, 50), row(2, 5, 70, { deps: [1], stacked: true }), row(3, 10, 90, { deps: [2], stacked: true }), row(9, 0, 5)]);
    assert.equal(m.chains.length, 1, "a lone issue is not a chain");
    assert.equal(m.chains[0].depth, 3); assert.equal(m.chains[0].wall_min, 90);
    assert.deepEqual(m.chains[0].links.map((l) => [l.issue, l.dependency, l.overlap_min]), [[2, 1, 45], [3, 2, 60]]);
    assert.deepEqual(m.by_depth, { 3: { chains: 1, wall_p50_min: 90 } });
  });
  it("p50 by depth over several chains", () => {
    const m = chainMetrics([row(1, 0, 40), row(2, 0, 60, { deps: [1] }), row(3, 0, 50), row(4, 0, 100, { deps: [3] }), row(5, 0, 80), row(6, 0, 90, { deps: [5] })]);
    assert.deepEqual(m.by_depth, { 2: { chains: 3, wall_p50_min: 90 } });
  });
  it("a dependent that started after its dependency ended has no overlap", () => {
    const m = chainMetrics([row(1, 0, 10), row(2, 20, 30, { deps: [1] })]);
    assert.equal(m.chains[0].links[0].overlap_min, 0);
  });
  it("rows without timestamps are skipped; a dependency cycle does not hang", () => {
    assert.deepEqual(chainMetrics([{ issue: 1 }, { issue: 2, deps: [1] }]).chains, []);
    assert.equal(chainMetrics([row(1, 0, 5, { deps: [2] }), row(2, 0, 5, { deps: [1] })]).chains.length, 1);
  });
  it("cascade rework rate, with and without cascades", () => {
    assert.equal(cascadeMetrics([{ issue: 1 }]).rework_rate, null);
    assert.equal(cascadeMetrics([{ issue: 2, stacked: true }]).rework_rate, 0);
    const c = cascadeMetrics([{ issue: 2, stacked: true, cascade: "rebase", cascades: ["reverify", "rebase"], cascade_cost_usd: 0.5, cascade_minutes: 4 }, { issue: 3, stacked: true }]);
    assert.deepEqual(c, { stacked: 2, cascaded: 1, cascades: 2, rework_rate: 0.5, per_stacked: 1, cost_usd: 0.5, minutes: 4 });
  });
  it("chainsReport reads a batch's report.json and formats p50 by depth and the rework rate", () => {
    const root = mkdtempSync(join(tmpdir(), "chains-")), dir = join(root, "b1");
    mkdirSync(dir);
    const now = Date.parse("2026-11-23T00:00:00Z");
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ created: "2026-11-22T00:00:00Z", repo: "o/r" }));
    writeFileSync(join(dir, "report.json"), JSON.stringify({ rows: [row(1, 0, 50), row(2, 5, 70, { deps: [1], stacked: true, cascade: "rebase", cascades: ["rebase"], cascade_minutes: 3 })] }));
    const w = chainsReport({ batchRoot: root, repo: "o/r", windows: [7 * 86400000], now });
    assert.equal(w["7d"].chains, 1);
    assert.equal(chainsReport({ batchRoot: root, repo: "x/y", windows: [7 * 86400000], now })["7d"].chains, 0);
    const text = formatChainLines(w).join("\n");
    assert.match(text, /depth 2: 1 chain, wall p50 70\.0 min/);
    assert.match(text, /cascade rework: 100% of 1 stacked dependent/);
    assert.match(formatChainLines(chainsReport({ batchRoot: root, repo: "x/y", windows: [86400000], now })).join("\n"), /chain wall p50: n\/a/);
  });
});
