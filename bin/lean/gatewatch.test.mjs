import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectGateDeadlock, formatGateDeadlock } from "./gatewatch.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { classifyNeedsHuman, classifyLegacyNeedsHuman, parkedLabel } from "../engine/outcome-codes.mjs";

describe("#4656 gate watchdog", () => {
  it("a milestone ship gate waiting on a parked issue yields GATE_DEADLOCK with issue, gate and age", () => {
    const firstSeen = new Map([["ship#7", 0]]);
    const d = detectGateDeadlock({ gates: [{ name: "ship", waitsOn: [7, 8] }], admissible: (n) => n !== 7, now: 120000, firstSeen });
    assert.deepEqual(d, [{ issue: 7, gate: "ship", ageMs: 120000 }]);
    assert.equal(formatGateDeadlock(d[0]), "GATE_DEADLOCK issue=#7 gate=ship age=2m");
  });
  it("an admissible wait is not a deadlock", () => {
    assert.deepEqual(detectGateDeadlock({ gates: [{ name: "ship", waitsOn: [8] }], admissible: () => true }), []);
  });
  it("the batch runner reports GATE_DEADLOCK once per (gate, issue) for a parked issue on the gate, instead of waiting", async () => {
    const rows = [], decisions = [];
    const runOne = async (n) => n === 1
      ? { terminalReason: "needs-human", code: "conformance.unimplemented", detail: "unknown requirement", pr: 9 }
      : { terminalReason: "merged", pr: 10 };
    const _unused = async (n) => n === 1
      ? { terminalReason: "needs-human", code: "ci.red", detail: "lint failed", pr: 9 }
      : { terminalReason: "merged", pr: 10 };
    const relabels = [];
    const res = await orchestrate({ issues: [1, 2], parallel: 1, runOne, readBody: async () => "", onUpdate: (r) => rows.push(r), decide: (d) => decisions.push(d),
      getGates: () => [{ name: "ship", waitsOn: [1] }], recovery: { maxAttempts: 1 }, relabelNeedsHuman: async (a) => { relabels.push(a); return true; }, pollMs: 1, sleep: async () => {} });
    const dl = rows.filter((r) => r.outcome === "GATE_DEADLOCK");
    assert.equal(dl.length, 1);
    assert.match(dl[0].detail, /GATE_DEADLOCK issue=#1 gate=ship/);
    assert.ok(Array.isArray(res));
    assert.deepEqual(relabels.map((r) => r.parked?.code), ["conformance.unimplemented"]);
  });
});

describe("#4656 parked class and migration", () => {
  it("parked is opt-in and leaves the default classes untouched", () => {
    const row = { outcome: "needs-human", code: "conformance.unimplemented" };
    assert.equal(classifyNeedsHuman(row), "terminal");
    assert.equal(classifyNeedsHuman(row, { parked: true }), "parked");
    assert.equal(classifyNeedsHuman({ outcome: "needs-human", code: "builder.blocked" }, { parked: true }), "human");
    assert.equal(classifyNeedsHuman({ outcome: "needs-human", code: "ci.red" }, { parked: true }), "recoverable");
    assert.equal(classifyNeedsHuman({ outcome: "needs-human" }, { parked: true }), "terminal");
  });
  it("legacy needs-human classifies from the terminal annotation and defaults to external", () => {
    assert.deepEqual(classifyLegacyNeedsHuman("terminal: ci.red after final round"), { kind: "parked", code: "ci.red" });
    assert.deepEqual(classifyLegacyNeedsHuman("waiting for the AWS account"), { kind: "external" });
    assert.deepEqual(classifyLegacyNeedsHuman(null), { kind: "external" });
    assert.equal(parkedLabel("ci.red"), "parked:ci.red");
  });
});

describe("#4656 report routing", () => {
  it("a parked row past recovery is listed on the remediation queue line, not unrecovered or escalations", async () => {
    const { formatOutcomeLists } = await import("./orchestrate.mjs");
    const lines = formatOutcomeLists([{ issue: 1, outcome: "needs-human", code: "conformance.unimplemented", pr: 9, parkedQueued: true }]);
    assert.deepEqual(lines, ["remediation queue (/work-on:remediate): #1 (parked:conformance.unimplemented PR #9)"]);
  });
});
