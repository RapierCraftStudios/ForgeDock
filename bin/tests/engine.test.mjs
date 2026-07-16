// bin/tests/engine.test.mjs
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runIssue } from "../engine.mjs";
import { readLog, deriveState } from "../engine/runlog.mjs";
import { serializeState } from "../engine/state.mjs";
import { VALID_BACKENDS } from "../runner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      // The Branch marker mirrors the real `**Branch**: `{BRANCH}`` field the
      // FORGE:BUILDER comment always reports (implement.md Phase I6) — the
      // engine resolves the build branch from this ground truth, never from
      // a guessed default (forge#2174).
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate","context","architect","build","review","close"]);
    // forge#2174: branch must be the real, ground-truth branch parsed from the
    // FORGE:BUILDER comment — never a guessed default the engine invented.
    assert.equal(s.branch, "fix/real-branch-42");
  });

  it("stops at needs-human when a phase reports blocked (no silent merge)", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 1; },
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
      // The Branch marker mirrors the real `**Branch**: `{BRANCH}`` field the
      // FORGE:BUILDER comment always reports (implement.md Phase I6) — the
      // engine resolves the build branch from this ground truth, never from
      // a guessed default (forge#2174).
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
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

  it("forge#2174: build commits when the builder's real (slug-derived) branch has commits, even though a naively-guessed default branch name never existed", async () => {
    // Regression test for the exact reported bug: the engine used to precompute
    // a guessed branch name (`fix/pipeline-{issue}`) that never matched the real,
    // slug-derived branch the builder actually creates (`fix/{slug}-{issue}`,
    // per commands/work-on/build.md Phase B1A). git only recognizes the REAL
    // branch here — any rev-list against the old guessed name would reject.
    // The build phase must resolve the branch from the FORGE:BUILDER comment
    // (ground truth) and drive to merged.
    const { w, io } = fakeWorld();
    const REAL_BRANCH = "fix/role-arn-unbounded-error-msg-42";
    io.git = async (args) => {
      const range = args[args.indexOf("--count") + 1] || "";
      if (range.endsWith(`..${REAL_BRANCH}`)) return String(w.commitsAhead);
      // Any other ref (e.g. a guessed "fix/pipeline-42") does not exist.
      throw new Error("fatal: unknown revision or path not in the working tree.");
    };
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += ` FORGE:BUILDER:COMPLETE **Branch**: \`${REAL_BRANCH}\``; w.commitsAhead = 1; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate", "context", "architect", "build", "review", "close"]);
    assert.equal(s.branch, REAL_BRANCH, "resolved branch must be the real, ground-truth branch, not a guess");
  });

  it("forge#2174: a genuinely empty build (builder complete, zero real commits) still fails the gate", async () => {
    const { w, io } = fakeWorld();
    const REAL_BRANCH = "fix/some-real-branch-42";
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      // Builder reports complete and even names a real branch, but never actually
      // committed anything — commitsAhead stays 0 (w.commitsAhead is never bumped).
      "work-on/build": () => { w.markers += ` FORGE:BUILDER:COMPLETE **Branch**: \`${REAL_BRANCH}\``; },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1 });

    assert.equal(res.terminalReason, "needs-human", "zero real commits must still escalate, not silently merge");
    const s = deriveState(readLog(dir, 42));
    assert.ok(!s.committed.includes("build"), "build must not be marked committed with zero real commits");
  });

  it("forge#2176: a builder-complete/zero-commits fixed point does not consume a third attempt (non-retryable)", async () => {
    // Regression for the issue's core complaint: `reason: "builder complete=true
    // commitsAhead=0"` repeating byte-identically across attempts must NOT burn
    // the full maxAttempts budget. The builder's own idempotent early-exit
    // (commands/work-on/build.md's BUILD_RESULT: status: ALREADY_DONE) guarantees
    // this state is a fixed point — retrying can never change it — so the build
    // phase's detectOutcome now marks it retryable: false, and the engine must
    // honor that by stopping after exactly 1 attempt even when maxAttempts: 3.
    const { w, io } = fakeWorld();
    const REAL_BRANCH = "fix/some-real-branch-42";
    let buildRunnerCalls = 0;
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      // Builder reports complete on every invocation (mirrors the real builder's
      // BUILD_RESULT: status: ALREADY_DONE early-exit) but never commits anything
      // new — commitsAhead stays 0 no matter how many times this runs.
      "work-on/build": () => {
        buildRunnerCalls++;
        w.markers += ` FORGE:BUILDER:COMPLETE **Branch**: \`${REAL_BRANCH}\``;
      },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "needs-human", "fixed-point build failure must still escalate");
    assert.equal(buildRunnerCalls, 1,
      "the build runner must be invoked exactly once — retryable:false must stop the loop before attempt 2");
    const events = readLog(dir, 42);
    const buildStarts = events.filter((e) => e.event === "PHASE_START" && e.phase === "build");
    const buildFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "build");
    assert.equal(buildStarts.length, 1, "only 1 PHASE_START for build — not 3");
    assert.equal(buildFailures.length, 1, "only 1 PHASE_FAILED for build — not 3");
  });

  it("forge#2176: a transient git error during commitsAhead (not a genuine zero) stays retryable", async () => {
    // Regression for a review finding on #2176: commitsAhead() previously folded
    // BOTH a genuine "0 commits ahead" AND a transient git failure (lock
    // contention, unfetched ref, I/O hiccup) into the same 0 value. If the build
    // phase treated every commitsAhead()===0 as the non-retryable fixed point,
    // a merely transient git error would wrongly escalate to needs-human after
    // just 1 attempt instead of getting the retries it previously — and still
    // should — get. commitsAhead() now returns -1 (not 0) when git itself
    // throws, and detectOutcome must NOT set retryable:false in that case.
    const { w, io } = fakeWorld();
    const REAL_BRANCH = "fix/some-real-branch-42";
    let buildRunnerCalls = 0;
    io.git = async () => { throw new Error("fatal: unable to read current working directory: Device or resource busy"); };
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => {
        buildRunnerCalls++;
        w.markers += ` FORGE:BUILDER:COMPLETE **Branch**: \`${REAL_BRANCH}\``;
      },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "needs-human", "still escalates once transient retries are exhausted");
    assert.equal(buildRunnerCalls, 3,
      "a transient git error (commitsAhead returning -1) must NOT set retryable:false — all 3 attempts must run");
    const events = readLog(dir, 42);
    const buildFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "build");
    assert.equal(buildFailures.length, 3, "all 3 attempts must be logged — transient git errors keep retrying");
  });

  it("forge#2211: an unresolved branch (FORGE:BUILDER:COMPLETE present, no Branch marker) stays retryable, not a synthesized fixed point", async () => {
    // Regression for a review finding on PR #2204: detectOutcome used to
    // synthesize `ahead = 0` when resolveBranch() returned null (branch not
    // yet resolvable — e.g. first build attempt, no **Branch**: `x` marker
    // posted yet, and state.branch not carried forward from a prior commit).
    // That synthesized 0 was indistinguishable from a genuine, git-confirmed
    // zero and wrongly tripped the `ahead !== -1` non-retryable guard after a
    // single attempt. An unresolved branch must map to the same "not computed"
    // sentinel (-1) that a transient git error already uses, so this stays
    // retryable and consumes the full attempt budget.
    const { w, io } = fakeWorld();
    let buildRunnerCalls = 0;
    let gitCalls = 0;
    io.git = async () => { gitCalls++; return String(w.commitsAhead); };
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      // Builder reports complete but never names a branch (no **Branch**: `x`
      // marker) — resolveBranch() must return null since state.branch is also
      // never set by a prior PHASE_COMMIT in this scenario.
      "work-on/build": () => {
        buildRunnerCalls++;
        w.markers += " FORGE:BUILDER:COMPLETE";
      },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "needs-human", "still escalates once retries are exhausted");
    assert.equal(buildRunnerCalls, 3,
      "an unresolved branch must NOT set retryable:false — all 3 attempts must run, not just 1");
    assert.equal(gitCalls, 0, "commitsAhead() must never be called when the branch could not be resolved");
    const events = readLog(dir, 42);
    const buildFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "build");
    assert.equal(buildFailures.length, 3, "all 3 attempts must be logged — unresolved branch keeps retrying");
  });

  it("forge#2176 (AC4): a phase that does not opt into retryable:false still retries to maxAttempts (transient failures unaffected)", async () => {
    // Guard against over-generalizing the retryable mechanism: the review
    // phase's "PR open, not merged" detail can legitimately repeat identically
    // across attempts while a merge is still in flight — it must keep retrying
    // exactly as before, since its detectOutcome never sets retryable: false.
    const { w, io } = fakeWorld();
    let reviewRunnerCalls = 0;
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      // PR exists but never merges — "PR open, not merged" repeats identically
      // on every attempt, exactly like the pre-#2176 build-phase symptom, but
      // this phase has NOT opted into retryable:false so it must keep retrying.
      "work-on/review": () => { reviewRunnerCalls++; w.pr = 7; w.prMerged = false; },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "needs-human", "unmerged PR after exhausting attempts still escalates");
    assert.equal(reviewRunnerCalls, 3,
      "the review runner must be invoked for all 3 attempts — no retryable:false signal means unchanged behavior");
    const events = readLog(dir, 42);
    const reviewFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "review");
    assert.equal(reviewFailures.length, 3, "all 3 attempts must be logged — transient retry behavior unchanged");
  });

  it("forge#2259: CLI_BACKEND_FAILED thrown by the runner fails fast on attempt 1, not retried to maxAttempts", async () => {
    // Regression for #2244: a deterministic non-zero exit from the nested
    // `claude` CLI (bin/runner.mjs's runCliBackend() throws with
    // err.code = "CLI_BACKEND_FAILED" — see bin/tests/runner.test.mjs's own
    // "propagates a non-zero exit status ... as CLI_BACKEND_FAILED" test for
    // the exact shape) reproduces identically on every attempt. It must be
    // rethrown immediately, exactly like NO_API_KEY/NO_SDK, instead of
    // burning all `maxAttempts` retries on a guaranteed-repeat failure.
    const { w, io } = fakeWorld();
    let architectRunnerCalls = 0;
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => {
        architectRunnerCalls++;
        throw Object.assign(new Error("claude CLI exited with status 1"), { code: "CLI_BACKEND_FAILED" });
      },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    await assert.rejects(
      () => runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 3 }),
      (err) => err.code === "CLI_BACKEND_FAILED",
      "runIssue must propagate CLI_BACKEND_FAILED uncaught, not swallow it into a needs-human terminal result",
    );
    assert.equal(architectRunnerCalls, 1,
      "the architect runner must be invoked exactly once — CLI_BACKEND_FAILED must not be retried");
    const events = readLog(dir, 42);
    const architectFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "architect");
    assert.equal(architectFailures.length, 0,
      "no PHASE_FAILED event should be logged for a fail-fast rethrow — it never reaches the retry bookkeeping, matching NO_API_KEY/NO_SDK");
  });

  it("forge#2259: other error codes (and uncoded errors) from the runner still retry to maxAttempts, unaffected by the CLI_BACKEND_FAILED fail-fast", async () => {
    const { w, io } = fakeWorld();
    let architectRunnerCalls = 0;
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => {
        architectRunnerCalls++;
        throw new Error("transient network blip");
      },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "needs-human", "an uncoded transient error still escalates after exhausting attempts");
    assert.equal(architectRunnerCalls, 3,
      "an uncoded error (no .code, or a code other than NO_API_KEY/NO_SDK/CLI_BACKEND_FAILED) must retry all 3 attempts unchanged");
    const events = readLog(dir, 42);
    const architectFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "architect");
    assert.equal(architectFailures.length, 3, "all 3 attempts must be logged for a genuinely retryable error");
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
      // The Branch marker mirrors the real `**Branch**: `{BRANCH}`` field the
      // FORGE:BUILDER comment always reports (implement.md Phase I6) — the
      // engine resolves the build branch from this ground truth, never from
      // a guessed default (forge#2174).
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
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
      // The Branch marker mirrors the real `**Branch**: `{BRANCH}`` field the
      // FORGE:BUILDER comment always reports (implement.md Phase I6) — the
      // engine resolves the build branch from this ground truth, never from
      // a guessed default (forge#2174).
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
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
      // The Branch marker mirrors the real `**Branch**: `{BRANCH}`` field the
      // FORGE:BUILDER comment always reports (implement.md Phase I6) — the
      // engine resolves the build branch from this ground truth, never from
      // a guessed default (forge#2174).
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
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
      // The Branch marker mirrors the real `**Branch**: `{BRANCH}`` field the
      // FORGE:BUILDER comment always reports (implement.md Phase I6) — the
      // engine resolves the build branch from this ground truth, never from
      // a guessed default (forge#2174).
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
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

  it("forge#2079/#2075: VALID_BACKENDS is the read-only runner.mjs singleton, not a diverged local copy", () => {
    // #2079: the forge#2076 test above only asserts value-equivalence (it
    // iterates [...VALID_BACKENDS]), so it would still pass if engine.mjs
    // reintroduced its own hardcoded `new Set(["cli","api","auto"])` with
    // identical literal values — the drift-elimination fix would silently
    // regress. This test closes that gap two ways:
    //
    // 1. Mutation must actually be blocked (issue #2075). Note this is
    //    deliberately NOT an Object.isFrozen() check: Object.freeze() does
    //    NOT prevent Set mutation (add/delete/clear operate on an internal
    //    slot, not on own properties, so a frozen Set still silently
    //    accepts .add() — see runner.mjs's readOnlySet() comment). The only
    //    reliable proof that this is the protected singleton is that
    //    mutating it actually throws.
    assert.throws(() => VALID_BACKENDS.add("bogus-backend"), TypeError,
      "mutating VALID_BACKENDS must throw (issue #2075) — a fresh, " +
      "unprotected local copy in a consumer would silently accept this instead");
    assert.throws(() => VALID_BACKENDS.delete("cli"), TypeError,
      "deleting from VALID_BACKENDS must throw (issue #2075)");
    assert.equal(VALID_BACKENDS.size, 3,
      "VALID_BACKENDS contents must be unchanged after the rejected mutation attempts");
    assert.deepEqual([...VALID_BACKENDS].sort(), ["api", "auto", "cli"],
      "VALID_BACKENDS values must be unchanged after the rejected mutation attempts");
    assert.equal(VALID_BACKENDS.constructor, Set,
      "VALID_BACKENDS.constructor must still be Set — the readOnlySet() Proxy " +
      "special-cases the constructor trap so brand/identity checks against a " +
      "plain Set continue to work");

    // 2. Static source check: engine.mjs must import VALID_BACKENDS from
    //    runner.mjs and must NOT declare its own local `VALID_BACKENDS =
    //    new Set(...)` — this directly guards against the forge#2076
    //    regression class (a duplicated, independently-drifting copy)
    //    regardless of whether the duplicate's initial values happen to
    //    match runner.mjs's at write time.
    const engineSource = readFileSync(join(__dirname, "..", "engine.mjs"), "utf8");
    assert.match(engineSource, /import\s*\{[^}]*VALID_BACKENDS[^}]*\}\s*from\s*["']\.\/runner\.mjs["']/,
      "engine.mjs must import VALID_BACKENDS from runner.mjs");
    assert.doesNotMatch(engineSource, /(?:const|let|var)\s+VALID_BACKENDS\s*=\s*new\s+Set/,
      "engine.mjs must not declare its own local VALID_BACKENDS Set (would reintroduce forge#2076 drift)");
  });

  // A variant of fakeWorld() whose `.../comments` endpoint returns a genuine
  // JSON array of distinct comment bodies (as the real `gh api ... --jq
  // "[.[].body]"` call does) instead of one concatenated string blob. This is
  // required to exercise `parseBranchFromMarkers()`'s comment-scoped,
  // last-match semantics (forge#2184): with fakeWorld()'s raw-blob mock,
  // `issueMarkers()`'s `JSON.parse` fails and falls back to a single
  // one-element pseudo-comment array, which makes "last comment wins" and
  // "first regex match within that one comment" indistinguishable — the
  // exact coverage gap flagged by this issue (review finding on PR #2182).
  function multiCommentWorld() {
    const w = { comments: [], pr: null, prMerged: false, prNeedsHuman: false,
                issueState: "OPEN", labels: [], commitsAheadByBranch: {}, body: "Issue." };
    const io = {
      gh: async (args) => {
        const a = args.join(" ");
        if (a.startsWith("api ") && a.includes("/comments")) return JSON.stringify(w.comments);
        if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: w.body });
        if (a.startsWith("issue view")) return JSON.stringify({ state: w.issueState, labels: w.labels });
        if (a.startsWith("issue edit")) { const i = args.indexOf("--body"); if (i>=0) w.body = args[i+1];
          const j = args.indexOf("--add-label"); if (j>=0) w.labels.push(args[j+1]); return ""; }
        if (a.startsWith("pr list")) return JSON.stringify(w.pr ? [{ number: w.pr }] : []);
        if (a.startsWith("pr view")) return JSON.stringify({ number: w.pr, state: w.prMerged?"MERGED":"OPEN",
          mergedAt: w.prMerged ? "t" : null, labels: w.prNeedsHuman ? [{name:"needs-human"}] : [] });
        return "";
      },
      // Branch-aware: `commitsAhead(lane, branch, io)` calls
      // `io.git(["rev-list", "--count", `origin/${lane}..${branch}`])` — resolve
      // the requested branch out of the range arg so distinct branches can have
      // distinct (and independently controllable) commit counts.
      git: async (args) => {
        const range = args[args.length - 1] || "";
        const branch = range.split("..")[1] || "";
        return String(w.commitsAheadByBranch[branch] || 0);
      },
    };
    return { w, io };
  }

  it("forge#2184: resolves the LAST FORGE:BUILDER:COMPLETE comment's branch when an earlier stale comment names a different branch", async () => {
    // Regression test for the documented-but-unasserted "last match wins"
    // contract: two genuinely distinct FORGE:BUILDER:COMPLETE comments exist
    // (mirroring a resumed/retried build whose earlier attempt already posted
    // a completion comment), each naming a DIFFERENT branch. The stale first
    // comment's branch has zero real commits (as if that attempt never
    // actually committed); the fresh second comment's branch has real commits.
    // If the engine ever regressed to resolving the FIRST eligible comment
    // instead of the LAST, it would pick the stale branch, see 0 commits
    // ahead, and escalate to needs-human instead of merging — so this test
    // fails loudly under that regression rather than passing vacuously.
    const { w, io } = multiCommentWorld();
    const STALE_BRANCH = "fix/stale-attempt-42";
    const REAL_BRANCH = "fix/real-branch-42";
    w.commitsAheadByBranch[STALE_BRANCH] = 0;

    const script = {
      "work-on/investigate": () => { w.comments.push("INVESTIGATION:COMPLETE"); },
      "work-on/build/context": () => { w.comments.push("FORGE:CONTEXT:COMPLETE"); },
      "work-on/build/architect": () => { w.comments.push("FORGE:ARCHITECT:COMPLETE"); },
      "work-on/build": () => {
        // Stale comment first (earlier attempt, never actually committed),
        // fresh real comment appended after it (this run's own completion).
        w.comments.push(`FORGE:BUILDER:COMPLETE **Branch**: \`${STALE_BRANCH}\``);
        w.comments.push(`FORGE:BUILDER:COMPLETE **Branch**: \`${REAL_BRANCH}\``);
        w.commitsAheadByBranch[REAL_BRANCH] = 2;
      },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged",
      "must merge on the fresh/real branch, not escalate on the stale one");
    const s = deriveState(readLog(dir, 42));
    assert.equal(s.branch, REAL_BRANCH,
      "resolved branch must be the LAST FORGE:BUILDER:COMPLETE comment's branch, not the first/stale one");
  });

  it("forge#2184: a stray **Branch** field in a non-BUILDER:COMPLETE comment (e.g. FORGE:CONTRACT) is never considered", async () => {
    // Comment-scoping regression: a CONTRACT/ARCHITECT/CONTEXT/reviewer comment
    // can legitimately contain a `**Branch**:`-shaped field (e.g. quoting a
    // branch name in prose) without being a completion marker. Only comments
    // whose body contains FORGE:BUILDER:COMPLETE are eligible — a decoy field
    // in an ineligible comment posted AFTER the real completion comment must
    // not win.
    const { w, io } = multiCommentWorld();
    const REAL_BRANCH = "fix/real-branch-99";
    const DECOY_BRANCH = "fix/decoy-branch-99";
    w.commitsAheadByBranch[REAL_BRANCH] = 3;
    w.commitsAheadByBranch[DECOY_BRANCH] = 3; // even if "ahead", it must never be selected

    const script = {
      "work-on/investigate": () => { w.comments.push("INVESTIGATION:COMPLETE"); },
      "work-on/build/context": () => { w.comments.push("FORGE:CONTEXT:COMPLETE"); },
      "work-on/build/architect": () => { w.comments.push("FORGE:ARCHITECT:COMPLETE"); },
      "work-on/build": () => {
        w.comments.push(`FORGE:BUILDER:COMPLETE **Branch**: \`${REAL_BRANCH}\``);
        // Posted AFTER the real completion comment but has no FORGE:BUILDER:COMPLETE
        // marker — e.g. a remediation/reviewer comment quoting a branch name.
        w.comments.push(`FORGE:REMEDIATION note — see \`${DECOY_BRANCH}\` for context, **Branch**: \`${DECOY_BRANCH}\``);
      },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const s = deriveState(readLog(dir, 42));
    assert.equal(s.branch, REAL_BRANCH,
      "a **Branch** field in a comment lacking FORGE:BUILDER:COMPLETE must never be selected, even if posted later");
  });
});
