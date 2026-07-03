/**
 * bin/tests/engine-crash.test.mjs
 *
 * Crash-injection durability proof for the engine (spec §9).
 *
 * IMPORTANT — why the crash is NOT injected from the runner:
 *   runPhaseWithRetry() CATCHES a thrown runner as a retryable PHASE_FAILED and
 *   retries in-run, so a runner throw never simulates a process death (it either
 *   completes in one run or escalates to needs-human). A real "process died"
 *   must be injected at a point runIssue does NOT internally catch:
 *     - projector.writeState (the GitHub FORGE:STATE mirror, engine.mjs:53) —
 *       fires AFTER the local PHASE_COMMIT is durably appended (engine.mjs:50),
 *       so resume must continue from the local run-log; and
 *     - phase.detectOutcome (engine.mjs:81) — fires AFTER the runner's side
 *       effect but BEFORE the commit, so the phase must re-run idempotently.
 *   Both propagate out of runIssue; a supervisor re-launches it and it resumes.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIssue } from "../engine.mjs";
import { readLog, deriveState } from "../engine/runlog.mjs";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fd-crash-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ALL = ["investigate", "context", "architect", "build", "review", "close"];

// A scriptable fake GitHub/git world. State persists across runIssue relaunches
// within one scenario (that is what makes resume observable). A one-shot crash is
// armed via crashAtEdit (Nth FORGE:STATE mirror write) or crashAtGit (Nth git call).
function makeWorld() {
  const w = { markers: "", pr: null, prMerged: false, issueState: "OPEN", labels: [],
              commitsAhead: 0, body: "Issue.", editCalls: 0, gitCalls: 0,
              crashAtEdit: Infinity, crashAtGit: Infinity, reviewRuns: 0,
              prCreateCount: 0, buildRuns: 0, crashAtPrView: Infinity, prViewCalls: 0 };
  const io = {
    gh: async (args) => {
      const a = args.join(" ");
      if (a.includes("/comments")) return w.markers;
      if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: w.body });
      if (a.startsWith("issue view")) return JSON.stringify({ state: w.issueState, labels: w.labels });
      if (a.startsWith("issue edit")) {
        const bi = args.indexOf("--body");
        const li = args.indexOf("--add-label");
        if (bi >= 0) {
          w.editCalls++;
          if (w.editCalls === w.crashAtEdit) { w.crashAtEdit = Infinity; throw new Error("CRASH during FORGE:STATE mirror"); }
          w.body = args[bi + 1];
        }
        if (li >= 0) w.labels.push(args[li + 1]);
        return "";
      }
      if (a.startsWith("pr list")) return JSON.stringify(w.pr ? [{ number: w.pr }] : []);
      if (a.startsWith("pr view")) {
        w.prViewCalls++;
        if (w.prViewCalls === w.crashAtPrView) { w.crashAtPrView = Infinity; throw new Error("CRASH mid-review (pr view)"); }
        return JSON.stringify({ number: w.pr, state: w.prMerged ? "MERGED" : "OPEN", mergedAt: w.prMerged ? "t" : null, labels: [] });
      }
      return "";
    },
    git: async () => {
      w.gitCalls++;
      if (w.gitCalls === w.crashAtGit) { w.crashAtGit = Infinity; throw new Error("CRASH mid-phase (git)"); }
      return String(w.commitsAhead);
    },
  };
  const runner = async ({ commandName }) => {
    switch (commandName) {
      case "work-on/investigate": w.markers += " INVESTIGATION:COMPLETE"; break;
      case "work-on/build/context": w.markers += " FORGE:CONTEXT"; break;
      case "work-on/build/architect": w.markers += " FORGE:ARCHITECT"; break;
      case "work-on/build": w.markers += " FORGE:BUILDER:COMPLETE"; w.commitsAhead = 2; w.buildRuns++; break;
      // Idempotent review runner: adopts an existing PR instead of creating a
      // second one on resume, so a duplicate-create would be observable via
      // prCreateCount instead of being silently masked by `w.pr = 7`.
      case "work-on/review":
        w.reviewRuns++;
        if (!w.pr) { w.prCreateCount++; w.pr = 7; w.prMerged = true; }
        break;
      case "work-on/close": w.issueState = "CLOSED"; break;
    }
    return { status: "complete" };
  };
  return { w, io, runner };
}

// Re-launch runIssue like a supervisor re-spawning a killed process. The run-log
// on disk persists between relaunches; a clean run returns without throwing.
// Returns { res, launches } so tests can assert a crash actually fired (launches >= 2),
// guarding against a false-positive test that never exercises resume.
async function runToCompletion({ dir, io, runner }) {
  for (let i = 1; i <= 20; i++) {
    try {
      const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1 });
      return { res, launches: i };
    } catch (e) {
      // Only swallow the INJECTED crash (simulated process death); anything else
      // is a real bug and must surface, not be masked as "needs another relaunch".
      if (!/CRASH/.test(e.message)) throw e;
    }
  }
  throw new Error("did not complete within 20 relaunches");
}

function assertCleanMerge(w) {
  const events = readLog(dir, 42);
  const s = deriveState(events);
  assert.equal(new Set(s.committed).size, s.committed.length, "no phase committed twice");
  assert.deepEqual([...s.committed].sort(), [...ALL].sort(), "all phases committed");
  assert.equal(w.pr, 7, "exactly one PR");
  assert.equal(w.prCreateCount, 1, "exactly one PR ever created across the whole scenario");

  // deriveState dedupes committed phases (`if (!s.committed.includes(...))`), so
  // "committed once" via deriveState cannot detect a duplicate PHASE_COMMIT append
  // for the same phase. Assert directly on the RAW run-log events instead.
  const commitsByPhase = {};
  for (const e of events) {
    if (e.event !== "PHASE_COMMIT") continue;
    commitsByPhase[e.phase] = (commitsByPhase[e.phase] || 0) + 1;
  }
  for (const phase of ALL) {
    assert.equal(commitsByPhase[phase], 1, `raw run-log has exactly one PHASE_COMMIT for '${phase}' (got ${commitsByPhase[phase] || 0})`);
  }
  return s;
}

describe("crash injection: resume from the durable run-log", () => {
  // Kill the process during the GitHub mirror (after the local PHASE_COMMIT) at
  // every write point across the run. A clean run performs 8 body writes
  // (initial state + 6 phase commits + terminate); each is a distinct crash point.
  for (let editN = 1; editN <= 8; editN++) {
    it(`resumes to merged when killed on mirror write #${editN}`, async () => {
      const { w, io, runner } = makeWorld();
      w.crashAtEdit = editN;
      const { res, launches } = await runToCompletion({ dir, io, runner });
      assert.ok(launches >= 2, `crash must fire and require resume (launches=${launches})`);
      assert.equal(res.terminalReason, "merged");
      assertCleanMerge(w);
    });
  }

  it("re-runs a phase idempotently when killed mid-phase (build), no duplicate commit", async () => {
    const { w, io, runner } = makeWorld();
    // build makes two git (commitsAhead) calls: reconcile pre-run (call #1 -> 0 ahead,
    // not satisfied) then detectOutcome post-run (call #2 -> 2 ahead). Killing on git
    // call #2 dies AFTER build's side effect (marker + commits) but BEFORE its commit.
    w.crashAtGit = 2;
    const { res, launches } = await runToCompletion({ dir, io, runner });
    assert.ok(launches >= 2, `mid-phase crash must fire and require resume (launches=${launches})`);
    assert.equal(res.terminalReason, "merged");
    const s = assertCleanMerge(w);
    assert.equal(s.committed.filter((p) => p === "build").length, 1, "build committed exactly once");
  });

  it("re-runs review idempotently when killed mid-phase (pr view), no duplicate PR", async () => {
    const { w, io, runner } = makeWorld();
    // review.detectOutcome calls prStatusFor -> io.gh(["pr","view",...]), which is
    // used ONLY by review's detectOutcome and fires AFTER the runner already
    // created the PR. Killing on pr-view call #1 dies after the runner's side
    // effect (PR created) but before review's PHASE_COMMIT — the real
    // duplicate-PR path. Resume must re-enter review, adopt the existing PR via
    // the idempotent runner (not create a second one), and commit exactly once.
    w.crashAtPrView = 1;
    const { res, launches } = await runToCompletion({ dir, io, runner });
    assert.ok(launches >= 2, `mid-review crash must fire and require resume (launches=${launches})`);
    assert.equal(res.terminalReason, "merged");
    assertCleanMerge(w);
  });
});
