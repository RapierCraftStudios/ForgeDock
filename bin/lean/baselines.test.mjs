// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBaselines, matchBaselines, baselineFailures, foldRegression } from "./baselines.mjs";
import { parseVerify } from "./verify.mjs";
import { precheck } from "./conformance.mjs";

describe("baselines (#5448)", () => {
  it("parses the array and the map forms; parseVerify carries them", () => {
    const want = [{ when: "shared/content/**", run: "make stealth-baseline" }];
    assert.deepEqual(parseBaselines(want), want);
    assert.deepEqual(parseBaselines({ "shared/content/**": "make stealth-baseline" }), want);
    assert.deepEqual(parseVerify({ baselines: { "shared/content/**": "make stealth-baseline" } }).baselines, want);
    assert.equal(parseVerify({}).baselines, undefined);
  });
  it("a shared-module change selects the baseline once; an unrelated change selects none", () => {
    const b = parseBaselines({ "shared/content/**": "make stealth-baseline", "shared/**": "make stealth-baseline" });
    assert.equal(matchBaselines(["shared/content/a.py", "shared/content/b.py"], b).length, 1);
    assert.deepEqual(matchBaselines(["docs/readme.md"], b), []);
  });
  it("a failing baseline fails precheck as a regression; a passing one does not", () => {
    const run = { when: "shared/**", run: "make stealth-baseline" };
    const c = { requirements: [], deliverables: [], validate: [] };
    const fail = precheck({ contract: c, result: {}, changedFiles: [], baselineFailures: baselineFailures([{ ...run, rc: 2, output: "vendor x red" }]) });
    assert.ok(fail.failures.some((f) => f.kind === "baseline_failed" && /vendor x red/.test(f.detail)));
    assert.equal(baselineFailures([{ ...run, rc: 0 }]).length, 0);
  });
  it("folds the regression set into validate once", () => {
    const c = { validate: [{ id: "V1", command: "a" }], regression: [{ id: "G1", command: "b" }, { id: "G2", command: "a" }] };
    assert.deepEqual(foldRegression(c).validate.map((v) => v.id), ["V1", "G1"]);
  });
});
