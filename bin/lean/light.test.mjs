// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { LIGHT_MODES, LIGHT_DEFAULTS, parseLightConfig, lightEligibility, upgradeTriggers } from "./light.mjs";
import { readLight } from "../engine-cli.mjs";

const ON = { mode: "on", maxLines: 40, maxFiles: 2 };
const BODY = "## Steps to reproduce\n```js\nchunk([1, 2], 0)\n```\nExpected behaviour: a ValueError.";
/** A fully eligible issue; override one field to break one rule. */
const issue = (o = {}) => ({ title: "fix(chunk): reject n=0", body: BODY, labels: ["bug", "size:S"], predictedFiles: ["src/chunk.py", "tests/test_chunk.py"], riskPaths: [], cfg: ON, ...o });
const codes = (r) => r.reasons.map((x) => x.code);
const numstat = (...rows) => ({ files: rows.map(([path, added, deleted = 0]) => ({ path, added, deleted })) });
const RED = { base: "FAILED", head: "RAN" };

describe("parseLightConfig (#4448)", () => {
  it("defaults to shadow, 40 lines, 2 files", () => {
    assert.deepEqual(LIGHT_MODES, ["off", "shadow", "on"]);
    assert.deepEqual(parseLightConfig(), LIGHT_DEFAULTS);
    assert.deepEqual(parseLightConfig(null), { mode: "shadow", maxLines: 40, maxFiles: 2 });
  });
  it("reads the flattened nested keys; flat light_* keys win; junk keeps the default", () => {
    assert.deepEqual(parseLightConfig({ mode: "ON", max_lines: "60", max_files: "3" }), { mode: "on", maxLines: 60, maxFiles: 3 });
    assert.deepEqual(parseLightConfig({ mode: "on", light_mode: "off", max_lines: "60", light_max_lines: "80", light_max_files: "1" }), { mode: "off", maxLines: 80, maxFiles: 1 });
    assert.deepEqual(parseLightConfig({ mode: "enforce", max_lines: "0", max_files: "-1" }), LIGHT_DEFAULTS);
    assert.deepEqual(parseLightConfig({ light_max_lines: "4x" }), LIGHT_DEFAULTS);
  });
  it("readLight reads forge.yaml lean.light; absent forge.yaml is the defaults", () => {
    const d = tmpDir("light-yaml-");
    assert.deepEqual(readLight(d), LIGHT_DEFAULTS);
    writeFileSync(join(d, "forge.yaml"), "lean:\n  light:\n    mode: on\n    max_lines: 50\n    max_files: 3\n");
    assert.deepEqual(readLight(d), { mode: "on", maxLines: 50, maxFiles: 3 });
    writeFileSync(join(d, "forge.yaml"), "lean:\n  light_mode: off\n");
    assert.equal(readLight(d).mode, "off");
  });
});

describe("lightEligibility rules (#4448)", () => {
  it("accepts a well-specified size:S issue with 1-2 predicted files", () => {
    const r = lightEligibility(issue());
    assert.deepEqual(r, { mode: "on", verdict: "eligible", eligible: true, light: true, reasons: [] });
  });
  it("repro or expected behaviour: present accepts, absent is ambiguous (never a model call)", () => {
    for (const body of ["Repro: `x()` throws", "Expected result: 3", "```\nboom\n```", "actual output differs"]) assert.equal(lightEligibility(issue({ body })).verdict, "eligible", body);
    const r = lightEligibility(issue({ body: "It is broken. <!-- steps to reproduce -->" }));
    assert.equal(r.verdict, "ambiguous");
    assert.equal(r.eligible, false);
    assert.equal(r.light, false);
    assert.deepEqual(codes(r), ["no_repro"]);
  });
  it("predicted files: 1 or 2 non-test files accept, 3 reject, tests do not count, none is ambiguous", () => {
    assert.equal(lightEligibility(issue({ predictedFiles: ["src/a.py"] })).verdict, "eligible");
    assert.equal(lightEligibility(issue({ predictedFiles: ["src/a.py", "src/b.py", "tests/test_a.py", "src/c.test.ts"] })).verdict, "eligible");
    const r = lightEligibility(issue({ predictedFiles: ["src/a.py", "src/b.py", "src/c.py"] }));
    assert.equal(r.verdict, "ineligible");
    assert.deepEqual(codes(r), ["files"]);
    assert.deepEqual(codes(lightEligibility(issue({ predictedFiles: [] }))), ["files_unknown"]);
    assert.equal(lightEligibility(issue({ predictedFiles: ["tests/test_a.py"] })).verdict, "ambiguous");
    assert.equal(lightEligibility(issue({ predictedFiles: ["src/a.py", "src/b.py", "src/c.py"], cfg: { ...ON, maxFiles: 3 } })).verdict, "eligible");
  });
  it("size: size:S accepts, size:M and size:L reject", () => {
    assert.equal(lightEligibility(issue({ labels: [{ name: "size:S" }] })).verdict, "eligible");
    assert.equal(lightEligibility(issue({ labels: [] })).verdict, "eligible");
    for (const s of ["size:M", "size:L"]) {
      const r = lightEligibility(issue({ labels: ["bug", s] }));
      assert.equal(r.verdict, "ineligible", s);
      assert.deepEqual(codes(r), ["size"]);
    }
  });
  it("risk path: a built-in risk word or a declared review.risk_paths glob rejects; a clean path accepts", () => {
    const w = lightEligibility(issue({ predictedFiles: ["src/auth/login.ts"] }));
    assert.deepEqual(codes(w), ["risk_path"]);
    assert.match(w.reasons[0].detail, /src\/auth\/login\.ts \(auth\)/);
    const g = lightEligibility(issue({ predictedFiles: ["src/detect/rules.ts"], riskPaths: "src/detect/**" }));
    assert.deepEqual(codes(g), ["risk_path"]);
    assert.match(g.reasons[0].detail, /review\.risk_paths/);
    assert.equal(lightEligibility(issue({ predictedFiles: ["src/chunk.py"], riskPaths: ["src/detect/**"] })).verdict, "eligible");
  });
  it("kind: investigate(, post-deploy and decision issues reject; a plain bug accepts", () => {
    assert.deepEqual(codes(lightEligibility(issue({ title: "investigate(lean): why lanes stall" }))), ["investigate"]);
    assert.deepEqual(codes(lightEligibility(issue({ labels: ["awaiting-promotion"] }))), ["post_deploy"]);
    assert.deepEqual(codes(lightEligibility(issue({ labels: ["post-deploy"] }))), ["post_deploy"]);
    const pd = "Post-deploy checks.\n```\nx\n```\n- [ ] `R3: verify in prod` — post-deploy: needs a deploy\n";
    assert.deepEqual(codes(lightEligibility(issue({ body: pd }))), ["post_deploy"]);
    for (const labels of [["decision"], ["needs-decision"], ["type:decision"], ["product-decision"], ["RFC"], ["adr"]]) assert.deepEqual(codes(lightEligibility(issue({ labels }))), ["decision"], labels[0]);
    for (const title of ["decision(lean): pick a queue", "RFC: light lanes", "adr(engine): leases"]) assert.deepEqual(codes(lightEligibility(issue({ title }))), ["decision"], title);
    assert.equal(lightEligibility(issue({ title: "fix: decision table off by one", labels: ["bug"] })).verdict, "eligible");
  });
  it("hard reasons win over soft ones; reasons are sorted and deterministic", () => {
    const o = issue({ body: "broken", labels: ["size:L", "decision"], predictedFiles: ["src/billing.ts", "a.py", "b.py"] });
    const r = lightEligibility(o);
    assert.equal(r.verdict, "ineligible");
    assert.deepEqual(codes(r), ["decision", "files", "no_repro", "risk_path", "size"]);
    assert.deepEqual(lightEligibility({ ...o, predictedFiles: [...o.predictedFiles].reverse() }), r);
  });
  it("tolerates missing and junk input", () => {
    assert.equal(lightEligibility().verdict, "ambiguous");
    assert.doesNotThrow(() => lightEligibility({ title: null, body: null, labels: "x", predictedFiles: "y", riskPaths: 3, cfg: null }));
  });
});

describe("lightEligibility modes (#4448)", () => {
  it("off never returns eligible, even for a fully eligible issue", () => {
    assert.deepEqual(lightEligibility(issue({ cfg: { mode: "off" } })), { mode: "off", verdict: "off", eligible: false, light: false, reasons: [] });
  });
  it("shadow returns the verdict without changing the lane shape", () => {
    const r = lightEligibility(issue({ cfg: { mode: "shadow" } }));
    assert.equal(r.verdict, "eligible");
    assert.equal(r.eligible, true);
    assert.equal(r.light, false);
    assert.equal(lightEligibility(issue({ cfg: {} })).mode, "shadow", "default mode");
    assert.equal(lightEligibility(issue({ cfg: { mode: "shadow" }, labels: ["size:M"] })).verdict, "ineligible");
  });
  it("on runs an eligible issue light and never an ineligible one", () => {
    assert.equal(lightEligibility(issue()).light, true);
    assert.equal(lightEligibility(issue({ labels: ["size:M"] })).light, false);
    assert.equal(lightEligibility(issue({ body: "broken" })).light, false);
  });
});

describe("upgradeTriggers (#4448)", () => {
  const quiet = { diff: numstat(["src/chunk.py", 30, 10], ["tests/test_chunk.py", 200]), repro: RED, testFailures: 1, cfg: ON };
  it("no trigger on a small red-green diff", () => {
    assert.deepEqual(upgradeTriggers(quiet), { upgrade: false, reasons: [] });
  });
  it("oversized diff by lines: 41 non-test lines fire, 40 do not, test lines are ignored, max_lines is honoured", () => {
    const r = upgradeTriggers({ ...quiet, diff: numstat(["src/chunk.py", 31, 10], ["tests/test_chunk.py", 500]) });
    assert.equal(r.upgrade, true);
    assert.deepEqual(codes(r), ["diff_lines"]);
    assert.match(r.reasons[0].detail, /41 non-test lines \(max 40\)/);
    assert.equal(upgradeTriggers({ ...quiet, diff: numstat(["src/a.py", 41], ["src/b.py", "-", "-"]), cfg: { ...ON, maxLines: 41 } }).upgrade, false);
  });
  it("oversized diff by files: 3 non-test files fire, 2 do not", () => {
    assert.deepEqual(codes(upgradeTriggers({ ...quiet, diff: numstat(["src/a.py", 1], ["src/b.py", 1], ["src/c.py", 1]) })), ["diff_files"]);
    assert.equal(upgradeTriggers({ ...quiet, diff: numstat(["src/a.py", 1], ["src/b.py", 1], ["tests/test_a.py", 1]) }).upgrade, false);
  });
  it("non-red repro: anything but FAILED on base fires, a missing repro included", () => {
    for (const base of ["RAN", "RAN_NOTHING", "UNRUNNABLE", "SKIPPED"]) assert.deepEqual(codes(upgradeTriggers({ ...quiet, repro: { base, head: "RAN" } })), ["repro_not_red"], base);
    assert.deepEqual(codes(upgradeTriggers({ ...quiet, repro: null })), ["repro_not_red"]);
    assert.equal(upgradeTriggers({ ...quiet, repro: RED }).upgrade, false);
  });
  it("tests fail twice: 2 failures fire, 1 does not", () => {
    assert.deepEqual(codes(upgradeTriggers({ ...quiet, testFailures: 2 })), ["tests_failed_twice"]);
    assert.equal(upgradeTriggers({ ...quiet, testFailures: 1 }).upgrade, false);
  });
  it("risk path: a risk word or declared glob on any diff path fires, tests included; a clean diff does not", () => {
    assert.deepEqual(codes(upgradeTriggers({ ...quiet, diff: numstat(["src/session.ts", 2]) })), ["risk_path"]);
    assert.deepEqual(codes(upgradeTriggers({ ...quiet, diff: numstat(["src/a.py", 2], ["tests/test_payments.py", 2]) })), ["risk_path"]);
    assert.deepEqual(codes(upgradeTriggers({ ...quiet, diff: numstat(["lib/detect.py", 2]), riskPaths: "lib/detect.py" })), ["risk_path"]);
    assert.equal(upgradeTriggers({ ...quiet, riskPaths: ["lib/**"] }).upgrade, false);
  });
  it("public-API-shape changes (#4449) plug in as one more input", () => {
    const r = upgradeTriggers({ ...quiet, apiShape: ["ichunked: generator -> function", { symbol: "chunk", kind: "signature" }, "", null] });
    assert.deepEqual(r.reasons, [{ code: "api_shape", detail: "chunk: signature" }, { code: "api_shape", detail: "ichunked: generator -> function" }]);
  });
  it("reasons are sorted and deterministic; junk input does not throw", () => {
    const o = { diff: numstat(["src/z.py", 30], ["src/auth.py", 30], ["src/m.py", 1]), repro: null, testFailures: 3, cfg: ON };
    const r = upgradeTriggers(o);
    assert.deepEqual(codes(r), ["diff_files", "diff_lines", "repro_not_red", "risk_path", "tests_failed_twice"]);
    assert.deepEqual(upgradeTriggers({ ...o, diff: { files: [...o.diff.files].reverse() } }), r);
    assert.doesNotThrow(() => upgradeTriggers({ diff: { files: [null, { path: "" }, { path: 3, added: "x" }] }, testFailures: "nan", apiShape: "x", cfg: null }));
  });
});

describe("light.mjs purity (#4448)", () => {
  it("imports no filesystem, process or network module", () => {
    const src = readFileSync(new URL("./light.mjs", import.meta.url), "utf8");
    for (const m of ["node:fs", "node:child_process", "node:net", "node:http", "node:https"]) assert.equal(src.includes(`"${m}"`), false, m);
  });
});
