// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bestResults, passedOnHead, isToolMissingExit } from "./validatebest.mjs";

describe("best validate result per id (#5331)", () => {
  it("a remote exit 127 after a local exit 0 does not replace the pass", () => {
    const r = bestResults([{ id: "V3", command: "promtool x", exit: 0, where: "local" }, { id: "V3", command: "promtool x", exit: 127, where: "remote" }]);
    assert.deepEqual(r, [{ id: "V3", command: "promtool x", exit: 0, where: "local", head: null }]);
  });
  it("a real failure after a pass replaces it; a later pass replaces a failure or a 127", () => {
    assert.equal(bestResults([{ command: "a", exit: 0 }, { command: "a", exit: 1 }])[0].exit, 1);
    assert.equal(bestResults([{ command: "a", exit: 127 }, { command: "a", exit: 0 }])[0].exit, 0);
  });
  it("ignores malformed rows and keys by id before command", () => {
    assert.equal(bestResults([null, { command: "a" }, { id: "V1", command: "a", exit: 0 }, { id: "V2", command: "a", exit: 1 }]).length, 2);
    assert.deepEqual(bestResults(undefined), []);
  });
  it("passedOnHead compares heads only when both are known", () => {
    assert.equal(passedOnHead({ exit: 0, head: "abc" }, "abc"), true);
    assert.equal(passedOnHead({ exit: 0, head: "abc" }, "def"), false);
    assert.equal(passedOnHead({ exit: 0 }, "def"), true);
    assert.equal(passedOnHead({ exit: 127 }, "def"), false);
    assert.equal(isToolMissingExit(127), true);
  });
});
