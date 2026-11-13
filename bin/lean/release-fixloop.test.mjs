// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFixConfig, collectFindings, blockingOf, deferredOf, compileBrief, inputHash, jobsToRerun, roundsAt, recordRound, secondPush, secondPushOf, holdForOwner } from "./release-fixloop.mjs";

const HEAD = "a".repeat(40);
const input = () => ({
  head: HEAD,
  jobs: [{ name: "unit", conclusion: "failure", log: "AssertionError: x" }, { name: "lint", conclusion: "success" }, { name: "e2e", conclusion: "failure", log: "ECONNRESET" }],
  findings: [{ title: "SQL injection", severity: "HIGH", property: "input-validation" }, { title: "Other path injection", severity: "CRITICAL", property: "input-validation" }, { title: "nit", severity: "LOW" }, { title: "elsewhere", severity: "HIGH", wave: false }],
  guards: [{ name: "devdocs", why: "dossier stale" }],
});

describe("release-fixloop (#5567)", () => {
  it("collects failed jobs (flake-classified), findings and guards into one record", () => {
    const rec = collectFindings(input());
    assert.deepEqual(rec.ci.map((j) => [j.name, j.class]).map(([n, c]) => [n, c === "infra"]), [["e2e", true], ["unit", false]]);
    assert.equal(rec.guards.length, 1);
    assert.equal(blockingOf(rec).review.length, 2);
  });
  it("non-blocking and out-of-wave findings never block; they are deferred to the next plan", () => {
    const d = deferredOf(collectFindings(input())).map((f) => f.title);
    assert.deepEqual(d.sort(), ["elsewhere", "nit"]);
  });
  it("brief groups by invariant, has the sibling sweep, commands and rerun checks, and is deterministic", () => {
    const a = compileBrief(collectFindings(input()), { commands: ["npm test"], rerunChecks: ["unit", "e2e"] });
    const rev = input(); rev.findings.reverse(); rev.jobs.reverse();
    const b = compileBrief(collectFindings(rev), { commands: ["npm test"], rerunChecks: ["e2e", "unit"] });
    assert.equal(a, b);
    assert.match(a, /## Invariant: input-validation\n- CRITICAL: Other path injection\n- HIGH: SQL injection/);
    assert.match(a, /## Sibling sweep/);
    assert.match(a, /`npm test`/);
    assert.match(a, /## Checks that will rerun\n- e2e\n- unit/);
    assert.ok(!a.includes("LOW"), "non-blocking finding is not in the brief");
  });
  it("max_rounds defaults to 1; the counter is keyed by head sha", () => {
    assert.equal(parseFixConfig(undefined).maxRounds, 1);
    assert.equal(parseFixConfig({ max_rounds: 3 }).maxRounds, 3);
    const st = {};
    assert.equal(roundsAt(st, HEAD), 0);
    recordRound(st, { from: HEAD, to: "b".repeat(40) });
    assert.equal(roundsAt(st, "b".repeat(40)), 1);
    assert.equal(roundsAt(st, HEAD), 0);
  });
  it("second push: infra-only -> rerun once; regression -> revert; anything else -> HELD with an owner ask (no model)", () => {
    const flake = collectFindings({ head: HEAD, jobs: [{ name: "e2e", conclusion: "failure", log: "ECONNRESET" }] });
    assert.deepEqual(secondPush({ rec: flake, rounds: 1 }), { action: "rerun" });
    assert.equal(secondPush({ rec: flake, lastPush: "rerun", rounds: 1 }).action, "hold");
    const real = collectFindings({ head: HEAD, jobs: [{ name: "unit", conclusion: "failure", log: "AssertionError" }] });
    assert.deepEqual(secondPush({ rec: real, failedBefore: ["lint"], rounds: 1 }), { action: "revert" });
    const held = secondPush({ rec: real, failedBefore: ["unit"], rounds: 1 });
    assert.equal(held.action, "hold");
    assert.match(held.ask, /^Owner: /);
  });
  it("secondPushOf reads the recorded second push; reruns are limited to jobs whose input hash changed", () => {
    const st = {}; recordRound(st, { from: HEAD, to: HEAD, kind: "rerun" });
    assert.equal(secondPushOf(st, HEAD), "rerun");
    assert.deepEqual(jobsToRerun({ a: inputHash("1"), b: inputHash("2") }, { a: inputHash("1"), b: inputHash("x") }), ["b"]);
  });
  it("holdForOwner marks HELD through ctx.hold and returns a blocked result", async () => {
    let ask = null;
    const r = await holdForOwner({ hold: async (a) => { ask = a; } }, "Owner: x");
    assert.equal(ask, "Owner: x");
    assert.deepEqual(r, { blocked: true, held: true, reason: "Owner: x" });
  });
  it("replay of a recorded findings fixture ends in one round or a recorded hold", () => {
    const rec = collectFindings(input());
    const d = secondPush({ rec, failedBefore: ["unit", "e2e"], rounds: 1 });
    assert.ok(["hold", "rerun", "revert"].includes(d.action));
  });
});
