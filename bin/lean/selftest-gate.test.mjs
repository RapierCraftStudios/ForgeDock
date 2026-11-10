// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildJourneyMarker, parseJourneyMarker, postJourneyMarker, buildMarker, parseMarker, selftestGate, readMarkerComments, postMarker } from "./selftest-gate.mjs";

const H = "a".repeat(40), O = "b".repeat(40);
describe("FORGE:SELFTEST gate (#4865)", () => {
  it("round-trips a marker", () => {
    assert.deepEqual(parseMarker(buildMarker({ result: "fail", sha: H, step: "add" })), { result: "fail", sha: H, step: "add" });
  });
  it("accepts a passing marker for the head", () => assert.equal(selftestGate([buildMarker({ result: "pass", sha: H })], H).ok, true));
  it("refuses missing, failing, stale and malformed markers", () => {
    assert.equal(selftestGate([], H).ok, false);
    assert.equal(selftestGate(["lgtm"], H).ok, false);
    assert.match(selftestGate([buildMarker({ result: "fail", sha: H, step: "add" })], H).reason, /step add/);
    assert.match(selftestGate([buildMarker({ result: "pass", sha: O })], H).reason, /not the PR head/);
    assert.equal(selftestGate(["<!-- FORGE:SELFTEST result=pass sha=abc -->"], H).ok, false);
  });
  it("a marker quoted inside prose does not count", () => {
    assert.equal(parseMarker(`see: ${buildMarker({ result: "pass", sha: H })}`), null);
    assert.equal(selftestGate([buildMarker({ result: "fail", sha: H, step: "add" }), `quoting ${buildMarker({ result: "pass", sha: H })}`], H).ok, false);
  });
  it("a gh failure is not read as no marker", async () => {
    await assert.rejects(readMarkerComments(async () => { throw new Error("HTTP 502"); }, "o/r", 5), /502/);
  });
  it("the newest marker wins", () => {
    assert.equal(selftestGate([buildMarker({ result: "pass", sha: H }), buildMarker({ result: "fail", sha: H, step: "merge" })], H).ok, false);
    assert.equal(selftestGate([buildMarker({ result: "fail", sha: H, step: "merge" }), buildMarker({ result: "pass", sha: H })], H).ok, true);
  });
  it("reads and posts through gh", async () => {
    const calls = [];
    const rows = [{ body: "x", author_association: "OWNER", user: { login: "m", type: "User" } }, { body: "forged", author_association: "NONE", user: { login: "drive-by", type: "User" } }, { body: "bot", author_association: "NONE", user: { login: "app[bot]", type: "Bot" } }];
    const gh = async (a) => { calls.push(a); return a[0] === "api" ? rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n" : ""; };
    assert.deepEqual(await readMarkerComments(gh, "o/r", 5), ["x", "bot"], "an untrusted commenter's marker is dropped");
    await postMarker(gh, "o/r", 5, { result: "pass", sha: H });
    assert.match(calls[1].at(-1), /FORGE:SELFTEST result=pass/);
  });
});


describe("FORGE:JOURNEY marker (#5305)", () => {
  it("round-trips and never counts as a FORGE:SELFTEST result", () => {
    const m = buildJourneyMarker({ result: "pass", sha: H, ttfm: 312 });
    assert.deepEqual(parseJourneyMarker(m), { result: "pass", sha: H, step: "none", ttfm: 312 });
    assert.equal(parseMarker(m), null);
    assert.equal(selftestGate([m], H).ok, false);
    assert.equal(parseJourneyMarker(buildMarker({ result: "pass", sha: H })), null);
    assert.equal(parseJourneyMarker(`quote ${m}`), null);
    assert.equal(parseJourneyMarker(buildJourneyMarker({ result: "fail", sha: H, step: "doctor" })).ttfm, null);
  });
  it("posts through gh", async () => {
    const calls = [];
    await postJourneyMarker(async (a) => { calls.push(a); return ""; }, "o/r", 5, { result: "fail", sha: H, step: "banner" });
    assert.match(calls[0].at(-1), /^<!-- FORGE:JOURNEY result=fail sha=a{40} step=banner ttfm=na -->/);
  });
});
