// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveLightContract, runLightStep, parseNumstat, apiShapeReasons, upgradeNote, lightBuildPrompt, renderLiteReceipt } from "./lightlane.mjs";
import { validateContract } from "./conformance.mjs";

const TITLE = "foo crashes on null input";
const ISSUE = `${TITLE}\n\nfoo crashes on null input in src/foo.js.\n\n- foo must handle a null argument without throwing.\n- Existing callers of foo keep working.`;
const RT = { path: "test/foo.test.js", id: "foo handles null", command: "node --test test/foo.test.js" };
const RESULT = { status: "fixed", summary: "guard null", requirement: "foo must handle a null argument without throwing.", repro_test: RT, tests: [{ command: "node --test test/foo.test.js", result: "pass" }, { command: "node --test test/bar.test.js", result: "pass" }] };
const FILES = ["src/foo.js", "test/foo.test.js"];
const validate = (c) => validateContract(c, ISSUE, { repro: true });

describe("deriveLightContract (#4450)", () => {
  it("quotes the builder's verbatim sentence, delivers the changed non-test files, validates the repro and the targeted tests", () => {
    const c = deriveLightContract({ title: TITLE, issueText: ISSUE, result: RESULT, files: [...FILES, ".forge-lean/result.json"] });
    assert.deepEqual(c.requirements, [{ id: "R1", quote: "foo must handle a null argument without throwing.", disposition: "deliver" }]);
    assert.deepEqual(c.deliverables.map((d) => d.path), ["src/foo.js"]);
    assert.deepEqual(c.validate, [{ id: "V1", command: "node --test test/foo.test.js" }, { id: "V2", command: "node --test test/bar.test.js" }]);
    assert.deepEqual(c.repro_test, RT);
    assert.equal(validate(c).ok, true, validate(c).problems.join("; "));
  });
  it("a sentence that is not in the issue falls back to the title; no repro test is repro_test none with a reason", () => {
    const c = deriveLightContract({ title: TITLE, issueText: ISSUE, result: { ...RESULT, requirement: "make foo better in every way possible", repro_test: undefined }, files: FILES });
    assert.equal(c.requirements[0].quote, TITLE);
    assert.equal(c.repro_test, "none");
    assert.ok(c.repro_test_reason);
    assert.deepEqual(c.validate.map((v) => v.command), ["node --test test/foo.test.js", "node --test test/bar.test.js"]);
  });
  it("a test-only diff has no deliverable, so the derived contract is invalid", () => {
    const c = deriveLightContract({ title: TITLE, issueText: ISSUE, result: RESULT, files: ["test/foo.test.js"] });
    assert.equal(validate(c).ok, false);
  });
});

describe("parseNumstat / apiShapeReasons / upgradeNote", () => {
  it("numstat rows, binary as 0, renames to the new path, the engine dir skipped", () => {
    assert.deepEqual(parseNumstat("3\t1\tsrc/foo.js\n-\t-\timg.png\n2\t0\tsrc/{a.js => b.js}\n1\t1\told.js => new.js\n4\t0\t.forge-lean/result.json\n").files, [
      { path: "src/foo.js", added: 3, deleted: 1 }, { path: "img.png", added: 0, deleted: 0 }, { path: "src/b.js", added: 2, deleted: 0 }, { path: "new.js", added: 1, deleted: 1 }]);
  });
  it("none is no reason; changes and unknown files are reasons; a missing result is unknown", () => {
    assert.deepEqual(apiShapeReasons({ status: "none", changes: [], unknown: [] }), []);
    assert.deepEqual(apiShapeReasons({ status: "changed", changes: [{ file: "a.py", symbol: "ichunked", change: "generator-function" }], unknown: [] }), ["a.py: ichunked generator-function"]);
    assert.deepEqual(apiShapeReasons({ status: "unknown", changes: [], unknown: [{ file: "x.go", lang: "go", reason: "unsupported-language" }] }), ["x.go: unknown (go), unsupported-language"]);
    assert.equal(apiShapeReasons(null).length, 1);
  });
  it("the upgrade note lists the reasons, escapes markup and is empty without reasons", () => {
    assert.equal(upgradeNote([]), "");
    const n = upgradeNote([{ code: "diff_lines", detail: "90 non-test lines (max 40) <!-- x -->" }]);
    assert.match(n, /Light-lane upgrade/);
    assert.match(n, /- diff_lines: 90 non-test lines \(max 40\)/);
    assert.ok(!n.includes("<!--"));
  });
  it("the light prompt asks for test first, fix, targeted tests and the derivation fields", () => {
    const p = lightBuildPrompt(7);
    assert.match(p, /failing regression test first/);
    assert.match(p, /"requirement":/);
    assert.match(p, /"repro_test":/);
    assert.match(p, /"status":"upgrade"/);
    assert.match(p, /Host rules/);
  });
});

/** A light step whose effects are fakes; `o` overrides any of them. */
function step(o = {}) {
  const calls = { build: 0, fix: 0, tests: 0, checkpoint: 0 };
  const ctx = {
    title: TITLE, issueText: ISSUE, riskPaths: [], cfg: { mode: "on" }, validate,
    build: async () => { calls.build++; },
    readResult: async () => o.result ?? RESULT,
    checkpoint: async () => { calls.checkpoint++; },
    changedFiles: async () => o.files ?? FILES,
    numstat: async () => o.numstat ?? "5\t1\tsrc/foo.js\n20\t0\ttest/foo.test.js\n",
    runTests: async (cmds) => { calls.tests++; const rc = (o.testRcs ?? [])[calls.tests - 1] ?? 0; return cmds.map((command) => ({ command, rc, output: rc ? "not ok 1" : "" })); },
    fixTests: async () => { calls.fix++; },
    reproOf: async () => o.repro ?? { base: "FAILED", head: "RAN" },
    apiShape: async () => (o.api === undefined ? { status: "none", changes: [], unknown: [] } : o.api),
    ...(o.ctx ?? {}),
  };
  return { ctx, calls };
}
const codes = (r) => r.reasons.map((x) => x.code);

describe("runLightStep (#4450)", () => {
  it("nothing triggers: one build, the derived contract, no fix round", async () => {
    const { ctx, calls } = step();
    const r = await runLightStep(ctx);
    assert.equal(r.upgrade, false, JSON.stringify(r.reasons));
    assert.equal(calls.build, 1); assert.equal(calls.fix, 0); assert.equal(calls.checkpoint, 1);
    assert.deepEqual(r.contract.deliverables.map((d) => d.path), ["src/foo.js"]);
  });
  const cases = [
    ["diff_lines", { numstat: "60\t0\tsrc/foo.js\n" }],
    ["diff_files", { numstat: "1\t0\tsrc/a.js\n1\t0\tsrc/b.js\n1\t0\tsrc/c.js\n", files: ["src/a.js", "src/b.js", "src/c.js", "test/foo.test.js"] }],
    ["repro_not_red", { repro: { base: "PASSED", head: "RAN" } }],
    ["tests_failed_twice", { testRcs: [1, 1] }],
    ["risk_path", { numstat: "1\t0\tsrc/auth/login.js\n", files: ["src/auth/login.js", "test/foo.test.js"] }],
    ["api_shape", { api: { status: "changed", changes: [{ file: "src/foo.js", symbol: "foo", change: "signature" }], unknown: [] } }],
    ["api_shape", { api: null }],
    ["not_fixed", { result: { status: "upgrade", summary: "too big" } }],
    ["no_commit", { files: [] }],
    ["contract_invalid", { files: ["test/foo.test.js"], numstat: "3\t0\ttest/foo.test.js\n" }],
    ["light_error", { ctx: { numstat: async () => { throw new Error("git broke"); } } }],
  ];
  for (const [code, o] of cases) {
    it(`upgrades on ${code}${o.api === null ? " (no detector result)" : ""}`, async () => {
      const r = await runLightStep(step(o).ctx);
      assert.equal(r.upgrade, true);
      assert.ok(codes(r).includes(code), codes(r).join(","));
      assert.equal(r.contract, null);
    });
  }
  it("one failed test run gets one fix round and stays light when the rerun passes", async () => {
    const { ctx, calls } = step({ testRcs: [1, 0] });
    const r = await runLightStep(ctx);
    assert.equal(r.upgrade, false); assert.equal(calls.fix, 1); assert.equal(r.testFailures, 1);
  });
});

describe("renderLiteReceipt (#4452)", () => {
  const ELIG = { mode: "on", verdict: "eligible", eligible: true, light: true, reasons: [] };

  it("renders diff stat, red/green result, gates, true cost and eligibility reason for a light lane", async () => {
    const r = await runLightStep(step().ctx);
    const body = renderLiteReceipt({ lr: r, eligibility: ELIG, costUsd: 0.4321, contractHash: "c0ffee12" });
    assert.match(body, /^## Light lane receipt/);
    assert.match(body, /\*\*Outcome:\*\* light/);
    assert.match(body, /\*\*Diff:\*\* 2 file\(s\), \+25\/-1 \(non-test: 1 file\(s\), 6 line\(s\)\)/);
    assert.match(body, /\*\*Red\/green:\*\* base FAILED → head RAN \(red on base\)/);
    assert.match(body, /\*\*Gates:\*\*\n  - targeted tests: 2 command\(s\), passed/);
    assert.match(body, /`node --test test\/foo\.test\.js`/);
    assert.match(body, /API shape: unchanged/);
    assert.match(body, /contract: derived, valid \(`c0ffee12`\)/);
    assert.match(body, /\*\*Cost:\*\* \$0\.4321 \(true per-session cost, #4407 deltas\)/);
    assert.match(body, /\*\*Eligibility:\*\* eligible \(mode on\): repro or expected behaviour/);
    assert.ok(!/Upgrade reasons/.test(body));
    assert.ok(!/<!--|undefined|NaN/.test(body), body);
  });

  it("an upgraded lane lists the gates that fired and the upgrade reasons; free text is sanitised", async () => {
    const api = { status: "changed", changes: [{ file: "src/foo.js", symbol: "foo", change: "sync-async" }], unknown: [] };
    const r = await runLightStep(step({ api, testRcs: [1, 1], repro: { base: "PASSED", head: "RAN" } }).ctx);
    assert.equal(r.upgrade, true);
    const elig = { mode: "on", verdict: "eligible", reasons: [{ code: "no_repro", detail: "x <!-- y --> <b>" }] };
    const body = renderLiteReceipt({ lr: r, eligibility: elig, costUsd: 1.5 });
    assert.match(body, /^## Light lane upgraded to the full lane/);
    assert.match(body, /\*\*Outcome:\*\* upgraded/);
    assert.match(body, /base PASSED → head RAN \(not red on base\)/);
    assert.match(body, /targeted tests: 2 command\(s\), failed twice/);
    assert.match(body, /API shape: 1 change\(s\)\/unknown\n {4}- src\/foo\.js: foo sync-async/);
    assert.match(body, /contract: not derived \(upgraded\)/);
    assert.match(body, /\*\*Upgrade reasons:\*\*[\s\S]*- api_shape: [\s\S]*- repro_not_red: [\s\S]*- tests_failed_twice: /);
    assert.match(body, /- no_repro: x y &lt;b>/);
    assert.ok(!/<!--|-->/.test(body));
  });

  it("an early upgrade (no commit) renders n/a, never undefined", async () => {
    const r = await runLightStep(step({ files: [] }).ctx);
    const body = renderLiteReceipt({ lr: r, eligibility: null, costUsd: null });
    assert.match(body, /\*\*Diff:\*\* n\/a/);
    assert.match(body, /\*\*Red\/green:\*\* n\/a/);
    assert.match(body, /targeted tests: not run/);
    assert.match(body, /API shape: not checked/);
    assert.match(body, /\*\*Cost:\*\* n\/a/);
    assert.match(body, /- no_commit: /);
    assert.ok(!/undefined|NaN/.test(body), body);
  });

  it("runLightStep returns the receipt inputs alongside its #4450 fields", async () => {
    const r = await runLightStep(step().ctx);
    assert.deepEqual(r.diff, { files: [{ path: "src/foo.js", added: 5, deleted: 1 }, { path: "test/foo.test.js", added: 20, deleted: 0 }] });
    assert.deepEqual(r.apiShape, []);
    assert.deepEqual(r.testCommands, ["node --test test/foo.test.js", "node --test test/bar.test.js"]);
    assert.equal(r.testRuns, 2);
    for (const k of ["upgrade", "reasons", "contract", "files", "repro", "testFailures"]) assert.ok(k in r, k);
  });
});
