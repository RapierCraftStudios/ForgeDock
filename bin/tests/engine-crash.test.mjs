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
              prCreateCount: 0, buildRuns: 0, crashAtPrView: Infinity, prViewCalls: 0,
              commentCalls: 0, crashAtComments: Infinity,
              // Comments calls that occur once build's runner has already executed
              // (w.buildRuns > 0). The FIRST such call is guaranteed to be build's
              // own detectOutcome — no other phase's reconcile/detectOutcome runs
              // between build's runner returning and build's detectOutcome firing
              // (see engine.mjs's runPhaseWithRetry). This channel stays correct
              // regardless of how many comments calls earlier phases make.
              postBuildCommentCalls: 0, crashAtPostBuildComments: Infinity };
  const io = {
    gh: async (args) => {
      const a = args.join(" ");
      if (a.includes("/comments")) {
        w.commentCalls++;
        // Scoped channel: count and optionally crash BEFORE the legacy channel
        // so postBuildCommentCalls is always accurate even if both channels are
        // ever co-armed. (Currently mutual-exclusive — no scenario arms both —
        // but hoisting the counter makes the invariant hold programmatically.)
        if (w.buildRuns > 0) {
          w.postBuildCommentCalls++;
          if (w.postBuildCommentCalls === w.crashAtPostBuildComments) {
            w.crashAtPostBuildComments = Infinity;
            throw new Error("CRASH mid-phase (comments, post-build)");
          }
        }
        if (w.commentCalls === w.crashAtComments) { w.crashAtComments = Infinity; throw new Error("CRASH mid-phase (comments)"); }
        return w.markers;
      }
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
      case "work-on/build/context": w.markers += " FORGE:CONTEXT FORGE:CONTEXT:COMPLETE"; break;
      case "work-on/build/architect": w.markers += " FORGE:ARCHITECT FORGE:ARCHITECT:COMPLETE"; break;
      // The Branch marker mirrors the real `**Branch**: `{BRANCH}`` field the
      // FORGE:BUILDER comment always reports (implement.md Phase I6) — the
      // engine now resolves the build branch from this ground truth instead
      // of a guessed default (forge#2174), so the mock must emit it too.
      case "work-on/build": w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; w.buildRuns++; break;
      // Idempotent review runner: adopts an existing PR instead of creating a
      // second one on resume, so a duplicate-create would be observable via
      // prCreateCount instead of being silently masked by `w.pr = 7`.
      case "work-on/review":
        w.reviewRuns++;
        if (!w.pr) { w.prCreateCount++; w.pr = 7; w.prMerged = true; }
        break;
      case "work-on/close": w.issueState = "CLOSED"; w.labels.push("workflow:merged"); break;
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
    // Post-C1, commitsAhead() (bin/engine/phases.mjs) swallows a git rejection and
    // returns 0 rather than throwing — a deliberate hardening (first-build has no
    // ref yet) that also means an injected git-call crash no longer escapes
    // detectOutcome; it now resolves as a same-run retry instead of a process
    // death. So the mid-phase kill is injected on the gh "comments" call inside
    // build.detectOutcome instead — but a hardcoded absolute call count (e.g.
    // "call #4") is brittle: investigate/context/architect's reconcile+detectOutcome
    // hooks also share the "/comments" channel, so any engine change that adds or
    // removes a comments call in an earlier phase silently shifts which call number
    // lands inside build's detectOutcome (this is exactly what happened here: the
    // count drifted from 4 to 6 and the injected crash landed in architect's
    // reconcile instead, which engine.mjs swallows — see engine.mjs's `catch {
    // reconciled = { satisfied: false } }` around phase.reconcile — so no crash
    // ever fired). Instead, crash on the FIRST "/comments" call that occurs AFTER
    // build's runner has executed (w.buildRuns > 0): no other phase's reconcile or
    // detectOutcome runs between build's runner returning and build's own
    // detectOutcome firing, so this call is always build's detectOutcome — a
    // channel uniquely owned by build's detectOutcome, mirroring how the sibling
    // review test uses crashAtPrView.
    w.crashAtPostBuildComments = 1;
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

describe("crash injection: forge#2184 comment-scoped last-match resume semantics", () => {
  // makeWorld() above models the `.../comments` endpoint as one concatenated
  // string blob (`w.markers`). issueMarkers() (bin/engine/phases.mjs) can only
  // build its per-comment `comments` array from a genuine JSON array response;
  // against a raw-string blob its JSON.parse fails and it falls back to a
  // single one-element pseudo-comment, which makes "last comment wins" and
  // "first regex match within that one blob" indistinguishable. That fallback
  // is exactly the coverage gap this issue flags (review finding on PR #2182)
  // — so this scenario needs its own world whose comments endpoint returns a
  // real JSON array of distinct comment bodies, preserving comment boundaries
  // the way the real `gh api .../comments --jq "[.[].body]"` call does.
  function makeMultiCommentWorld() {
    const w = { comments: [], pr: null, prMerged: false, issueState: "OPEN", labels: [],
                commitsAheadByBranch: {}, body: "Issue." };
    const io = {
      gh: async (args) => {
        const a = args.join(" ");
        if (a.includes("/comments")) return JSON.stringify(w.comments);
        if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: w.body });
        if (a.startsWith("issue view")) return JSON.stringify({ state: w.issueState, labels: w.labels });
        if (a.startsWith("issue edit")) {
          const bi = args.indexOf("--body"); if (bi >= 0) w.body = args[bi + 1];
          const li = args.indexOf("--add-label"); if (li >= 0) w.labels.push(args[li + 1]);
          return "";
        }
        if (a.startsWith("pr list")) return JSON.stringify(w.pr ? [{ number: w.pr }] : []);
        if (a.startsWith("pr view")) return JSON.stringify({ number: w.pr,
          state: w.prMerged ? "MERGED" : "OPEN", mergedAt: w.prMerged ? "t" : null, labels: [] });
        return "";
      },
      git: async (args) => {
        const range = args[args.length - 1] || "";
        const branch = range.split("..")[1] || "";
        return String(w.commitsAheadByBranch[branch] || 0);
      },
    };
    return { w, io };
  }

  it("a stale FORGE:BUILDER:COMPLETE comment left by a crashed prior attempt does not win over the resumed run's fresh completion comment", async () => {
    // Simulates exactly the scenario this issue calls out: a previous session
    // crashed AFTER posting its own FORGE:BUILDER:COMPLETE comment (naming a
    // branch that, in the end, never received real commits — e.g. the crash
    // happened before the builder's commit step) but BEFORE the engine's local
    // PHASE_COMMIT for "build" was appended. On resume, investigate/context/
    // architect are already committed locally; the engine re-enters "build",
    // whose runner completes normally this time and posts a SECOND, fresh
    // FORGE:BUILDER:COMPLETE comment naming a different (real, committed-to)
    // branch. The engine must resolve the LAST eligible comment — the fresh
    // one — not the stale leftover from the crashed attempt.
    const { w, io } = makeMultiCommentWorld();
    const STALE_BRANCH = "fix/crashed-attempt-42";
    const REAL_BRANCH = "fix/resumed-real-branch-42";
    w.commitsAheadByBranch[STALE_BRANCH] = 0;

    // Pre-seed the world as if a prior (crashed) session already posted its
    // own investigate/context/architect/stale-build markers before dying.
    w.comments.push("INVESTIGATION:COMPLETE");
    w.comments.push("FORGE:CONTEXT:COMPLETE");
    w.comments.push("FORGE:ARCHITECT:COMPLETE");
    w.comments.push(`FORGE:BUILDER:COMPLETE **Branch**: \`${STALE_BRANCH}\``);

    // Pre-seed the local run-log to match: investigate/context/architect
    // already committed locally (mirrors the crashed session having gotten
    // that far before dying), "build" not yet committed.
    const { appendEvent } = await import("../engine/runlog.mjs");
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r_42_staging", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "context", outputs: {} });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "architect", outputs: {} });

    const script = {
      "work-on/build": () => {
        // The resumed run's own build attempt completes and posts a fresh
        // completion comment naming a different, real branch.
        w.comments.push(`FORGE:BUILDER:COMPLETE **Branch**: \`${REAL_BRANCH}\``);
        w.commitsAheadByBranch[REAL_BRANCH] = 2;
      },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged",
      "resumed run must merge on the fresh/real branch, not escalate on the crashed attempt's stale branch");
    const s = deriveState(readLog(dir, 42));
    assert.equal(s.branch, REAL_BRANCH,
      "resolved branch must be the LAST FORGE:BUILDER:COMPLETE comment (this run's), not the crashed prior attempt's");
  });
});
