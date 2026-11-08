// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeRelaxations, relaxationFailures, relaxationBlock, isRelaxationTestPath } from "./relaxation.mjs";
import { reviewerPrompt } from "./prompts.mjs";
import { verifierPrompt } from "./verifier.mjs";

const hunk = (file, lines, start = 10) => `diff --git a/${file} b/${file}\n@@ -1,0 +${start},${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
const removal = (file, lines) => `diff --git a/${file} b/${file}\n@@ -3,${lines.length} +3,0 @@\n${lines.map((l) => `-${l}`).join("\n")}\n`;
// modelled on AlterLab #39954: a "thin stub" rescue whose script_redirect class accepts JS cookie challenges
const RESCUE = hunk("shared/detection/antibot.py", ["def thin_stub_rescue(html):", "    if SCRIPT_REDIRECT.search(html):  # document.cookie=...; location.href=...", "        return True"]);
const NEG = hunk("tests/test_antibot.py", ["def test_cookie_challenge_not_benign():", "    assert not thin_stub_rescue(COOKIE_CHALLENGE)"]);
const GLOBS = ["shared/detection/**"];

describe("#5237 relaxation detector", () => {
  it("replay of #39954: the cookie-challenge acceptance is flagged and blocks without a negative test", () => {
    const a = analyzeRelaxations({ diff: RESCUE, riskPaths: GLOBS });
    assert.ok(a.relaxations.length >= 1);
    assert.equal(a.relaxations[0].file, "shared/detection/antibot.py");
    assert.ok(a.relaxations.some((r) => /return True/.test(r.excerpt)));
    const f = relaxationFailures(a);
    assert.equal(f.length, 1); assert.equal(f[0].code, "conformance.unimplemented"); assert.equal(f[0].kind, "relaxation_untested");
  });
  it("a positive-only test does not satisfy the requirement; a negative test does", () => {
    const pos = hunk("tests/test_antibot.py", ["def test_thin_page_ok():", "    assert thin_stub_rescue(THIN_PAGE) is True"]);
    assert.equal(relaxationFailures(analyzeRelaxations({ diff: RESCUE + pos, riskPaths: GLOBS })).length, 1);
    const a = analyzeRelaxations({ diff: RESCUE + NEG, riskPaths: GLOBS });
    assert.ok(a.negatives >= 1); assert.deepEqual(relaxationFailures(a), []);
  });
  it("a removed deny is a relaxation", () => {
    const a = analyzeRelaxations({ diff: removal("shared/detection/rules.py", ["    if challenge(html):", "        raise Blocked()"]), riskPaths: GLOBS });
    assert.deepEqual(a.relaxations.map((r) => r.class), ["deny_removed"]);
  });
  it("ignores files outside the declared globs, test files, comments, and an empty glob list", () => {
    assert.deepEqual(analyzeRelaxations({ diff: RESCUE, riskPaths: ["billing/**"] }).relaxations, []);
    assert.deepEqual(analyzeRelaxations({ diff: RESCUE, riskPaths: [] }).relaxations, []);
    assert.deepEqual(analyzeRelaxations({ diff: hunk("shared/detection/x.py", ["# return True when benign"]), riskPaths: GLOBS }).relaxations, []);
    assert.deepEqual(analyzeRelaxations({ diff: hunk("shared/detection/test_x.py", ["    return True"]), riskPaths: GLOBS }).relaxations, []);
    assert.ok(isRelaxationTestPath("tests/a.py") && isRelaxationTestPath("src/a.test.ts") && !isRelaxationTestPath("src/a.ts"));
    assert.deepEqual(analyzeRelaxations({ diff: "", riskPaths: GLOBS }), { relaxations: [], negatives: 0 });
  });
  it("prompts carry the relaxed hunks; unchanged without relaxations", () => {
    const { relaxations } = analyzeRelaxations({ diff: RESCUE, riskPaths: GLOBS });
    const blk = relaxationBlock(relaxations);
    assert.match(blk, /<relaxation_checks>[\s\S]*antibot\.py:\d+[\s\S]*negative-corpus/);
    const base = { issue: { number: 1, title: "t", body: "b" }, contract: {}, diff: "d", files: ["a"] };
    assert.doesNotMatch(verifierPrompt(base), /relaxation_checks/);
    assert.match(verifierPrompt({ ...base, relaxations }), /<relaxation_checks>/);
    assert.doesNotMatch(reviewerPrompt({ ...base, result: {} }), /relaxation_checks/);
    assert.match(reviewerPrompt({ ...base, result: {}, relaxations }), /<relaxation_checks>/);
    assert.equal(relaxationBlock([]), "");
  });
});
