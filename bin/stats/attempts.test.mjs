// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { attemptMetrics, attemptsReport, formatAttemptLines } from "./attempts.mjs";

describe("attempts per merged issue (#5986)", () => {
  it("counts failed ledger lanes plus the merging lane, and the recorded comment count", () => {
    const m = attemptMetrics([{ issue: 1, outcome: "merged" }, { issue: 2, outcome: "merged" }, { issue: 3, outcome: "needs-human" }], { 2: { attempts: 3, comments: 9 }, 3: { attempts: 4 } });
    assert.equal(m.merged, 2);
    assert.deepEqual(m.detail, [{ issue: 1, attempts: 1, comments: null }, { issue: 2, attempts: 4, comments: 9 }]);
    assert.equal(m.attempts_max, 4); assert.equal(m.attempts_mean, 2.5); assert.equal(m.comments_max, 9);
  });
  it("attemptsReport reads report.json and state.json; the repo filter excludes other repos", () => {
    const root = tmpDir("attempts-"), dir = join(root, "b1");
    mkdirSync(dir);
    const now = Date.parse("2026-11-23T00:00:00Z");
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ created: "2026-11-22T00:00:00Z", repo: "o/r" }));
    writeFileSync(join(dir, "report.json"), JSON.stringify({ rows: [{ issue: 5, outcome: "merged" }] }));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ attempts: { 5: { attempts: 2, comments: 7 } } }));
    const w = attemptsReport({ batchRoot: root, repo: "o/r", windows: [7 * 86400000], now });
    assert.equal(w["7d"].merged, 1); assert.equal(w["7d"].attempts_max, 3); assert.equal(w["7d"].comments_max, 7);
    assert.equal(attemptsReport({ batchRoot: root, repo: "x/y", windows: [86400000], now })["1d"].merged, 0);
    assert.match(formatAttemptLines(w).join("\n"), /attempts per merged issue: mean 3, p50 3, max 3[\s\S]*comments per issue: p50 7, max 7/);
    assert.match(formatAttemptLines(attemptsReport({ batchRoot: root, repo: "x/y", windows: [86400000], now })).join("\n"), /n\/a/);
  });
});
