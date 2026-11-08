// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveFindingLabel, isFinding, findingVerdict } from "./findinglabel.mjs";

const fake = (fail) => { const calls = []; return { calls, validateLabel: async (n, v) => { calls.push([n, v]); if (fail) throw new Error("gh down"); } }; };
const F = [{ name: "review-finding" }, { name: "needs-validation" }];

describe("finding close resolves needs-validation (#5254)", () => {
  it("finding close resolves needs-validation: merged finding gets CONFIRMED (validated)", async () => {
    const io = fake();
    assert.equal((await resolveFindingLabel({ io, issue: 7, labels: F, reason: "merged" })).applied, true);
    assert.deepEqual(io.calls, [[7, "CONFIRMED"]]);
  });
  it("finding close resolves needs-validation: invalid finding gets INVALID (false-positive)", async () => {
    const io = fake();
    await resolveFindingLabel({ io, issue: 7, labels: ["review-finding"], reason: "invalid" });
    assert.deepEqual(io.calls, [[7, "INVALID"]]);
  });
  it("non-findings and other reasons are untouched", async () => {
    const io = fake();
    await resolveFindingLabel({ io, issue: 7, labels: [{ name: "bug" }], reason: "merged" });
    await resolveFindingLabel({ io, issue: 7, labels: F, reason: "needs-human" });
    assert.deepEqual(io.calls, []);
    assert.equal(isFinding(undefined), false);
    assert.equal(findingVerdict("merged"), "CONFIRMED");
  });
  it("a failing label call is reported, never thrown", async () => {
    const r = await resolveFindingLabel({ io: fake(true), issue: 7, labels: F, reason: "merged" });
    assert.equal(r.applied, false); assert.match(r.error, /gh down/);
  });
  it("lean.mjs wires both close paths; effects runs transition-label.sh --validate", () => {
    const lean = readFileSync(new URL("./lean.mjs", import.meta.url), "utf8");
    assert.match(lean, /reason: "merged" \}\)/); assert.match(lean, /reason: "invalid" \}\)/);
    assert.match(readFileSync(new URL("./effects.mjs", import.meta.url), "utf8"), /"--validate", verdict/);
  });
});
