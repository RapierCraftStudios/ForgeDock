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
  it("readAutoChildren reads auto_add_children and its poll; defaults keep today's behaviour", async () => {
    const { readAutoChildren } = await import("../engine-cli.mjs");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "ac-"));
    assert.equal(readAutoChildren(d).mode, "decomposed");
    assert.equal(readAutoChildren(d).pollS, 120);
    writeFileSync(join(d, "forge.yaml"), "orchestration:\n  auto_add_children: epic\n  auto_add_children_poll_s: 30\n");
    assert.equal(readAutoChildren(d).mode, "epic");
    assert.equal(readAutoChildren(d).pollS, 30);
  });
  it("--resume keeps the mode: a resumed batch whose plan carries --auto-children epic --epic 9 adds #9's children", async () => {
    const { openBatch } = await import("./batch.mjs");
    const { orchestrateFromCli } = await import("../engine-cli.mjs");
    const fs = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    process.env.FORGEDOCK_SCHED_DIR = fs.mkdtempSync(join(tmpdir(), "ac-sched-"));
    const work = fs.mkdtempSync(join(tmpdir(), "acb-")), root = join(work, "batches"), launches = join(work, "launches");
    fs.writeFileSync(launches, "");
    const stub = join(work, "stub.mjs");
    fs.writeFileSync(stub, `import { appendFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2); const rf = a[a.indexOf("--result-file") + 1];
appendFileSync(${JSON.stringify(launches)}, a[1] + "\\n"); writeFileSync(rf, JSON.stringify({ terminalReason: "merged", pr: 100 + Number(a[1]), cost_usd: 0 }));
`);
    const b = openBatch(root, "b20261101-000000-1");
    b.writePlan({ v: 1, id: b.id, argv: ["1", "--repo", "o/r", "--no-prefilter", "--auto-children", "epic", "--epic", "9"], repo: "o/r", cwd: process.cwd(), created: new Date().toISOString() });
    b.setParallel(2);
    const lists = [];
    const gh = async (a) => {
      if (a[0] === "issue" && a[1] === "list" && a.includes("--state") && a.includes("number,body,labels,parent,subIssues")) { lists.push(a); return JSON.stringify([{ number: 9, body: "", labels: [] }, { number: 51, body: "**Parent**: #9", labels: [] }]); }
      if (a.includes("milestone")) return JSON.stringify({ milestone: null });
      if (a[0] === "repo") return "main\n";
      return JSON.stringify({ body: "", state: "OPEN", labels: [] });
    };
    const deps = { batchRoot: root, allowTmpfs: true, laneScript: stub, pollMs: 20, orchestration: { breaker: null, maxDeferrals: 3 }, io: { gh: async () => "o/r\n" },
      leanIo: { gh, git: async (a) => (a[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : "") } };
    const l = console.log; console.log = () => {};
    let res;
    try { res = await orchestrateFromCli(["--resume", b.id], deps); } finally { console.log = l; }
    assert.ok(lists.length >= 1, "the child list was read: the epic mode survived the resume");
    assert.deepEqual(res.rows.map((r) => r.issue).sort((x, y) => x - y), [1, 51]);
  });
});
