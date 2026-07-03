// bin/tests/engine.test.mjs
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIssue } from "../engine.mjs";
import { readLog, deriveState } from "../engine/runlog.mjs";
import { serializeState } from "../engine/state.mjs";

let dir; beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fd-engine-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// A scriptable fake GitHub/git world whose markers advance as phases "run".
function fakeWorld() {
  const w = { markers: "", pr: null, prMerged: false, prNeedsHuman: false,
              issueState: "OPEN", labels: [], commitsAhead: 0, body: "Issue." };
  const io = {
    gh: async (args) => {
      const a = args.join(" ");
      if (a.startsWith("api ") && a.includes("/comments")) return w.markers;
      if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: w.body });
      if (a.startsWith("issue view")) return JSON.stringify({ state: w.issueState, labels: w.labels });
      if (a.startsWith("issue edit")) { const i = args.indexOf("--body"); if (i>=0) w.body = args[i+1];
        const j = args.indexOf("--add-label"); if (j>=0) w.labels.push(args[j+1]); return ""; }
      if (a.startsWith("pr list")) return JSON.stringify(w.pr ? [{ number: w.pr }] : []);
      if (a.startsWith("pr view")) return JSON.stringify({ number: w.pr, state: w.prMerged?"MERGED":"OPEN",
        mergedAt: w.prMerged ? "t" : null, labels: w.prNeedsHuman ? [{name:"needs-human"}] : [] });
      return "";
    },
    git: async () => String(w.commitsAhead),
  };
  return { w, io };
}

describe("runIssue", () => {
  it("drives investigate→close to merged, committing every phase", async () => {
    const { w, io } = fakeWorld();
    // Each phase run advances the world so detectOutcome sees a committed result.
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate","context","architect","build","review","close"]);
    assert.equal(s.branch, "fix/pipeline-42"); // set by engine before build (see impl)
  });

  it("stops at needs-human when a phase reports blocked (no silent merge)", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE"; w.commitsAhead = 1; },
      "work-on/review": () => { w.pr = 7; w.prNeedsHuman = true; },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };
    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1 });
    assert.equal(res.terminalReason, "needs-human");
    assert.ok(w.labels.includes("needs-human"));
  });

  it("C1: commitsAhead swallows a git rejection on first build (no ref yet) and still drives build to merged", async () => {
    const { w, io } = fakeWorld();
    // Simulate the real first-build failure mode: `git rev-list origin/<lane>..<branch>`
    // rejects because the branch does not exist yet. Once the build runner has
    // actually pushed commits (w.commitsAhead > 0), git succeeds normally.
    io.git = async () => {
      if (w.commitsAhead === 0) throw new Error("fatal: unknown revision or path not in the working tree.");
      return String(w.commitsAhead);
    };
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate", "context", "architect", "build", "review", "close"]);
  });

  it("C2: hydrate reconstructs the local run-log from a populated remote FORGE:STATE, without re-running committed phases", async () => {
    const { w, io } = fakeWorld();
    const runCounts = {};
    const remoteIndex = {
      v: 4, run: "r_42_staging", issue: 42, lane: "staging",
      committed: ["investigate", "context", "architect", "build"],
      phase: "review", branch: "fix/pipeline-42", pr: null,
      terminal: false, terminalReason: null, lease: null,
    };
    w.body = serializeState(remoteIndex);
    // The remote index says build already committed; mirror that in the world so
    // review's own reconcile/detectOutcome see a consistent picture.
    w.commitsAhead = 2;
    w.markers = " INVESTIGATION:COMPLETE FORGE:CONTEXT FORGE:ARCHITECT FORGE:BUILDER:COMPLETE";

    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; },
    };
    const runner = async ({ commandName }) => {
      runCounts[commandName] = (runCounts[commandName] || 0) + 1;
      script[commandName]?.();
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    assert.equal(runCounts["work-on/investigate"] || 0, 0, "investigate must not re-run after hydrate");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate", "context", "architect", "build", "review", "close"]);
    assert.equal(s.issue, 42);
  });
});
