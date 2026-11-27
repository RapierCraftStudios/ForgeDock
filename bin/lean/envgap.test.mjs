// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: BUSL-1.1
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { baseMergeOnlyBlock, envGapBlockCode, toolGapFailures, packageDirsMissingDeps, failureOutsideDiff } from "./envgap.mjs";

describe("#6106 env gap classification", () => {
  it("a check that fails on a PATH pass-through wrapper with no real binary is a tool gap", () => {
    const out = "forgedock heavy: eslint at /w/web/node_modules/.bin/eslint is a PATH pass-through wrapper with no real binary behind it";
    assert.equal(toolGapFailures([{ command: "cd web && eslint .", rc: 127, output: out }, { command: "node --test", rc: 1, output: "not ok 1 - assertion" }]).length, 1);
    assert.equal(toolGapFailures([{ command: "x", rc: 1, output: "AssertionError: expected 1 to equal 2" }]).length, 0);
  });
  it("block reasons naming a missing tool/interpreter/recipe/sandbox capability map to env codes", () => {
    assert.equal(envGapBlockCode("product-decision", "the yaml lane-tools recipe lives in the engine"), "env.tool_missing");
    assert.equal(envGapBlockCode("credentials", "no Python 3.11 interpreter (only 3.12.3)"), "env.tool_missing");
    assert.equal(envGapBlockCode("credentials", "the sandbox lacks network access to the registry"), "env.capability_remote");
  });
  it("genuine human reasons stay human", () => {
    assert.equal(envGapBlockCode("product-decision", "needs Stripe approval"), null);
    assert.equal(envGapBlockCode("credentials", "no docker credentials: need the registry token"), null);
    assert.equal(envGapBlockCode("product-decision", "which option should the product take?"), null);
    assert.equal(envGapBlockCode("approval", "no interpreter"), null);
  });
  it("package dirs the checks touch that have a manifest but no node_modules are found", () => {
    const have = new Set(["web/package.json", "api/package.json", "api/node_modules"]);
    const exists = (p) => have.has(p);
    assert.deepEqual(packageDirsMissingDeps(["cd web && npx eslint .", "cd api && npm test", "node --test"], exists), ["web"]);
    assert.deepEqual(packageDirsMissingDeps(["npm --prefix web run lint"], exists), ["web"]);
    assert.deepEqual(packageDirsMissingDeps(["web/node_modules/.bin/eslint src"], exists), ["web"]);
    assert.deepEqual(packageDirsMissingDeps(["cd ../x && ls"], () => true), []);
  });
});

describe("#6094 failures outside the diff", () => {
  it("names a test file the diff does not touch -> outside; touched or unnamed -> not", () => {
    const out = "not ok 5 - ten concurrent\n location: '/w/bin/tests/mirror-script.test.mjs:48:3'";
    assert.equal(failureOutsideDiff(out, ["bin/lean/release.mjs"]), true);
    assert.equal(failureOutsideDiff(out, ["bin/tests/mirror-script.test.mjs"]), false);
    assert.equal(failureOutsideDiff("make: *** [lint] Error 1", ["a.js"]), false);
    assert.equal(failureOutsideDiff("FAILED tests/test_api.py::t - x", ["web/app.ts"]), true);
  });
});

describe("#6137 a base merge into the lane branch is never a human gate", () => {
  it("only-a-base-merge blocks are mechanical; real human reasons stay human", () => {
    assert.equal(baseMergeOnlyBlock("product-decision", "needs a user-approved merge of staging (CLAUDE.md forbids agent git merge)"), true);
    assert.equal(baseMergeOnlyBlock("product-decision", "the branch is behind: please merge main into the lane branch first"), true);
    assert.equal(baseMergeOnlyBlock("product-decision", "needs a user-approved merge of staging, and the Stripe pricing decision from the owner"), false);
    assert.equal(baseMergeOnlyBlock("product-decision", "merge the PR into main and promote to production"), false);
    assert.equal(baseMergeOnlyBlock("credentials", "needs a merge of staging"), false);
    assert.equal(baseMergeOnlyBlock("product-decision", "which pagination style?"), false);
  });
});
