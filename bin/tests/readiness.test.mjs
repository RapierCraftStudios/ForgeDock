import { test } from "node:test";
import assert from "node:assert/strict";
import { readiness, deployable, parseGates, parseOwner, formatReadinessReport, formatReadinessDigest } from "../../scripts/readiness.mjs";

const NOW = Date.parse("2026-10-27T00:00:00Z");
const pre = (number, gates, extra = {}) => ({
  number, title: `prereq ${number}`, labels: [{ name: "needs-human:external" }], createdAt: "2026-10-17T00:00:00Z",
  body: `gates: ${gates}\nowner: alice\n${extra.deps ? `Depends on ${extra.deps}\n` : ""}`, ...extra.rest,
});

test("parseGates keeps valid gates and drops invalid ones", () => {
  assert.deepEqual(parseGates("gates: preview, bogus, feature-flag:beta"), ["preview", "feature-flag:beta"]);
  assert.deepEqual(parseGates("no field"), []);
  assert.equal(parseOwner("owner: bob\n"), "bob");
  assert.equal(parseOwner("x"), null);
});

test("readiness groups open prerequisites per gate with owner, age and code milestones", () => {
  const code = { number: 9, title: "ui", labels: [], body: "gates: staging-deploy", milestone: { title: "M3" } };
  const r = readiness([pre(1, "staging-deploy, prod-deploy"), code], NOW);
  assert.equal(r.gates["staging-deploy"].prerequisites[0].owner, "alice");
  assert.equal(r.gates["staging-deploy"].prerequisites[0].ageDays, 10);
  assert.deepEqual(r.gates["staging-deploy"].milestones, ["M3"]);
  assert.equal(r.gates["prod-deploy"].prerequisites.length, 1);
  assert.match(formatReadinessReport(r), /staging-deploy: RED/);
});

test("deployable is false while the target gate has open prerequisites, true otherwise", () => {
  const r = readiness([pre(1, "staging-deploy")], NOW);
  assert.equal(deployable(r, "staging").deployable, false);
  assert.equal(deployable(r, "prod").deployable, true);
  assert.equal(deployable(readiness([], NOW), "staging").deployable, true);
});

test("a feature-flag gate stays red but does not block any deploy target or merge", () => {
  const r = readiness([pre(2, "feature-flag:beta")], NOW);
  assert.equal(r.gates["feature-flag:beta"].red, true);
  assert.equal(r.gates["feature-flag:beta"].blocksMerge, false);
  for (const t of ["preview", "staging", "prod"]) assert.equal(deployable(r, t).deployable, true);
});

test("digest lists DNS before hosting before CI env, and survives a cycle", () => {
  const dns = pre(10, "preview"), host = pre(11, "preview", { deps: "#10" }), ci = pre(12, "preview", { deps: "#11" });
  const r = readiness([ci, host, dns], NOW);
  assert.deepEqual(r.digest.map((d) => d.number), [10, 11, 12]);
  assert.equal(r.digest[0].unblocked, true);
  assert.equal(r.digest[2].unblocked, false);
  assert.match(formatReadinessDigest(r), /after #11/);
  const a = pre(20, "preview", { deps: "#21" }), b = pre(21, "preview", { deps: "#20" });
  assert.equal(readiness([a, b], NOW).digest.length, 2);
});

test("issues without the external label or gates produce an empty report", () => {
  const r = readiness([{ number: 3, labels: [{ name: "needs-human" }], body: "gates: preview" }], NOW);
  assert.deepEqual(r.gates, {});
});
