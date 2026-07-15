// bin/tests/engine.test.mjs
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIssue } from "../engine.mjs";
import { readLog, deriveState } from "../engine/runlog.mjs";
import { serializeState } from "../engine/state.mjs";
import { VALID_BACKENDS } from "../runner.mjs";

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
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
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
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
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
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
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

  it("I3: defers before writing GitHub state when another agent holds a valid lease (remirror path)", async () => {
    // Regression test for: writeState() called before lease check in remirror/hydrate branches.
    // A concurrent agent holds a valid lease — we must NOT write GitHub state before deferring.
    const { w, io } = fakeWorld();
    const writeStateCalls = [];
    const origGh = io.gh;
    io.gh = async (args) => {
      if (args[0] === "issue" && args[1] === "edit") writeStateCalls.push([...args]);
      return origGh(args);
    };

    // Set up a remote state with a valid lease held by agent "other-agent".
    // Local v < remote v → reconcile will return action="hydrate".
    // (For action="remirror": local v > remote v; test the remirror path by leaving local log
    // ahead — but fakeWorld starts fresh so we test "hydrate" here as primary regression.)
    const { serializeState } = await import("../engine/state.mjs");
    const remoteIndex = {
      v: 3, run: "r_42_staging", issue: 42, lane: "staging",
      committed: ["investigate", "context"], phase: "architect",
      branch: null, pr: null, terminal: false, terminalReason: null,
      lease: { by: "other-agent", until: Date.now() + 60000 },
    };
    w.body = serializeState(remoteIndex);

    const runner = async () => { throw new Error("runner must not be called when leased"); };
    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => Date.now(), maxAttempts: 1 });

    assert.equal(res.terminalReason, "deferred");
    assert.ok(res.detail.includes("other-agent"));
    // The critical invariant: no issue edit (writeState) should have been called before deferring.
    const editCalls = writeStateCalls.filter(a => a.includes("issue") && a.includes("edit"));
    assert.equal(editCalls.length, 0, "writeState must not be called before the lease guard fires");
  });

  it("I3: defers before writing GitHub state when another agent holds a valid lease (remirror path — local v > remote v)", async () => {
    // Same invariant as above but exercises the remirror code path (local ahead of remote).
    const { w, io } = fakeWorld();
    const writeStateCalls = [];
    const origGh = io.gh;
    io.gh = async (args) => {
      if (args[0] === "issue" && args[1] === "edit") writeStateCalls.push([...args]);
      return origGh(args);
    };

    const { serializeState } = await import("../engine/state.mjs");
    // Remote has a valid lease but lower v — reconcile picks local (remirror action).
    const remoteIndex = {
      v: 1, run: "r_42_staging", issue: 42, lane: "staging",
      committed: ["investigate"], phase: "context",
      branch: null, pr: null, terminal: false, terminalReason: null,
      lease: { by: "other-agent", until: Date.now() + 60000 },
    };
    w.body = serializeState(remoteIndex);

    // Build a local run-log at v=2 (ahead of remote) to trigger remirror.
    const { appendEvent } = await import("../engine/runlog.mjs");
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r_42_staging", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "context", outputs: {} });

    const runner = async () => { throw new Error("runner must not be called when leased"); };
    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => Date.now(), maxAttempts: 1 });

    assert.equal(res.terminalReason, "deferred");
    assert.ok(res.detail.includes("other-agent"));
    const editCalls = writeStateCalls.filter(a => a.includes("issue") && a.includes("edit"));
    assert.equal(editCalls.length, 0, "writeState must not be called before the lease guard fires");
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
    w.markers = " INVESTIGATION:COMPLETE FORGE:CONTEXT:COMPLETE FORGE:ARCHITECT:COMPLETE FORGE:BUILDER:COMPLETE";

    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
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

  it("R1: context.reconcile short-circuits when FORGE:CONTEXT already present (no LLM re-run)", async () => {
    // Crash-injection: simulate a resume where context already completed (FORGE:CONTEXT present)
    // but only investigate is in the committed list. context.reconcile should fire and skip the LLM.
    const { w, io } = fakeWorld();
    w.markers = " INVESTIGATION:COMPLETE FORGE:CONTEXT:COMPLETE";
    const runCounts = {};

    // Pre-populate local log with investigate committed (crash happened after context LLM ran
    // and posted its marker, but before PHASE_COMMIT was written).
    const { appendEvent } = await import("../engine/runlog.mjs");
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r_42_staging", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });

    const script = {
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
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
    assert.equal(runCounts["work-on/build/context"] || 0, 0, "context must not re-run when FORGE:CONTEXT present");
    const s = deriveState(readLog(dir, 42));
    assert.ok(s.committed.includes("context"), "context must be in committed after reconcile");
  });

  it("R2: architect.reconcile short-circuits when FORGE:ARCHITECT already present (no LLM re-run)", async () => {
    // Crash-injection: resume where architect already completed (FORGE:ARCHITECT present)
    // but only investigate+context are committed. architect.reconcile should fire and skip LLM.
    const { w, io } = fakeWorld();
    w.markers = " INVESTIGATION:COMPLETE FORGE:CONTEXT:COMPLETE FORGE:ARCHITECT:COMPLETE";
    const runCounts = {};

    const { appendEvent } = await import("../engine/runlog.mjs");
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r_42_staging", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "context", outputs: {} });

    const script = {
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
    assert.equal(runCounts["work-on/build/architect"] || 0, 0, "architect must not re-run when FORGE:ARCHITECT present");
    const s = deriveState(readLog(dir, 42));
    assert.ok(s.committed.includes("architect"), "architect must be in committed after reconcile");
  });

  it("R3: close.reconcile short-circuits when issue already closed (no LLM re-run)", async () => {
    // Crash-injection: resume where close already ran (issue CLOSED) but only
    // investigate+context+architect+build+review are committed. close.reconcile should fire.
    const { w, io } = fakeWorld();
    w.markers = " INVESTIGATION:COMPLETE FORGE:CONTEXT:COMPLETE FORGE:ARCHITECT:COMPLETE FORGE:BUILDER:COMPLETE";
    w.commitsAhead = 2;
    w.pr = 7;
    w.prMerged = true;
    w.issueState = "CLOSED";
    const runCounts = {};

    const { appendEvent } = await import("../engine/runlog.mjs");
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r_42_staging", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "context", outputs: {} });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "architect", outputs: {} });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "build", outputs: { branch: "fix/pipeline-42" } });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "review", outputs: { pr: 7 } });

    const runner = async ({ commandName }) => {
      runCounts[commandName] = (runCounts[commandName] || 0) + 1;
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    assert.equal(runCounts["work-on/close"] || 0, 0, "close must not re-run when issue already CLOSED");
    const s = deriveState(readLog(dir, 42));
    assert.ok(s.committed.includes("close"), "close must be in committed after reconcile");
  });

  it("forge#2028: forwards an explicit backend/model override to every runner() call", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
    };
    const calls = [];
    const runner = async (call) => {
      calls.push(call);
      script[call.commandName]?.();
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1, backend: "cli", model: "claude-test-model" });

    assert.equal(res.terminalReason, "needs-human"); // only investigate scripted → subsequent phases block
    assert.ok(calls.length > 0, "runner must have been called at least once");
    for (const call of calls) {
      assert.equal(call.backend, "cli", "backend must be forwarded to every runner() call");
      assert.equal(call.model, "claude-test-model", "model must be forwarded to every runner() call");
    }
  });

  it("forge#2028: omitting backend/model preserves the existing runner() call shape (no new keys)", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; },
    };
    const calls = [];
    const runner = async (call) => {
      calls.push(call);
      script[call.commandName]();
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    assert.ok(calls.length > 0, "runner must have been called at least once");
    for (const call of calls) {
      assert.ok(!("backend" in call), "backend key must be absent from runner() call when not supplied to runIssue");
      assert.ok(!("model" in call), "model key must be absent from runner() call when not supplied to runIssue");
      assert.deepEqual(Object.keys(call).sort(), ["args", "commandName", "commandsDir"].sort());
    }
  });

  it("forge#2054: an invalid backend fails fast with a coded, non-retryable error instead of being retried", async () => {
    const { io } = fakeWorld();
    const calls = [];
    const runner = async (call) => { calls.push(call); return { status: "complete" }; };

    await assert.rejects(
      () => runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 3, backend: "nonsense" }),
      (err) => {
        assert.equal(err.code, "INVALID_BACKEND");
        assert.match(err.message, /Invalid backend "nonsense"/);
        return true;
      },
    );

    // Must fail before any phase attempt — no PHASE_START event, no runner() call at all.
    assert.equal(calls.length, 0, "runner() must never be called for an invalid backend");
    const events = readLog(dir, 42);
    assert.ok(!events.some((e) => e.event === "PHASE_START"),
      "no PHASE_START event should be appended — the invalid backend must be rejected before the retry loop");
  });

  it("forge#2054: backend undefined (no override) and valid values are unaffected by the new check", async () => {
    for (const [i, backend] of [undefined, "cli", "api", "auto"].entries()) {
      // Distinct issue number + fresh subdir per iteration so each run starts
      // from a clean run-log (dir/readLog is keyed by issue number on disk).
      const issue = 100 + i;
      const { w, io } = fakeWorld();
      const script = { "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; } };
      const runner = async (call) => { script[call.commandName]?.(); return { status: "complete" }; };

      const res = await runIssue({ issue, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1, ...(backend ? { backend } : {}) });

      // Reaches the normal phase-driving path (blocks on needs-human because only
      // investigate is scripted) rather than rejecting synchronously.
      assert.equal(res.terminalReason, "needs-human", `backend=${backend} must not be rejected`);
    }
  });

  it("forge#2076: engine.mjs's accepted backends track runner.mjs's exported VALID_BACKENDS (no independent copy)", async () => {
    // Guards against re-introducing the duplicate-Set drift fixed in forge#2076:
    // engine.mjs must import VALID_BACKENDS from runner.mjs rather than
    // hardcoding its own copy. Iterating the imported set (rather than a
    // literal ["cli","api","auto"] in this test) means the test fails if the
    // two sources ever diverge again, regardless of which values they contain.
    for (const [i, backend] of [...VALID_BACKENDS].entries()) {
      const issue = 200 + i;
      const { w, io } = fakeWorld();
      const script = { "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; } };
      const runner = async (call) => { script[call.commandName]?.(); return { status: "complete" }; };

      const res = await runIssue({ issue, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1, backend });

      assert.equal(res.terminalReason, "needs-human",
        `backend=${backend} (from runner.mjs's VALID_BACKENDS) must be accepted by engine.mjs`);
    }

    // A value outside runner.mjs's exported set must still be rejected.
    const bogus = "definitely-not-a-real-backend";
    assert.ok(!VALID_BACKENDS.has(bogus), "test precondition: bogus value must not collide with a real backend");
    const { io } = fakeWorld();
    const runner = async () => ({ status: "complete" });
    await assert.rejects(
      () => runIssue({ issue: 999, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1, backend: bogus }),
      (err) => { assert.equal(err.code, "INVALID_BACKEND"); return true; },
    );
  });
});
