// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCeilingBySize, ceilingFor, predictRestart, handoffFacts, firstEditTurn, HANDOFF_FILES_MAX, routeHandoff, buildReadsOf, ROUTE_DIGEST_MAX_BYTES } from "./ceiling.mjs";
import { contextRestartPrompt, routeDigestPrompt } from "./prompts.mjs";
import { toolStats } from "./toolstats.mjs";

describe("context ceiling helpers (#5346)", () => {
  it("parseCeilingBySize reads a string or object, ignores junk, null when empty", () => {
    assert.deepEqual(parseCeilingBySize({ context_ceiling_by_size: "S=80000, m=120000;L:0" }), { S: 80000, M: 120000, L: 0 });
    assert.deepEqual(parseCeilingBySize({ context_ceiling_by_size: { L: "160000", X: "5" } }), { L: 160000 });
    assert.equal(parseCeilingBySize({ context_ceiling_by_size: "big" }), null);
    assert.equal(parseCeilingBySize({}), null);
  });
  it("ceilingFor uses the size entry (0 included), else the global ceiling", () => {
    assert.equal(ceilingFor("L", { tokens: 120000, bySize: { L: 160000 } }), 160000);
    assert.equal(ceilingFor("L", { tokens: 120000, bySize: { L: 0 } }), 0);
    assert.equal(ceilingFor("M", { tokens: 120000, bySize: { L: 160000 } }), 120000);
    assert.equal(ceilingFor(null, { tokens: 120000, bySize: { L: 1 } }), 120000);
  });
  it("predictRestart: 60% of the ceiling predicts, named files over the ceiling are certain, off never predicts", () => {
    assert.equal(predictRestart({ ceiling: 100000, promptBytes: 4000, fileBytes: 0 }).predicted, false);
    const near = predictRestart({ ceiling: 100000, promptBytes: 4000, fileBytes: 4 * 59000 });
    assert.deepEqual([near.predicted, near.certain, near.estimate], [true, false, 60000]);
    assert.deepEqual([predictRestart({ ceiling: 100000, fileBytes: 4 * 100001 }).predicted, predictRestart({ ceiling: 100000, fileBytes: 4 * 100001 }).certain], [true, true]);
    assert.equal(predictRestart({ ceiling: 0, fileBytes: 1e9 }).predicted, false);
  });
  it("handoffFacts dedupes, drops read files that were edited, caps the list and keeps the last tool", () => {
    const uses = [{ name: "Read", path: "a" }, { name: "Read", path: "a" }, { name: "Read", path: "b" }, { name: "Edit", path: "b" }, { name: "Bash", cmd: "ls" },
      ...Array.from({ length: 40 }, (_, i) => ({ name: "Read", path: `f${i}` }))];
    const h = handoffFacts(uses, { name: "Edit", input: "x" });
    assert.deepEqual(h.edited, ["b"]);
    assert.equal(h.read.length, HANDOFF_FILES_MAX);
    assert.equal(h.readMore, 11);
    assert.deepEqual(h.last, { name: "Edit", input: "x" });
    assert.deepEqual(handoffFacts(null, null), { read: [], edited: [], readMore: 0, last: null });
  });
  it("firstEditTurn counts distinct assistant messages; toolStats exposes it", () => {
    const uses = [{ msg: "m1", name: "Read", path: "a" }, { msg: "m1", name: "Read", path: "b" }, { msg: "m2", name: "Bash" }, { msg: "m3", name: "Write", path: "c" }];
    assert.equal(firstEditTurn(uses), 3);
    assert.equal(firstEditTurn([{ msg: "m1", name: "Read" }]), null);
    assert.equal(toolStats(uses).first_edit_turn, 3);
    assert.equal("first_edit_turn" in toolStats([{ msg: "m1", name: "Read", path: "a" }]), false);
  });
  it("the restart prompt carries the established block only when there are facts, and keeps its other sections", () => {
    const base = contextRestartPrompt({ stat: "1 file", diff: "d", base: "origin/x", check: "", ceiling: 5 });
    assert.doesNotMatch(base, /<established>/);
    const p = contextRestartPrompt({ stat: "1 file", diff: "d", base: "origin/x", check: "ok", ceiling: 5, established: handoffFacts([{ name: "Read", path: "src/a.js" }], { name: "Read", input: "i" }) });
    assert.match(p, /<established>\nFiles it read[^\n]*\n- src\/a\.js\nIts last tool call: Read i/);
    assert.match(p, /<diff_stat base="origin\/x">/);
    assert.match(p, /Last validate result/);
  });
});

describe("route hand-off (#5812)", () => {
  it("routeHandoff digests a planning session above the bound, capped at half the ceiling; unknown or 0 resumes", () => {
    assert.equal(routeHandoff({ planTokens: 96000, bound: 40000, ceiling: 120000 }).digest, true);
    assert.equal(routeHandoff({ planTokens: 30000, bound: 40000, ceiling: 120000 }).digest, false);
    assert.deepEqual([routeHandoff({ planTokens: 35000, bound: 40000, ceiling: 60000 }).digest, routeHandoff({ planTokens: 35000, bound: 40000, ceiling: 60000 }).bound], [true, 30000]);
    assert.equal(routeHandoff({ planTokens: null, bound: 40000, ceiling: 120000 }).digest, false);
    assert.equal(routeHandoff({ planTokens: 500000, bound: 0, ceiling: 120000 }).digest, false);
    assert.equal(routeHandoff({ planTokens: 96000, bound: 40000 }).digestBytes, ROUTE_DIGEST_MAX_BYTES);
    assert.equal(routeHandoff({ planTokens: 96000, bound: 10000 }).digestBytes, 10000);
  });
  it("buildReadsOf takes the plan reply's last Build reads list", () => {
    assert.equal(buildReadsOf("x\nBuild reads: a.js:1-9\n- grep foo"), "a.js:1-9\n- grep foo");
    assert.equal(buildReadsOf("no list"), "");
    assert.equal(buildReadsOf(null), "");
  });
  it("routeDigestPrompt carries deliverables, decisions, open rows and reads, and stays within maxBytes", () => {
    const contract = { requirements: [{ id: "R1", quote: "do it", disposition: "deliver" }, { id: "R2", quote: "later", disposition: "defer" }],
      deliverables: [{ id: "D1", path: "src/a.js", change: "fix" }], decisions: [{ id: "K1", choice: "reuse b", justification: "b.js:3" }] };
    const p = routeDigestPrompt({ contract, read: ["src/b.js", "src/b.js"], buildReads: "src/a.js:1-5", planTokens: 96000 });
    assert.match(p, /Deliverables:\n- src\/a\.js: fix/);
    assert.match(p, /Decisions:\n- K1 reuse b \(b\.js:3\)/);
    assert.match(p, /Open \(not delivered in this lane; do not implement\):\n- R2 defer: later/);
    assert.doesNotMatch(p, /R1 deliver/);
    assert.equal(p.match(/- src\/b\.js/g).length, 1, "reads deduped");
    assert.doesNotMatch(p, /Branch state/, "no branch section without changes");
    const huge = routeDigestPrompt({ contract, read: Array.from({ length: 500 }, (_, i) => `src/${"x".repeat(80)}${i}.js`), stat: "a | 1", diff: "d".repeat(200000), maxBytes: 4096 });
    assert.ok(Buffer.byteLength(huge) <= 4096, `digest is ${Buffer.byteLength(huge)} bytes`);
    assert.match(huge, /<\/route_digest>$/);
  });
});
