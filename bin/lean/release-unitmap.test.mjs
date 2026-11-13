// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unitGlobToRegExp, resolvePath } from "./release-unitmap.mjs";

const policy = {
  units: { api: { paths: ["services/api/**"] }, worker: { paths: ["services/worker/**"] }, web: { paths: ["web/*.js"] } },
  couplings: [{ paths: ["shared/**"], affects: ["api", "worker"] }, { paths: ["emails/**"], affects: ["api", "web"] }],
  contracts: [{ producer: "api", consumers: ["web"], paths: ["services/api/app/routers/**"] }],
  forces: [{ paths: ["infra/migrations/**"], pipeline: "full", reason: "migrations" }, { paths: ["docker-compose*.yml"], pipeline: "full", reason: "deploy-mechanics" }],
};

describe("unitGlobToRegExp", () => {
  it("** crosses directories, * does not, ? is one char", () => {
    assert.ok(unitGlobToRegExp("a/**").test("a/b/c.txt"));
    assert.ok(unitGlobToRegExp("**/x.json").test("x.json") && unitGlobToRegExp("**/x.json").test("a/b/x.json"));
    assert.ok(unitGlobToRegExp("a/*.js").test("a/b.js") && !unitGlobToRegExp("a/*.js").test("a/b/c.js"));
    assert.ok(unitGlobToRegExp("a?.js").test("ab.js") && !unitGlobToRegExp("a?.js").test("a/.js"));
    assert.ok(!unitGlobToRegExp("a.js").test("axjs"));
  });
});

describe("resolvePath", () => {
  it("resolves a path to its unit or none", () => {
    for (const [p, u] of [["services/api/app/main.py", "api"], ["services/worker/x.py", "worker"], ["web/a.js", "web"], ["README.md", "none"], ["web/sub/a.js", "none"]]) assert.equal(resolvePath(policy, p).unit, u, p);
  });
  it("fans a coupling out, flags a contract and a force", () => {
    assert.deepEqual(resolvePath(policy, "shared/x.py").affects, ["api", "worker"]);
    assert.equal(resolvePath(policy, "shared/x.py").unit, "none");
    assert.equal(resolvePath(policy, "services/api/app/routers/a.py").contracts[0].producer, "api");
    assert.equal(resolvePath(policy, "infra/migrations/001.sql").forces[0].reason, "migrations");
    assert.equal(resolvePath(policy, "./docker-compose.prod.yml").forces[0].reason, "deploy-mechanics");
  });
  it("first declared unit wins and every owner is listed", () => {
    const p = { units: { a: { paths: ["x/**"] }, b: { paths: ["x/y/**"] } } };
    const r = resolvePath(p, "x/y/z");
    assert.equal(r.unit, "a"); assert.deepEqual(r.units, ["a", "b"]);
  });
  it("an empty policy resolves everything to none", () => assert.equal(resolvePath({}, "a").unit, "none"));
});
