// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4396: decomposition gate (independence and size) and the batch report's decomposed vs single-lane $/parent line.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitGate, rationaleLine, formatDecompositionSummary, SPLIT_MIN_FILES, SPLIT_MIN_LINES } from "./decompose.mjs";
import { classifyBlock } from "./lean.mjs";
import { orchestrate } from "./orchestrate.mjs";

const sub = (paths) => ({ title: "t", body: "b", ...(paths ? { paths } : {}) });

describe("splitGate (#4396)", () => {
  it("admits parts with disjoint paths and records independent", () => {
    const g = splitGate({ subissues: [sub(["src/a", "docs/a.md"]), sub(["./src/b/"]), sub(["src/ab"])] });
    assert.equal(g.ok, true);
    assert.deepEqual(g.rationale, { independent: true, oversize: false, overlaps: [], missing: [], size: null });
  });

  it("rejects overlapping parts (same file, or a file under another part's directory) within the size budget", () => {
    for (const [a, b] of [["src/alerts", "src/alerts/routing.ts"], ["src/x.ts", "./src/x.ts"]]) {
      const g = splitGate({ subissues: [sub([a]), sub([b])], size: { files: 3, lines: 200 } });
      assert.equal(g.ok, false, `${a} ~ ${b}`);
      assert.match(g.problem, /parts overlap/);
      assert.match(g.problem, /ordered checklist/);
      assert.match(g.problem, /within the 25-file \/ 1500-line budget/);
    }
  });

  it("rejects a split whose parts declare no paths and that has no size estimate", () => {
    const g = splitGate({ subissues: [sub(), sub(["src/b"])] });
    assert.equal(g.ok, false);
    assert.match(g.problem, /sub-issue\(s\) 0 declare no "paths"/);
    assert.match(g.problem, /no "size" estimate/);
  });

  it("admits overlapping parts when the size estimate exceeds the budget (files or lines); ignores a non-numeric size", () => {
    const parts = [sub(["src/a"]), sub(["src/a/x.ts"])];
    assert.equal(splitGate({ subissues: parts, size: { files: SPLIT_MIN_FILES + 1 } }).rationale.oversize, true);
    const g = splitGate({ subissues: parts, size: { lines: SPLIT_MIN_LINES + 1 } });
    assert.deepEqual({ ok: g.ok, independent: g.rationale.independent, oversize: g.rationale.oversize }, { ok: true, independent: false, oversize: true });
    assert.equal(splitGate({ subissues: parts, size: { files: SPLIT_MIN_FILES, lines: SPLIT_MIN_LINES } }).ok, false, "at the budget is not over it");
    assert.equal(splitGate({ subissues: parts, size: { files: "99" } }).ok, false);
  });

  it("rationaleLine names independence, overlaps and size against the budget", () => {
    const g = splitGate({ subissues: [sub(["src/a"]), sub(["src/a/x.ts"])], size: { files: 40, lines: 3000 } });
    assert.equal(rationaleLine(g.rationale), "independent: no (overlaps 0:src/a ~ 1:src/a/x.ts); size: 40 files, 3000 lines vs budget 25 files / 1500 lines -> oversize yes");
    assert.equal(rationaleLine(null), "");
  });

  it("classifyBlock turns an unjustified split into an untyped block and carries the rationale of an admitted one", () => {
    const bad = classifyBlock({ block: { kind: "split-required", subissues: [sub(["src/a"]), sub(["src/a"])] } }, 7);
    assert.equal(bad.kind, "untyped");
    assert.match(bad.problem, /split is not justified/);
    const ok = classifyBlock({ block: { kind: "split-required", subissues: [sub(["src/a"]), { ...sub(["src/b"]), depends_on: [0] }] } }, 7);
    assert.equal(ok.kind, "split");
    assert.equal(ok.rationale.independent, true);
    assert.deepEqual(ok.subissues.map((s) => s.dependsOn), [[], [0]]);
  });
});

describe("formatDecompositionSummary (#4396)", () => {
  it("is null when no row decomposed", () => {
    assert.equal(formatDecompositionSummary([{ issue: 1, outcome: "merged", cost_usd: 3 }]), null);
    assert.equal(formatDecompositionSummary(undefined), null);
    assert.equal(formatDecompositionSummary([{ issue: 1, outcome: "decomposed", subissues: [] }]), null);
  });

  it("sums a parent with its sub-lanes (recursively) and compares with merged single-lane parents", () => {
    const rows = [
      { issue: 1, outcome: "decomposed", cost_usd: 2, subissues: [11, 12, 13] },
      { issue: 11, outcome: "merged", cost_usd: 4 },
      { issue: 12, outcome: "decomposed", cost_usd: 1, subissues: [121] },
      { issue: 121, outcome: "merged", cost_usd: 3 },
      { issue: 2, outcome: "merged", cost_usd: 5 },
      { issue: 3, outcome: "merged", cost_usd: 7 },
      { issue: 4, outcome: "needs-human", cost_usd: 9 },
    ];
    assert.equal(formatDecompositionSummary(rows), "decomposition: 1 decomposed parent $10.00/parent (3 sub-lanes, 1 outside this batch); 2 single-lane $6.00/parent");
  });

  it("reports no single-lane parents as none and guards a cycle", () => {
    const rows = [{ issue: 1, outcome: "decomposed", cost_usd: 1, subissues: [2] }, { issue: 2, outcome: "decomposed", cost_usd: 1, subissues: [1] }];
    assert.match(formatDecompositionSummary([{ issue: 1, outcome: "decomposed", cost_usd: 2, subissues: [5] }]), /^decomposition: 1 decomposed parent \$2\.00\/parent \(0 sub-lanes, 1 outside this batch\); single-lane none$/);
    assert.ok(formatDecompositionSummary(rows));
  });

  it("the batch row keeps the lane's subissues and decomposition, so the report links a parent to its sub-lanes", async () => {
    const rationale = { independent: true, oversize: false, overlaps: [], missing: [], size: null };
    const script = { 1: { terminalReason: "decomposed", cost_usd: 2, subissues: [8], decomposition: rationale }, 8: { terminalReason: "merged", cost_usd: 4 }, 2: { terminalReason: "merged", cost_usd: 1 } };
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, readBody: async () => "", runOne: async (n) => script[n] });
    const r1 = rows.find((r) => r.issue === 1);
    assert.deepEqual(r1.subissues, [8]);
    assert.deepEqual(r1.decomposition, rationale);
    assert.equal(formatDecompositionSummary(rows), "decomposition: 1 decomposed parent $6.00/parent (1 sub-lane); 1 single-lane $1.00/parent");
  });
});
