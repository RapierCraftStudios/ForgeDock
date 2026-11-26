// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeState, findLast, decidePost } from "./commentstate.mjs";
import { IN_PLACE_MARKERS } from "./statuscomment.mjs";

const body = (m, text, cost = "0.10") => `<!-- ${m} -->\n${text}\n\n_cost $${cost}, tokens 1 in / 2 out_`;
const url = "https://github.com/o/r/issues/1#issuecomment-5";

describe("post only on a state change (#5979)", () => {
  for (const m of IN_PLACE_MARKERS) {
    it(`a second identical ${m} post is skipped, even when only the usage line differs`, () => {
      const comments = [{ body: body(m, "same state"), url }];
      assert.equal(decidePost({ marker: m, body: body(m, "same state", "9.99"), comments }).action, "skip");
    });
  }
  it("a changed DEPENDENCY or FACTS is patched in place; a changed NEEDS_HUMAN is a new comment", () => {
    const comments = (m) => [{ body: body(m, "old"), url }];
    assert.equal(decidePost({ marker: "FORGE:DEPENDENCY", body: body("FORGE:DEPENDENCY", "new"), comments: comments("FORGE:DEPENDENCY") }).action, "patch");
    assert.equal(decidePost({ marker: "FORGE:FACTS", body: body("FORGE:FACTS", "new"), comments: comments("FORGE:FACTS") }).action, "patch");
    assert.equal(decidePost({ marker: "FORGE:NEEDS_HUMAN", body: body("FORGE:NEEDS_HUMAN", "new"), comments: comments("FORGE:NEEDS_HUMAN") }).action, "create");
  });
  it("no earlier comment creates; an untrusted one is ignored", () => {
    assert.equal(decidePost({ marker: "FORGE:DEPENDENCY", body: "x", comments: [] }).action, "create");
    assert.equal(decidePost({ marker: "FORGE:DEPENDENCY", body: "x", comments: [{ body: body("FORGE:DEPENDENCY", "x") }], trusted: () => false }).action, "create");
  });
  it("findLast returns the newest; normalizeState drops usage, ids and shas", () => {
    assert.equal(findLast([{ body: "<!-- FORGE:FACTS -->\na" }, { body: "<!-- FORGE:FACTS -->\nb" }], "FORGE:FACTS").body.endsWith("b"), true);
    assert.equal(normalizeState(body("M", "a  b 1e0c3e45")), normalizeState(body("M", "a b", "5")));
  });
});
