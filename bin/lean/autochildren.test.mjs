// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4965: auto-add of epic and decomposition children: mode parse, child selection, filters.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAutoMode, parseAutoModeFlag, parsePollS, selectChildren, readChildList, liveElsewhere, joinsDecomposed, addsEpicChildren, DEFAULT_POLL_S } from "./autochildren.mjs";

describe("#4965 modes", () => {
  it("default is decomposed; unknown yaml values fall back; the flag rejects them", () => {
    assert.equal(parseAutoMode(undefined), "decomposed");
    assert.equal(parseAutoMode("EPIC"), "epic");
    assert.equal(parseAutoMode("bogus"), "decomposed");
    assert.equal(parseAutoModeFlag("all"), "all");
    assert.throws(() => parseAutoModeFlag("bogus"), /--auto-children/);
    assert.equal(parsePollS(undefined), DEFAULT_POLL_S);
    assert.equal(parsePollS("30"), 30);
    assert.equal(parsePollS("0"), DEFAULT_POLL_S);
  });
  it("which modes add epic children and which join decomposed", () => {
    assert.deepEqual(["off", "decomposed", "epic", "all"].map(addsEpicChildren), [false, false, true, true]);
    assert.deepEqual(["off", "decomposed", "epic", "all"].map(joinsDecomposed), [false, true, true, true]);
  });
});

describe("#4965 selectChildren", () => {
  const list = [
    { number: 1, body: "epic", labels: [], subIssues: { nodes: [{ number: 5 }, { number: 9 }] } },
    { number: 2, body: "x\n\n**Parent**: #1", labels: [] },
    { number: 3, body: "", labels: [], parent: { number: 1 } },
    { number: 4, body: "**Parent**: #1", labels: [{ name: "needs-human" }] },
    { number: 5, body: "", labels: [] },
    { number: 6, body: "**Parent**: #77", labels: [] },
    { number: 7, body: "**Parent**: #1", labels: [] },
  ];
  it("finds children by Parent line, parent field and sub-issues; skips needs-human, closed sub-issues and unrelated", () => {
    assert.deepEqual(selectChildren({ list, roots: [1], skip: [1] }), [2, 3, 5, 7]);
  });
  it("skips issues already in the batch or held elsewhere", () => {
    assert.deepEqual(selectChildren({ list, roots: [1], skip: [1, 2, 7] }), [3, 5]);
  });
  it("an --epic root outside the batch yields its children", () => {
    assert.deepEqual(selectChildren({ list, roots: [77] }), [6]);
  });
  it("children filed later appear on a later list", () => {
    assert.deepEqual(selectChildren({ list: [...list, { number: 8, body: "**Parent**: #1", labels: [] }], roots: [1], skip: [1, 2, 3, 5, 7] }), [8]);
  });
});

describe("#4965 readers", () => {
  it("readChildList makes one gh call", async () => {
    const calls = [];
    const r = await readChildList({ gh: async (a) => { calls.push(a); return "[{\"number\":1}]"; }, repo: "o/r" });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("list") && calls[0].includes("--state"));
    assert.deepEqual(r, [{ number: 1 }]);
  });
  it("liveElsewhere holds the unsettled issues of other live batches of the repo only", () => {
    const mk = (o) => ({ readReport: () => o.report ?? null, readPlan: () => ({ repo: o.repo ?? "o/r" }), store: { load: () => ({ order: o.order, results: o.results ?? {} }) } });
    const bs = { a: mk({ order: [1, 2], results: { 1: {} } }), b: mk({ order: [3], report: {} }), c: mk({ order: [4], repo: "x/y" }), self: mk({ order: [5] }) };
    const batchMod = { listBatches: () => Object.keys(bs), openBatch: (_r, id) => bs[id] };
    assert.deepEqual([...liveElsewhere({ batchMod, root: "/r", self: "self", repo: "o/r" })], [2]);
  });
});

describe("#4965 forge.yaml and resume", () => {
  it("readOrchestration reads auto_add_children and its poll; defaults keep today's behaviour", async () => {
    const { readOrchestration } = await import("../engine-cli.mjs");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "ac-"));
    assert.equal(readOrchestration(d).autoAddChildren, "decomposed");
    assert.equal(readOrchestration(d).autoAddChildrenPollS, 120);
    writeFileSync(join(d, "forge.yaml"), "orchestration:\n  auto_add_children: epic\n  auto_add_children_poll_s: 30\n");
    assert.equal(readOrchestration(d).autoAddChildren, "epic");
    assert.equal(readOrchestration(d).autoAddChildrenPollS, 30);
  });
  it("--resume keeps the mode: the flag is in plan.argv, which a resume re-reads", async () => {
    const { openBatch } = await import("./batch.mjs");
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "acb-"));
    const b = openBatch(root, "b20261101-000000-1");
    b.writePlan({ v: 1, id: b.id, argv: ["1", "--auto-children", "all", "--epic", "9"], repo: "o/r", cwd: root });
    assert.deepEqual(openBatch(root, b.id).readPlan().argv.slice(1, 5), ["--auto-children", "all", "--epic", "9"]);
  });
});
