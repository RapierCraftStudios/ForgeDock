// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeGate, readReleaseGate, mergeGuard, postReleaseGate, GATE_CHECK } from "./release-gate.mjs";

const H = "a".repeat(40), OLD = "b".repeat(40);
const run = (name, conclusion, head = H) => ({ name, conclusion, head });
const verdict = { head: H, verdict: "pass" };
const base = { required: ["ci", "lint"], reviewVerdict: verdict, head: H };

describe("computeGate (#5561)", () => {
  const rows = [
    ["success", [run("ci", "success"), run("lint", "success")], true],
    ["failure", [run("ci", "failure"), run("lint", "success")], false],
    ["neutral", [run("ci", "neutral"), run("lint", "success")], false],
    ["skipped", [run("ci", "skipped"), run("lint", "success")], false],
    ["missing", [run("ci", "success")], false],
    ["wrong head", [run("ci", "success", OLD), run("lint", "success")], false],
    ["one rerun red", [run("ci", "success"), run("ci", "failure"), run("lint", "success")], false],
  ];
  for (const [name, checks, pass] of rows) it(name, () => assert.equal(computeGate({ ...base, checks }).pass, pass));
  const ok = [run("ci", "success"), run("lint", "success")];
  it("stale verdict (other head), failing verdict, no verdict", () => {
    assert.equal(computeGate({ ...base, checks: ok, reviewVerdict: { head: OLD, verdict: "pass" } }).pass, false);
    assert.equal(computeGate({ ...base, checks: ok, reviewVerdict: { head: H, verdict: "blocked" } }).pass, false);
    assert.equal(computeGate({ ...base, checks: ok, reviewVerdict: null }).pass, false);
  });
  it("fails closed on unreadable input", () => {
    for (const bad of [{ checks: "x" }, { checks: ok, required: [] }, { checks: ok, required: undefined }, { checks: ok, head: undefined }, {}]) assert.equal(computeGate({ ...base, ...bad }).pass, false);
    assert.equal(computeGate().pass, false);
  });
  it("I1 fixture matrix: the merging actor (App or human) and check-skip rules never change the result; a skipped required check is not green", () => {
    const matrix = [
      { actor: "app", conclusion: "success", pass: true },
      { actor: "app", conclusion: "skipped", pass: false }, // an App-authored merge does not make a check-skip rule count as success
      { actor: "human", conclusion: "success", pass: true },
      { actor: "human", conclusion: "skipped", pass: false },
    ];
    for (const row of matrix) assert.equal(computeGate({ ...base, checks: [run("ci", row.conclusion), run("lint", "success")] }).pass, row.pass, JSON.stringify(row));
  });
});

const ioWith = (checks, extra = {}) => ({ gh: async () => { if (checks instanceof Error) throw checks; return JSON.stringify(checks); }, git: () => "", ...extra });

describe("readReleaseGate (#5561)", () => {
  const gate = (conclusion, app) => ({ name: GATE_CHECK, conclusion, head: H, app });
  it("accepts the check run only from the configured app", async () => {
    assert.deepEqual(await readReleaseGate({ io: ioWith([gate("success", "gate-app")]), repo: "o/r", head: H, identity: { app: "gate-app" } }), { ok: true, conclusion: "success" });
    assert.match((await readReleaseGate({ io: ioWith([gate("success", "forge-bot")]), repo: "o/r", head: H, identity: { app: "gate-app" } })).why, /not posted by gate-app/);
  });
  it("refuses when absent for the sha, unreadable or no identity is configured", async () => {
    assert.match((await readReleaseGate({ io: ioWith([]), repo: "o/r", head: H, identity: { app: "a" } })).why, /no forge\/release-gate/);
    assert.match((await readReleaseGate({ io: ioWith(new Error("boom")), repo: "o/r", head: H, identity: { app: "a" } })).why, /cannot read/);
    assert.match((await readReleaseGate({ io: ioWith([gate("success", "a")]), repo: "o/r", head: H, identity: {} })).why, /no gate identity/);
  });
});

describe("mergeGuard I1 actor matrix (#5561)", () => {
  // Documented: the I1 case. Required checks skipped (check-skip rules) or a gate run posted by anyone but the configured App never count, whoever authored the merge.
  const policy = { ci: { required_checks: ["ci"] }, credentials: { gate_app: "gate-app" }, plan: { approval: "auto" } };
  const state = { release: null, steps: { review: { result: { head: H, verdict: "pass" } } } };
  const rows = [
    { ci: "success", gateApp: "gate-app", expect: /no FORGE:RELEASE record/ }, // gates pass; refused later only for the missing record
    { ci: "skipped", gateApp: "gate-app", expect: /required checks not green/ },
    { ci: "success", gateApp: "agent-bot", expect: /not posted by gate-app/ },
    { ci: "success", gateApp: "someone", expect: /not posted by gate-app/ },
  ];
  for (const row of rows) it(`ci ${row.ci}, gate posted by ${row.gateApp}`, async () => {
    const checks = [{ name: "ci", conclusion: row.ci, head: H }, { name: GATE_CHECK, conclusion: "success", head: H, app: row.gateApp }];
    assert.match((await mergeGuard({ io: ioWith(checks), repo: "o/r", head: H, state, policy, staging: "staging" })).why, row.expect);
  });
});

describe("mergeGuard (#5561)", () => {
  const policy = { ci: { required_checks: ["ci"] }, credentials: { gate_app: "gate-app" } };
  const state = (over = {}) => ({ plan: { hash: "h1", approved_hash: "h1" }, release: null, steps: { review: { result: { head: H, verdict: "pass" } } }, ...over });
  const checks = [run("ci", "success"), { name: GATE_CHECK, conclusion: "success", head: H, app: "gate-app" }];
  const call = (o = {}) => mergeGuard({ io: ioWith(o.checks ?? checks), repo: "o/r", head: H, state: o.state ?? state(), policy: "policy" in o ? o.policy : policy, staging: "staging" });
  it("a forged GATE_PASS marker is never sufficient: no check run, refused", async () => {
    const r = await call({ checks: [run("ci", "success")], state: state({ gateMarker: "GATE_PASS" }) });
    assert.match(r.why, /no forge\/release-gate/);
  });
  it("stale approval hash, missing plan, unreadable policy and unreadable checks refuse", async () => {
    assert.match((await call({ state: state({ plan: { hash: "h2", approved_hash: "h1" } }) })).why, /approval is not current/);
    assert.match((await call({ state: state({ plan: undefined }) })).why, /approval is not current/);
    assert.match((await call({ state: state({ plan: undefined }), policy: { ...policy, plan: { approval: "auto" } } })).why, /no FORGE:RELEASE record/); // auto policy: no plan needed, the next guard answers
    assert.match((await call({ policy: null })).why, /policy is unreadable/);
    assert.match((await call({ checks: new Error("x") })).why, /cannot read check runs/);
  });
  it("a required check not green on the head refuses; a green head without a release record refuses", async () => {
    assert.match((await call({ checks: [run("ci", "failure"), checks[1]] })).why, /required checks not green/);
    assert.match((await call()).why, /no FORGE:RELEASE record/);
  });
  it("head moved by one commit refuses via checkChain", async () => {
    const rec = { snapshot: "s".repeat(40), picks: [] };
    const git = (a) => { if (a[0] === "rev-parse") return "t\n"; if (a[0] === "merge-base") throw new Error("not ancestor"); return "\n"; };
    const r = await mergeGuard({ io: { ...ioWith(checks), git }, repo: "o/r", head: H, state: state({ release: rec }), policy, staging: "staging" });
    assert.equal(r.ok, false);
    assert.match(r.why, /not snapshot \+ recorded cherry-picks/);
  });
});

describe("real review verdict and gate posting (#5561)", () => {
  it("the review-staging verdict APPROVE FOR DEPLOY passes computeGate; REQUEST CHANGES does not", () => {
    const base = { checks: [run("ci", "success")], required: ["ci"], head: H };
    assert.equal(computeGate({ ...base, reviewVerdict: { head: H, verdict: "APPROVE FOR DEPLOY" } }).pass, true);
    assert.equal(computeGate({ ...base, reviewVerdict: { head: H, verdict: "REQUEST CHANGES" } }).pass, false);
  });
  it("gate-post is refused for lane and driver roles and allowed for the gate role", async () => {
    const calls = [], io = { gh: async (a) => { calls.push(a); return ""; } };
    for (const credential of ["lane", "driver"]) await assert.rejects(postReleaseGate({ io, ctx: { credential }, repo: "o/r", head: H, conclusion: "success" }), (e) => e.refused === `role ${credential} may not gate-post`);
    assert.equal(calls.length, 0);
    assert.deepEqual(await postReleaseGate({ io, ctx: { credential: "gate" }, repo: "o/r", head: H, conclusion: "success" }), { posted: true });
  });
});
