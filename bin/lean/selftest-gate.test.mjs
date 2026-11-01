// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMarker, parseMarker, selftestGate, readMarkerComments, postMarker } from "./selftest-gate.mjs";

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
  it("the newest marker wins", () => {
    assert.equal(selftestGate([buildMarker({ result: "pass", sha: H }), buildMarker({ result: "fail", sha: H, step: "merge" })], H).ok, false);
    assert.equal(selftestGate([buildMarker({ result: "fail", sha: H, step: "merge" }), buildMarker({ result: "pass", sha: H })], H).ok, true);
  });
  it("reads and posts through gh", async () => {
    const calls = [];
    const gh = async (a) => { calls.push(a); return a[0] === "api" ? JSON.stringify("x") + "\nnot json\n" : ""; };
    assert.deepEqual(await readMarkerComments(gh, "o/r", 5), ["x"]);
    await postMarker(gh, "o/r", 5, { result: "pass", sha: H });
    assert.match(calls[1].at(-1), /FORGE:SELFTEST result=pass/);
  });
});

import { readFileSync } from "node:fs";
it("post-deploy checks file defines the selftest checks the contract names (#4865)", () => {
  const checks = JSON.parse(readFileSync(new URL("../../.forge/post-deploy-checks.json", import.meta.url), "utf8"));
  for (const id of ["selftest-live-run", "selftest-live-defect-detect"]) assert.ok(checks[id]?.run, id);
});
