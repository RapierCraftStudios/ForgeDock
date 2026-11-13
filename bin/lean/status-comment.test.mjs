// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findStatusComment, upsertStatus, parseStatus, withinCap, botComments, BOT_COMMENT_CAP } from "./status-comment.mjs";

const row = (body, n) => ({ body, url: `https://github.com/o/r/issues/7#issuecomment-${n}` });

describe("#5600 status comment", () => {
  it("finds the latest FORGE:STARTED comment and its id", () => {
    const f = findStatusComment([row("<!-- FORGE:STARTED -->\na", 1), row("<!-- FORGE:REVIEW -->\nb", 2), row("<!-- FORGE:STARTED -->\nc", 3)]);
    assert.deepEqual(f, { id: "3", body: "<!-- FORGE:STARTED -->\nc" });
    assert.equal(findStatusComment([row("hello", 1)]), null);
    assert.equal(findStatusComment([row("<!-- FORGE:STARTED -->\nx", 1)], () => false), null);
  });
  it("upsertStatus PATCHes the same comment, replaces a section in place; no doc or a failed edit returns false", async () => {
    const calls = [];
    const gh = async (a) => { calls.push(a); };
    const doc = { id: "3", body: "<!-- FORGE:STARTED -->\nStarted." };
    assert.equal(await upsertStatus({ gh, repo: "o/r", doc, marker: "FORGE:CONTEXT", body: "ctx 1" }), true);
    assert.deepEqual(calls[0].slice(0, 4), ["api", "-X", "PATCH", "repos/o/r/issues/comments/3"]);
    assert.equal(await upsertStatus({ gh, repo: "o/r", doc, marker: "FORGE:CONTEXT", body: "ctx 2", headLine: "requeued" }), true);
    const st = parseStatus(doc.body);
    assert.equal(st.head, "<!-- FORGE:STARTED -->\nStarted.\nrequeued");
    assert.deepEqual([...st.sections.keys()], ["FORGE:CONTEXT"]);
    assert.match(doc.body, /ctx 2/);
    assert.doesNotMatch(doc.body, /ctx 1/);
    assert.equal(await upsertStatus({ gh, repo: "o/r", doc: null, marker: "FORGE:X", body: "y" }), false);
    assert.equal(await upsertStatus({ gh: async () => { throw new Error("x"); }, repo: "o/r", doc: { id: "3", body: "x" }, marker: "FORGE:X", body: "y" }), false);
  });
  it("caps bot comments at 10 but always lets terminal markers through", () => {
    assert.equal(BOT_COMMENT_CAP, 10);
    assert.equal(withinCap(9, "FORGE:REVIEW"), true);
    assert.equal(withinCap(10, "FORGE:REVIEW"), false);
    assert.equal(withinCap(10, ["FORGE:CONTRACT", "FORGE:PLAN"]), false);
    assert.equal(withinCap(30, "FORGE:NEEDS_HUMAN"), true);
    assert.equal(withinCap(30, ["FORGE:TRAJECTORY", "FORGE:WORK-ON"]), true);
  });
  it("counts only marker comments", () => {
    assert.equal(botComments([row("<!-- FORGE:X -->", 1), row("plain", 2)]).length, 1);
  });
});
