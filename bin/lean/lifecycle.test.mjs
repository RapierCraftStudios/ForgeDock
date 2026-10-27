import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLifecycle, renderLifecycle, advanceState, parseCloseOn, closeDue, classifyCarryOver, preflightCarryOver, shippedWithOpen, emptyButOpen, advanceMilestone, makeLifecycle } from "./lifecycle.mjs";
import { renderSummary, parseSummary } from "./drift.mjs";

const fakeGh = (ms, openIssues = []) => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === "api" && args[1].includes("/milestones?")) return JSON.stringify([{ number: 3, title: "M", description: ms.description }]);
    if (args[0] === "issue") return JSON.stringify(openIssues);
    if (args[1] === "-X") { ms.description = args.find((a) => a.startsWith("description=")).slice(12); }
    return "";
  };
  return { gh, calls };
};

describe("forge#4657 lifecycle block", () => {
  it("round-trips, keeps surrounding text and the drift block", () => {
    const d = renderSummary("intro", { v: 1, merged: [] });
    const r = renderLifecycle(d, { state: "shipped:staging", sha: "abc" });
    assert.equal(parseLifecycle(r).state, "shipped:staging");
    assert.ok(r.startsWith("intro") && parseSummary(r));
    assert.equal(parseLifecycle(renderLifecycle(r, { state: "closed" })).state, "closed");
    assert.equal(parseLifecycle("no block"), null);
  });
  it("only moves forward", () => {
    assert.equal(advanceState("deployed:default", "shipped:staging"), "deployed:default");
    assert.equal(advanceState(undefined, "shipped:staging"), "shipped:staging");
  });
  it("closeDue honours close_on (default: default)", () => {
    assert.equal(parseCloseOn(undefined), "default");
    assert.equal(closeDue("shipped:staging", "staging"), true);
    assert.equal(closeDue("shipped:staging"), false);
    assert.equal(closeDue("deployed:default"), true);
    assert.equal(closeDue("closed", "staging"), false);
  });
});

describe("forge#4657 carry-over", () => {
  it("classifies from labels", () => {
    assert.equal(classifyCarryOver({ labels: ["needs-human:external"] }), "external");
    assert.equal(classifyCarryOver({ labels: [{ name: "awaiting-promotion" }] }), "post-deploy");
    assert.equal(classifyCarryOver({ labels: ["wont-do"] }), "wont-do");
    assert.equal(classifyCarryOver({ labels: ["carry:post-deploy"] }), "post-deploy");
    assert.equal(classifyCarryOver({ labels: [] }), "engineering");
  });
  it("requires a target milestone and never demotes external, gated or off-base-dependent issues", () => {
    const r = preflightCarryOver([
      { number: 1, labels: [], target: "" },
      { number: 2, labels: ["needs-human:external"], target: "M2" },
      { number: 3, labels: ["legal-gated"], target: "M2" },
      { number: 4, labels: [], target: "M2", dependsOn: [9] },
      { number: 5, labels: [], target: "M2", dependsOn: [8] },
    ], { onBase: (n) => n !== 9 });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, [{ issue: 1, why: "no target milestone" }]);
    assert.deepEqual(r.mustNotDemote, [2, 3, 4]);
    assert.deepEqual(r.carry.filter((c) => c.demote).map((c) => c.issue), [5]);
    assert.equal(preflightCarryOver([]).ok, true);
  });
});

describe("forge#4657 pipeline-status classifiers", () => {
  it("SHIPPED_WITH_OPEN and EMPTY_BUT_OPEN", () => {
    const d = renderLifecycle("", { state: "shipped:staging" });
    assert.equal(shippedWithOpen({ state: "open", open: 2, description: d }), true);
    assert.equal(shippedWithOpen({ state: "open", open: 2, description: "" }), false);
    assert.equal(emptyButOpen({ state: "open", open: 0 }), true);
    assert.equal(emptyButOpen({ state: "closed", open: 0 }), false);
  });
});

describe("forge#4657 advanceMilestone", () => {
  it("records shipped:staging and keeps the milestone open when close_on=default", async () => {
    const ms = { description: "" }, { gh } = fakeGh(ms);
    assert.deepEqual(await advanceMilestone({ gh, repo: "o/r", title: "M", to: "shipped:staging", sha: "abc" }), { state: "shipped:staging", closed: false });
    assert.equal(parseLifecycle(ms.description).sha, "abc");
  });
  it("closes at shipped:staging when close_on=staging and no open issue is left", async () => {
    const ms = { description: "" }, { gh, calls } = fakeGh(ms);
    assert.equal((await advanceMilestone({ gh, repo: "o/r", title: "M", to: "shipped:staging", closeOn: "staging" })).closed, true);
    assert.ok(calls.some((c) => c.includes("state=closed")));
  });
  it("does not close a milestone that still has open issues", async () => {
    const ms = { description: "" }, { gh } = fakeGh(ms, [{ number: 1 }]);
    assert.equal((await advanceMilestone({ gh, repo: "o/r", title: "M", to: "shipped:staging", closeOn: "staging" })).closed, false);
  });
  it("the orchestrate seam promotes to deployed:default once the sha is on the default branch, then closes", async () => {
    const ms = { description: renderLifecycle("", { state: "shipped:staging", sha: "abc" }) }, { gh } = fakeGh(ms);
    const lc = makeLifecycle({ gh, git: async () => "", repo: "o/r" });
    assert.deepEqual(await lc.onBatchEnd(["M"]), [{ title: "M", state: "closed", closed: true }]);
    const ms2 = { description: renderLifecycle("", { state: "shipped:staging", sha: "abc" }) }, g2 = fakeGh(ms2);
    const lc2 = makeLifecycle({ gh: g2.gh, git: async () => { throw new Error("not ancestor"); }, repo: "o/r" });
    assert.equal((await lc2.onBatchEnd(["M"]))[0].state, "shipped:staging");
  });
});
