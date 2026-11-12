// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * End-to-end run of `forgedock release` through the real job (preflight, release-pr, review, fixes, promotion) against an
 * in-memory GitHub (#5212, R1): the release PR exists, the panel runs, a HIGH finding is filed and blocks, a fix lane merges
 * to staging, the delta review passes, and the job stops at GATE_PASS with the merge command, with no manual step. GitHub, the
 * model and the lane process are in memory (as in conformance.e2e.test.mjs); the job, steps, state and resume are real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { runRelease, newReleaseId, openRelease } from "./release.mjs";

const DISK = [{ mount: "/", type: "ext4" }];
const sha = (n) => String(n).padStart(40, "a");

/** In-memory GitHub + panel: one release PR whose head is a counter; comments are the register. */
function world() {
  const w = { head: 1, comments: [], issues: [], lanes: [], printed: [], fixed: false, agents: [], launched: [] };
  const io = {
    now: () => 1_700_000_000_000, print: (l) => w.printed.push(l),
    runningLanes: async () => [], batches: async () => [], setParallel: async () => {},
    gh: async (a) => {
      const j = a.join(" ");
      if (a[0] === "pr" && a[1] === "list") return JSON.stringify(a.includes("--head") && a[a.indexOf("--state") + 1] === "open" ? [{ number: 7, headRefOid: sha(w.head), url: "u" }] : []);
      if (j.includes("headRefOid")) return JSON.stringify({ headRefOid: sha(w.head) });
      if (j.includes("--json comments")) return JSON.stringify({ comments: w.comments.map((body) => ({ body })) });
      if (a[0] === "api") return JSON.stringify([{ name: "forge/deploy-gate", conclusion: "success" }]);
      throw new Error(`unexpected gh ${j}`);
    },
  };
  io.review = {
    pre: async ({ delta }) => ({ code: 0, lines: [], data: { pr: 7, headSha: sha(w.head), bundle: [1, 2], scopeMode: "full", contextFile: "/sd/ctx.json", launchedFile: "/sd/l", briefs: [{ domain: "security", path: "/sd/b" }], delta: delta ? { from: delta, files: ["f"] } : null } }),
    headOf: async () => sha(w.head),
    readFile: () => "brief",
    markLaunched: (_f, domains) => { w.launched = domains; },
    saveTestGate: () => "/sd/gate.txt",
    testGatePlan: async () => ({ clusters: 1, skill: "test-gate" }),
    runAgent: async ({ role }) => { w.agents.push(role); return { text: "FORGE:TEST_GATE:RESULT=PASS" }; },
    finalize: async () => ({ code: 0, lines: [], data: { head: sha(w.head), notes: ["- nit"], toFile: w.fixed ? [] : [{ title: "leak", severity: "HIGH" }] } }),
    fileIssue: async ({ item }) => { w.issues.push(item.title); return 100 + w.issues.length; },
    fileCiIssue: async () => 999,
    addNotes: async () => {},
    summary: async ({ filed }) => {
      const pass = w.fixed;
      w.comments.push(pass ? "<!-- FORGE:GATE_PASS -->" : "<!-- FORGE:GATE_FAILURE -->");
      return { code: pass ? 0 : 1, lines: [], data: { verdict: pass ? "APPROVE FOR DEPLOY" : "BLOCK DEPLOY", marker: pass ? "FORGE:GATE_PASS" : "FORGE:GATE_FAILURE", ciFailing: 0, filed } };
    },
    runLane: async ({ issue, lane }) => { w.lanes.push([issue, lane]); w.fixed = true; w.head++; return { terminalReason: "merged" }; },
  };
  return { w, io };
}

describe("forgedock release, review to gate (e2e on in-memory GitHub)", () => {
  it("reviews, files the blocking finding, fixes it on staging, re-reviews the delta and stops at GATE_PASS with the merge command", async () => {
    const { w, io } = world();
    const out = await runRelease({ io, repo: "o/r", root: tmpDir("rel-e2e-"), mounts: DISK, id: newReleaseId(), opts: {}, config: {}, branches: { staging: "staging", default: "main" } });
    assert.equal(out.status, "stopped");
    assert.equal(out.step, "promotion");
    assert.match(out.reason, /GATE_PASS/);
    assert.deepEqual(w.issues, ["leak"], "the finding was filed");
    assert.deepEqual(w.lanes, [[101, "staging"]], "one fix lane on the staging branch");
    assert.deepEqual(w.comments, ["<!-- FORGE:GATE_FAILURE -->", "<!-- FORGE:GATE_PASS -->"], "failure at the first head, pass after the delta review");
    assert.ok(w.agents.includes("release-review-security") && w.agents.includes("release-review-regression-risk") && w.agents.includes("release-test-gate"), "the full panel ran");
    assert.ok(w.printed.some((l) => l.includes(`--match-head-commit ${sha(2)}`)), "merge command at the fixed head");
  });

  it("a killed job resumes after the review step without re-running it", async () => {
    const { w, io } = world();
    const root = tmpDir("rel-e2e-"), id = newReleaseId();
    const args = { io, repo: "o/r", root, mounts: DISK, id, opts: {}, config: {}, branches: { staging: "staging", default: "main" } };
    await runRelease(args);
    const agents = w.agents.length;
    assert.equal(openRelease(root, id, DISK).load().steps.fixes.done, true);
    await runRelease(args);
    assert.equal(w.agents.length, agents, "review and fixes are done: nothing re-dispatched");
  });
});
