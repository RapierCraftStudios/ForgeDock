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
              issueState: "OPEN", labels: [], commitsAhead: 0, body: "Issue.",
              // forge#2382: raw call logs — additive, unused by any pre-existing
              // test, so recording every call here is safe for the whole file.
              ghCalls: [], gitCalls: [], worktrees: [] };
  const io = {
    gh: async (args) => {
      const a = args.join(" ");
      w.ghCalls.push(a);
      if (a.startsWith("api ") && a.includes("/comments")) return w.markers;
      if (a.startsWith("issue view") && a.includes("title,body")) return JSON.stringify({ title: "Fix: thing", body: w.body });
      if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: w.body });
      if (a.startsWith("issue view")) return JSON.stringify({ state: w.issueState, labels: w.labels });
      if (a.startsWith("issue edit")) { const i = args.indexOf("--body"); if (i>=0) w.body = args[i+1];
        const j = args.indexOf("--add-label"); if (j>=0) w.labels.push(args[j+1]);
        const k = args.indexOf("--remove-label"); if (k>=0) { const names = args[k+1].split(",");
          w.labels = w.labels.filter((l) => !names.includes(l)); }
        return ""; }
      // forge#2381: close.execute() calls `gh issue close` directly (the
      // engine-native path no longer relies on a scripted "work-on/close"
      // runner() call to flip issueState) — mirror that here so the world
      // stays consistent whichever dispatch path a phase takes.
      if (a.startsWith("issue close")) { w.issueState = "CLOSED"; return ""; }
      if (a.startsWith("issue comment")) return "";
      if (a.startsWith("pr list")) return JSON.stringify(w.pr ? [{ number: w.pr }] : []);
      if (a.startsWith("pr view")) return JSON.stringify({ number: w.pr, state: w.prMerged?"MERGED":"OPEN",
        mergedAt: w.prMerged ? "t" : null, labels: w.prNeedsHuman ? [{name:"needs-human"}] : [] });
      if (a.startsWith("pr create")) { w.pr = w.pr || 99; return `https://github.com/o/r/pull/${w.pr}`; }
      return "";
    },
    git: async (args) => {
      const a = args.join(" ");
      w.gitCalls.push(a);
      // forge#2382: minimal `git worktree`/`git branch`/`git show-ref` fake so
      // ensureWorktreeForBuild/cleanupWorktreeAfterTerminal (bin/engine.mjs)
      // can be exercised end-to-end through runIssue() without a real repo.
      // Matches this file's only two call shapes: `worktree add -- <path> <branch>`
      // and `worktree remove <path> --force`.
      if (args[0] === "worktree" && args[1] === "add") {
        const branch = args.at(-1);
        const path = args.at(-2);
        w.worktrees.push({ path, branch });
        return "";
      }
      if (args[0] === "worktree" && args[1] === "remove") { const path = args[2]; w.worktrees = w.worktrees.filter((wt) => wt.path !== path); return ""; }
      if (args[0] === "worktree" && args[1] === "list") {
        return w.worktrees.map((wt) => `worktree ${wt.path}\nbranch refs/heads/${wt.branch}\n`).join("\n");
      }
      if (args[0] === "show-ref") {
        const branch = args.at(-1).replace("refs/heads/", "");
        if (w.worktrees.some((wt) => wt.branch === branch) || branch === w.knownLocalBranch) return "";
        throw new Error("no such ref");
      }
      if (args[0] === "branch" && args[1] === "-D") return "";
      if (args[0] === "push") return "";
      return String(w.commitsAhead);
    },
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
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
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

  it("forge#2240: onProgress fires phase_enter/phase_exit for every phase actually run, and never crashes the run if it throws", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };
    const events = [];
    // Intentionally throws on the first call — proves a misbehaving onProgress
    // cannot crash an otherwise-healthy run (engine.mjs wraps every call).
    let thrown = false;
    const onProgress = (e) => {
      events.push(e);
      if (!thrown) { thrown = true; throw new Error("boom — a badly-behaved observer"); }
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3, onProgress });

    assert.equal(res.terminalReason, "merged", "a throwing onProgress must not crash or alter the run's outcome");
    const enters = events.filter((e) => e.event === "phase_enter").map((e) => e.phase);
    const exits = events.filter((e) => e.event === "phase_exit").map((e) => e.phase);
    assert.deepEqual(enters, ["investigate", "context", "architect", "build", "review", "close"]);
    assert.deepEqual(exits, ["investigate", "context", "architect", "build", "review", "close"]);
    assert.ok(events.filter((e) => e.event === "phase_exit").every((e) => e.status === "committed"));
  });

  it("forge#2240 (review finding): an async onProgress that rejects does not produce an unhandled rejection", async () => {
    // Security review of PR #2319 found that emitProgress's try/catch only
    // guards a *synchronous* throw — an async onProgress whose returned
    // promise rejects would previously escape as an unhandled rejection,
    // crashing the whole process well after runIssue() itself resolved.
    // Reproduce with process's own 'unhandledRejection' listener: if the fix
    // works, it must never fire.
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    let unhandledRejectionFired = false;
    const onUnhandled = () => { unhandledRejectionFired = true; };
    process.on("unhandledRejection", onUnhandled);
    try {
      // An async onProgress whose returned promise rejects on every call.
      const onProgress = async () => { throw new Error("async observer rejection"); };
      const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 3, onProgress });
      assert.equal(res.terminalReason, "merged", "an async-rejecting onProgress must not alter the run's outcome");
      // Give any not-yet-settled microtask/rejection a chance to surface before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(unhandledRejectionFired, false, "onProgress's rejected promise must be caught, never surfaced as an unhandled rejection");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("forge#2240 (review finding): phase_exit(blocked) fires on the engine-error fail-fast path, not just a dangling phase_enter", async () => {
    // Security review of PR #2319 found that the NO_API_KEY/NO_SDK/CLI_BACKEND_FAILED
    // fail-fast catch emitted phase_enter but returned via terminate() without a
    // matching phase_exit — leaving the progress trail dangling exactly on the
    // phase that actually failed, undermining this issue's own diagnosability goal.
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => {
        throw Object.assign(new Error("claude CLI exited with status 1"), { code: "CLI_BACKEND_FAILED" });
      },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };
    const events = [];
    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3, onProgress: (e) => events.push(e) });

    assert.equal(res.terminalReason, "engine-error");
    const architectEvents = events.filter((e) => e.phase === "architect");
    assert.deepEqual(architectEvents.map((e) => e.event), ["phase_enter", "phase_exit"],
      "the architect phase must report both entry AND exit on the engine-error fail-fast path");
    const exitEvent = architectEvents.find((e) => e.event === "phase_exit");
    assert.equal(exitEvent.status, "blocked");
  });

  it("forge#2240: onProgress defaults to a no-op — omitting it is safe", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };
    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });
    assert.equal(res.terminalReason, "merged");
  });

  it("forge#2321: phase_exit is not emitted without a matching phase_enter for a reconcile-satisfied phase", async () => {
    // Regression for the R1 resume scenario (context.reconcile short-circuits
    // when FORGE:CONTEXT is already present): the phase's runner never
    // executes on this path, so phase_enter is never emitted for it either —
    // phase_exit must not be emitted for it, to avoid a dangling exit with no
    // preceding enter (bin/engine-cli.mjs would otherwise print "✓ phase
    // context committed" with no prior "→ phase context started" line).
    const { w, io } = fakeWorld();
    w.markers = " INVESTIGATION:COMPLETE FORGE:CONTEXT:COMPLETE";
    const { appendEvent } = await import("../engine/runlog.mjs");
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r_42_staging", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });

    const script = {
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };
    const events = [];

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3, onProgress: (e) => events.push(e) });

    assert.equal(res.terminalReason, "merged");
    const contextEvents = events.filter((e) => e.phase === "context");
    assert.deepEqual(contextEvents, [], "a reconcile-satisfied phase must emit neither phase_enter nor phase_exit");

    // Sanity: a phase that DID actually run (architect, not pre-satisfied)
    // still gets a paired enter+exit — proves the fix does not over-suppress.
    const architectEvents = events.filter((e) => e.phase === "architect").map((e) => e.event);
    assert.deepEqual(architectEvents, ["phase_enter", "phase_exit"]);
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
    const events = [];
    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1, onProgress: (e) => events.push(e) });
    assert.equal(res.terminalReason, "needs-human");
    assert.ok(w.labels.includes("needs-human"));
    // forge#2240: the phase that ultimately blocks must report a phase_exit
    // with status "blocked" — not silently omitted.
    const lastExit = events.filter((e) => e.event === "phase_exit").at(-1);
    assert.equal(lastExit.phase, "review");
    assert.equal(lastExit.status, "blocked");
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
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
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
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
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

  it("forge#2259/#2261: CLI_BACKEND_FAILED thrown by the runner fails fast on attempt 1, not retried to maxAttempts", async () => {
    // Regression for #2244: a deterministic non-zero exit from the nested
    // `claude` CLI (bin/runner.mjs's runCliBackend() throws with
    // err.code = "CLI_BACKEND_FAILED" — see bin/tests/runner.test.mjs's own
    // "propagates a non-zero exit status ... as CLI_BACKEND_FAILED" test for
    // the exact shape) reproduces identically on every attempt. It must be
    // rethrown immediately, exactly like NO_API_KEY/NO_SDK, instead of
    // burning all `maxAttempts` retries on a guaranteed-repeat failure.
    //
    // forge#2261: unlike the original #2259 fix (which just let this throw
    // propagate uncaught out of runIssue()), the engine now catches it at the
    // phase-driving loop and reaches a clean "engine-error" terminal state —
    // distinct from "needs-human", since this is the engine/tool breaking,
    // not a genuine human-judgment block. This closes the gap where a
    // completed run previously left the issue with NO terminal state or
    // label at all (the uncaught throw only ever reached bin/forgedock.mjs's
    // outermost catch, which just prints to stderr).
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

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "engine-error",
      "CLI_BACKEND_FAILED must resolve to a distinct engine-error terminal reason, not needs-human, and not an uncaught rejection");
    assert.ok(w.labels.includes("workflow:engine-error"),
      "the workflow:engine-error label must be written — not needs-human");
    assert.ok(!w.labels.includes("needs-human"),
      "needs-human must NOT be written for an engine/tool-level failure");
    assert.equal(architectRunnerCalls, 1,
      "the architect runner must be invoked exactly once — CLI_BACKEND_FAILED must not be retried");
    const events = readLog(dir, 42);
    const architectFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "architect");
    assert.equal(architectFailures.length, 0,
      "no PHASE_FAILED event should be logged for a fail-fast rethrow — it never reaches the retry bookkeeping, matching NO_API_KEY/NO_SDK");
  });

  it("forge#2241: a session-limit CLI_BACKEND_FAILED carrying resetAt threads the reset time into the engine-error detail", async () => {
    // bin/runner.mjs's runCliBackend() attaches err.resetAt (extracted via
    // extractSessionLimitResetTime()) only when the CLI's captured output
    // reports a genuine session-limit reset time. This closes the one
    // remaining acceptance gap left by #2259/#2261: the terminal reason was
    // already distinct ("engine-error", not "needs-human"), but the reset
    // time itself never reached the terminal detail — this asserts it now
    // does, additively, without altering the base detail shape.
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => {
        throw Object.assign(
          new Error("claude CLI exited with status 1"),
          { code: "CLI_BACKEND_FAILED", resetAt: "12:50am (Asia/Calcutta)" },
        );
      },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "engine-error");
    assert.ok(res.detail.includes("resets: 12:50am (Asia/Calcutta)"),
      `terminal detail must surface the CLI's reported reset time: ${res.detail}`);
    assert.ok(res.detail.includes("CLI_BACKEND_FAILED"),
      "the base detail (code/message) must still be present — reset time is additive, not a replacement");
  });

  it("forge#2241: a CLI_BACKEND_FAILED with no resetAt leaves the engine-error detail unchanged (no fabricated reset text)", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => {
        throw Object.assign(new Error("claude CLI exited with status 1"), { code: "CLI_BACKEND_FAILED" });
      },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "engine-error");
    assert.ok(!res.detail.includes("resets:"),
      `no resetAt on the thrown error must not fabricate reset text in the detail: ${res.detail}`);
  });

  it("forge#2261: an uncoded runner exception on every attempt exhausts retries into engine-error, not needs-human", async () => {
    // The runner (the tool itself — the nested `claude` CLI invocation, or
    // whatever `runner()` wraps) crashed on all 3 attempts and detectOutcome()
    // was never once reached — this is an engine/tool failure by definition,
    // not a content-level judgment call, even though the thrown error carries
    // no recognized .code. Prior to #2261 this collapsed into the same
    // generic "needs-human" as a genuine content-level block (see the
    // previous version of this test) — that conflation is exactly the defect
    // #2261 fixes.
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

    assert.equal(res.terminalReason, "engine-error",
      "an uncoded error that crashes the runner on every attempt is an engine/tool failure, not needs-human");
    assert.ok(w.labels.includes("workflow:engine-error"),
      "the workflow:engine-error label must be written");
    assert.ok(!w.labels.includes("needs-human"),
      "needs-human must NOT be written when the runner never once succeeded");
    assert.equal(architectRunnerCalls, 3,
      "an uncoded error (no .code, or a code other than NO_API_KEY/NO_SDK/CLI_BACKEND_FAILED) must retry all 3 attempts unchanged");
    const events = readLog(dir, 42);
    const architectFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "architect");
    assert.equal(architectFailures.length, 3, "all 3 attempts must be logged for a genuinely retryable error");
  });

  it("forge#2261: a genuine content-level block (detectOutcome reached, phase just isn't done) still escalates to needs-human, not engine-error", async () => {
    // Guards the "mixed" case: the runner succeeds (the tool works) on every
    // attempt, but the review phase's own detectOutcome() keeps reporting
    // "PR open, not merged" — a real content-level state, not a tool crash.
    // This must stay needs-human even though retries are exhausted, exactly
    // like the pre-existing "forge#2176 (AC4)" test above — this test
    // exists to explicitly pin the reason value now that engine-error exists
    // as an alternative outcome.
    const { w, io } = fakeWorld();
    let reviewRunnerCalls = 0;
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { reviewRunnerCalls++; w.pr = 7; w.prMerged = false; },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "needs-human",
      "a genuine content-level block (unmerged PR) must stay needs-human, not engine-error");
    assert.ok(w.labels.includes("needs-human"));
    assert.ok(!w.labels.includes("workflow:engine-error"));
    assert.equal(reviewRunnerCalls, 3);
  });

  it("forge#2338 (review finding): a slow in-flight lease-renewal write must not resurrect the lease after terminate()'s lease:null write on the engine-error catch path", async () => {
    // Regression for a CONFIRMED HIGH review finding: `return await
    // terminate(state, "engine-error", detail)` sits INSIDE the catch block
    // that guards runPhaseWithRetry(). Per try/catch/finally semantics, that
    // return's expression (terminate(), including its own `lease: null`
    // write) is fully evaluated to completion BEFORE the enclosing `finally`
    // block runs `clearInterval` / `await pendingRenewal`. A renewal write
    // already dispatched before the throw could therefore land on GitHub
    // AFTER terminate()'s `lease: null` write, resurrecting a phantom lease
    // on an already-terminated run — reopening the exact race #2239
    // (07b3b8a) closed on the non-throwing path, on this one call site that
    // fix didn't cover. Mirrors the sibling "a slow in-flight heartbeat
    // renewal write must not resurrect the lease after terminate()'s
    // lease:null write" test above (which exercises the non-throwing
    // INVESTIGATION:INVALID terminal path) — same slow-write technique,
    // applied to the CLI_BACKEND_FAILED catch/return path instead.
    const { w, io } = fakeWorld();
    const origGh = io.gh;
    let delayEdits = false;
    // Track EVERY delayed write's promise (not just the first) so the test
    // can deterministically wait for all of them to actually land on
    // `w.body`, regardless of whether runIssue() itself joins them (pre-fix:
    // it doesn't on this path; post-fix: it does), and regardless of how
    // many setInterval ticks happen to fire during the armed window under
    // system/CI load. Without this, asserting on `w.body` immediately after
    // `runIssue()` resolves would race ahead of the slow write(s) in BOTH
    // the buggy and fixed code, making the assertion pass trivially either
    // way; and delaying only the FIRST armed write would leave a second,
    // fast-resolving tick free to silently replace `pendingRenewal` inside
    // engine.mjs with an already-settled promise, defeating the technique
    // regardless of whether the engine-error path is actually fixed.
    const delayedEditPromises = [];
    io.gh = async (args) => {
      if (args[0] === "issue" && args[1] === "edit" && delayEdits) {
        // Simulate a slow GitHub API round trip for every renewal write
        // dispatched while armed — long enough that, without the fix, it
        // would still be in flight when the engine-error catch branch calls
        // terminate().
        const delayed = new Promise((resolve) => setTimeout(resolve, 60)).then(() => origGh(args));
        delayedEditPromises.push(delayed);
        return delayed;
      }
      return origGh(args);
    };

    const LEASE_TTL_MS = 100;
    const LEASE_RENEW_INTERVAL_MS = 25;

    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") {
        // Let at least one renewal heartbeat fire and become "slow", then
        // disarm (synchronously, no further ticks can land as "slow" once
        // armed=false) and throw CLI_BACKEND_FAILED immediately — this is
        // the exact window where the pre-fix code would leave the slow
        // write(s) unjoined before reaching the engine-error terminate()
        // call.
        await new Promise((resolve) => setTimeout(resolve, LEASE_RENEW_INTERVAL_MS + 2));
        delayEdits = true;
        await new Promise((resolve) => setTimeout(resolve, LEASE_RENEW_INTERVAL_MS + 2));
        delayEdits = false;
        throw Object.assign(new Error("claude CLI exited with status 1"), { code: "CLI_BACKEND_FAILED" });
      }
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => Date.now(), maxAttempts: 1,
      leaseTtlMs: LEASE_TTL_MS, leaseRenewIntervalMs: LEASE_RENEW_INTERVAL_MS });

    assert.equal(res.terminalReason, "engine-error",
      "sanity check: the run must reach the engine-error catch/return path this test targets");
    assert.ok(delayedEditPromises.length >= 1,
      "test setup sanity check: at least one renewal write must have been armed/delayed during the window");

    // Critical: explicitly wait for every slow write to actually land before
    // inspecting `w.body`. Pre-fix, `runIssue()` resolves WITHOUT joining
    // the slow renewal write(s) on this path (that's the bug) — so checking
    // `w.body` immediately after `await runIssue(...)` would race ahead of
    // the slow write(s) in BOTH the buggy and fixed code, making this
    // assertion pass trivially either way. Post-fix, `runIssue()` already
    // joins the slow write internally (before calling terminate()), so this
    // await is a no-op there.
    await Promise.all(delayedEditPromises);
    const { parseState } = await import("../engine/state.mjs");
    const finalState = parseState(w.body);
    assert.equal(finalState.lease, null,
      "a slow in-flight renewal write must be joined before terminate()'s lease:null write on the " +
      "engine-error catch path too, so it can never land afterward and resurrect a phantom lease");
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
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
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
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
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
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
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
    w.labels.push("workflow:merged");
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

  // forge#2383: this test's expected key set was widened from the original
  // forge#2028 3-key assertion (["args", "commandName", "commandsDir"]) to
  // include "contextPack" — the context-pack builder now runs unconditionally
  // per phase dispatch (independent of backend/model), and fakeWorld()'s
  // default `w.body = "Issue."` is non-empty, so every call in this scenario
  // produces a non-empty pack. The forge#2028 invariant this test actually
  // guards — that omitting backend/model omits those two specific keys
  // entirely, rather than forwarding them as undefined — is unchanged and
  // still asserted below via the two `!("... " in call)` checks.
  it("forge#2028: omitting backend/model preserves the existing runner() call shape (only the forge#2383 contextPack key is added)", async () => {
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
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
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
      assert.deepEqual(Object.keys(call).sort(), ["args", "commandName", "commandsDir", "contextPack"].sort());
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
        // forge#2381: mirror the fakeWorld() mock above — close.execute() calls
        // `gh issue close` directly rather than relying on a scripted runner().
        if (a.startsWith("issue close")) { w.issueState = "CLOSED"; return ""; }
        if (a.startsWith("issue comment")) return "";
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
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
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
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
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

describe("runIssue — forge#2377: per-phase usage recording", () => {
  it("attaches a successful runner()'s usage to the phase's PHASE_COMMIT event", async () => {
    const { w, io } = fakeWorld();
    const USAGE = { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 };
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    // Only the investigate phase's runner() reports usage in this fixture —
    // the rest resolve with the pre-existing `{ status: "complete" }` shape
    // (no usage field) used throughout the suite, to prove the two shapes
    // coexist without crashing.
    const runner = async ({ commandName }) => {
      script[commandName](); // eslint-disable-line
      if (commandName === "work-on/investigate") return { status: "complete", usage: USAGE };
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const events = readLog(dir, 42);
    const investigateCommit = events.find((e) => e.event === "PHASE_COMMIT" && e.phase === "investigate");
    assert.deepEqual(investigateCommit.usage, USAGE,
      "the investigate phase's PHASE_COMMIT event must carry the usage object its runner() resolved with");
  });

  it("degrades to usage: null on PHASE_COMMIT when the runner reports no usage (e.g. CLI backend)", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    // Matches the existing suite-wide fixture shape (`{ status: "complete" }`,
    // no usage field at all) — the same shape every pre-#2377 test in this
    // file already uses, proving no regression for callers that never
    // supply usage.
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const events = readLog(dir, 42);
    const commits = events.filter((e) => e.event === "PHASE_COMMIT");
    assert.ok(commits.length > 0);
    for (const c of commits) {
      assert.equal(c.usage, null, `PHASE_COMMIT for phase ${c.phase} must default usage to null when the runner reports none`);
    }
  });

  it("omits usage on a PHASE_FAILED event produced by a thrown runner() error (no result was ever produced)", async () => {
    const { w, io } = fakeWorld();
    let investigateCalls = 0;
    const script = {
      "work-on/investigate": () => { investigateCalls++; if (investigateCalls > 1) w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate" && investigateCalls === 0) {
        script[commandName]();
        throw new Error("transient network error");
      }
      script[commandName]();
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const events = readLog(dir, 42);
    const investigateFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "investigate");
    assert.equal(investigateFailures.length, 1);
    assert.ok(!("usage" in investigateFailures[0]),
      "a PHASE_FAILED event for a thrown-runner attempt must not carry a fabricated usage field");
  });

  it("attaches the attempt's usage to a PHASE_FAILED event produced by detectOutcome (runner succeeded, phase not yet done)", async () => {
    const { w, io } = fakeWorld();
    const USAGE_ATTEMPT_1 = { input_tokens: 100, output_tokens: 20 };
    let buildCalls = 0;
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => {
        buildCalls++;
        // First attempt: builder posts its marker but no commits landed yet
        // (detectOutcome reports failure, retryable — commitsAhead === 0
        // with no branch resolved is the existing "keep retrying" case).
        if (buildCalls === 1) return;
        w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`";
        w.commitsAhead = 2;
      },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => {
      script[commandName]();
      if (commandName === "work-on/build" && buildCalls === 1) return { status: "complete", usage: USAGE_ATTEMPT_1 };
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const events = readLog(dir, 42);
    const buildFailures = events.filter((e) => e.event === "PHASE_FAILED" && e.phase === "build");
    assert.equal(buildFailures.length, 1, "attempt 1 fails (no commits yet), attempt 2 succeeds");
    assert.deepEqual(buildFailures[0].usage, USAGE_ATTEMPT_1,
      "the PHASE_FAILED event for a detectOutcome-reported failure must carry that attempt's usage");
  });
});

describe("runIssue — forge#2313: lease config validation", () => {
  it("rejects leaseRenewIntervalMs >= leaseTtlMs (boundary-equal case) before any state I/O", async () => {
    const { w, io } = fakeWorld();
    const runner = async () => { throw new Error("runner must never be called"); };

    await assert.rejects(
      () => runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1,
        leaseTtlMs: 100, leaseRenewIntervalMs: 100 }),
      (err) => {
        assert.equal(err.code, "INVALID_LEASE_CONFIG");
        assert.match(err.message, /leaseRenewIntervalMs \(100\) must be less than leaseTtlMs \(100\)/);
        return true;
      },
    );

    // Must fail before any state is read/written — the fake GitHub issue body
    // must remain at its pristine fixture value (no FORGE:STATE ever written),
    // and no run-log event appended (same fail-fast placement as INVALID_BACKEND).
    assert.equal(w.body, "Issue.", "no state should be written to GitHub for an invalid lease config");
    const events = readLog(dir, 42);
    assert.equal(events.length, 0, "no run-log event should be appended for an invalid lease config");
  });

  it("rejects leaseRenewIntervalMs > leaseTtlMs", async () => {
    const { io } = fakeWorld();
    const runner = async () => { throw new Error("runner must never be called"); };

    await assert.rejects(
      () => runIssue({ issue: 43, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1,
        leaseTtlMs: 100, leaseRenewIntervalMs: 500 }),
      (err) => { assert.equal(err.code, "INVALID_LEASE_CONFIG"); return true; },
    );
  });

  it("defaults and explicitly-valid overrides are unaffected by the new check", async () => {
    const { w, io } = fakeWorld();
    const runner = async ({ commandName }) => {
      w.markers += " INVESTIGATION:COMPLETE";
      return { status: "complete" };
    };

    // No override at all — production default path (DEFAULT_LEASE_TTL_MS/DEFAULT_LEASE_RENEW_INTERVAL_MS).
    const res1 = await runIssue({ issue: 44, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1 });
    assert.notEqual(res1.terminalReason, undefined);

    // Explicit valid override (interval < ttl).
    const res2 = await runIssue({ issue: 45, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1,
      leaseTtlMs: 1000, leaseRenewIntervalMs: 100 });
    assert.notEqual(res2.terminalReason, undefined);
  });

  it("forge#2329: rejects NaN leaseTtlMs, which silently bypasses the relational check", async () => {
    // NaN >= x and x >= NaN are both false in JS, so `leaseRenewIntervalMs >=
    // leaseTtlMs` alone never catches a NaN leaseTtlMs — this must be caught
    // by the finite-number guard instead.
    const { w, io } = fakeWorld();
    const runner = async () => { throw new Error("runner must never be called"); };

    await assert.rejects(
      () => runIssue({ issue: 46, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1,
        leaseTtlMs: NaN, leaseRenewIntervalMs: 100 }),
      (err) => {
        assert.equal(err.code, "INVALID_LEASE_CONFIG");
        assert.match(err.message, /leaseTtlMs must be a finite number/);
        return true;
      },
    );
    assert.equal(w.body, "Issue.", "no state should be written to GitHub for an invalid lease config");
  });

  it("forge#2329: rejects NaN leaseRenewIntervalMs, which silently bypasses the relational check", async () => {
    const { io } = fakeWorld();
    const runner = async () => { throw new Error("runner must never be called"); };

    await assert.rejects(
      () => runIssue({ issue: 47, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1,
        leaseTtlMs: 1000, leaseRenewIntervalMs: NaN }),
      (err) => {
        assert.equal(err.code, "INVALID_LEASE_CONFIG");
        assert.match(err.message, /leaseRenewIntervalMs must be a finite number/);
        return true;
      },
    );
  });

  it("forge#2329: rejects Infinity and -Infinity lease values", async () => {
    const { io } = fakeWorld();
    const runner = async () => { throw new Error("runner must never be called"); };

    await assert.rejects(
      () => runIssue({ issue: 48, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1,
        leaseTtlMs: Infinity, leaseRenewIntervalMs: 100 }),
      (err) => { assert.equal(err.code, "INVALID_LEASE_CONFIG"); return true; },
    );

    await assert.rejects(
      () => runIssue({ issue: 49, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1,
        leaseTtlMs: 1000, leaseRenewIntervalMs: -Infinity }),
      (err) => { assert.equal(err.code, "INVALID_LEASE_CONFIG"); return true; },
    );
  });

  it("forge#2329: rejects non-numeric lease values (string, null)", async () => {
    const { io } = fakeWorld();
    const runner = async () => { throw new Error("runner must never be called"); };

    await assert.rejects(
      () => runIssue({ issue: 50, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1,
        leaseTtlMs: "1000", leaseRenewIntervalMs: 100 }),
      (err) => { assert.equal(err.code, "INVALID_LEASE_CONFIG"); return true; },
    );

    await assert.rejects(
      () => runIssue({ issue: 51, dir, agentId: "a1", lane: "staging",
        io, runner, now: () => 1000, maxAttempts: 1,
        leaseTtlMs: 1000, leaseRenewIntervalMs: null }),
      (err) => { assert.equal(err.code, "INVALID_LEASE_CONFIG"); return true; },
    );
  });
});

describe("runIssue — forge#2239: in-flight lease", () => {
  it("claims a real (non-null) lease before the first phase runs, not after PHASE_COMMIT", async () => {
    const { w, io } = fakeWorld();
    const bodiesAtRunnerCall = [];
    const origGh = io.gh;
    io.gh = async (args) => {
      const out = await origGh(args);
      return out;
    };
    const runner = async ({ commandName }) => {
      // Snapshot GitHub body the instant the FIRST phase's runner is invoked —
      // before it does anything. If the lease is only claimed post-commit
      // (the pre-fix bug), this snapshot would show lease: null.
      if (commandName === "work-on/investigate") bodiesAtRunnerCall.push(w.body);
      w.markers += " INVESTIGATION:COMPLETE";
      return { status: "complete" };
    };

    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1 });

    assert.equal(bodiesAtRunnerCall.length, 1);
    const { parseState } = await import("../engine/state.mjs");
    const snapshot = parseState(bodiesAtRunnerCall[0]);
    assert.ok(snapshot, "a FORGE:STATE block must already be published before the first phase's runner is invoked");
    assert.ok(snapshot.lease, "lease must be non-null before the first phase runs (forge#2239)");
    assert.equal(snapshot.lease.by, "a1");
    assert.ok(snapshot.lease.until > 1000, "lease must not already be expired at claim time");
  });

  it("claims a lease for the previously-unhandled 'local' reconcile action (local log ahead, no remote state)", async () => {
    // Regression for the widest gap found during investigation: when reconcileState
    // returns action:"local" (local run-log present, no remote FORGE:STATE at all),
    // the pre-fix code wrote NOTHING to GitHub before running phases — not even a
    // null lease. Confirm the post-fix code now claims a real lease in this path too.
    const { w, io } = fakeWorld();
    w.body = ""; // no remote FORGE:STATE block at all
    const { appendEvent } = await import("../engine/runlog.mjs");
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r_42_staging", lane: "staging" });

    let sawLeaseBeforeRunnerCall = null;
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") {
        const { parseState } = await import("../engine/state.mjs");
        sawLeaseBeforeRunnerCall = parseState(w.body)?.lease ?? null;
      }
      w.markers += " INVESTIGATION:COMPLETE";
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1 });

    assert.notEqual(res.terminalReason, "deferred");
    assert.ok(sawLeaseBeforeRunnerCall, "the 'local' resume path must also claim a lease before the first phase runs");
    assert.equal(sawLeaseBeforeRunnerCall.by, "a1");
  });

  it("claims the lease before the phase loop and renews it once more before the phase runner starts (non-timer writes only — see the sibling 'setInterval heartbeat' test below for the timer-driven path)", async () => {
    // forge#2333: this test's original name ("renews the lease while a single
    // phase's runner is still in flight") implied it exercises the
    // setInterval-driven heartbeat renewal (bin/engine.mjs's `renewTimer`).
    // It does not. #2314's investigation proved (and this rename documents)
    // that the `leaseStates.length >= 2` assertion below is satisfied
    // entirely by two plain sequential `await`s that both complete before
    // the runner's artificial delay even starts:
    //   1. the unconditional pre-loop lease claim (`runIssue()`, before the
    //      phase loop begins), and
    //   2. the pre-phase "renew before phase" write (dispatched immediately
    //      before the runner is invoked, still before `renewTimer` is even
    //      constructed).
    // Disabling `setInterval` entirely (i.e. the heartbeat never fires) does
    // NOT fail this test — it only ever checks these two non-timer writes.
    // This is a genuine regression guard for THAT pair: reconstructing
    // pre-#2239 code (`git show 783a652`) yields only 1 non-null lease write,
    // so a real revert of the pre-loop claim still correctly fails here. Do
    // NOT delete it. The timer-driven heartbeat itself is covered by the new
    // test immediately below, which is proven (see its comment) to fail when
    // the `setInterval` mechanism is disabled — this one is not.
    const { w, io } = fakeWorld();
    const writeStateBodies = [];
    const origGh = io.gh;
    io.gh = async (args) => {
      const out = await origGh(args);
      const i = args.indexOf("--body");
      if (i >= 0) writeStateBodies.push(args[i + 1]);
      return out;
    };

    // Tiny TTL/renew-interval so a short real-time delay inside the runner
    // reliably outlives at least one renewal cycle, without waiting on the
    // real 10-minute production default.
    const LEASE_TTL_MS = 30;
    const LEASE_RENEW_INTERVAL_MS = 10;

    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") {
        // Outlive several renewal cycles.
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      w.markers += " INVESTIGATION:COMPLETE";
      return { status: "complete" };
    };

    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => Date.now(), maxAttempts: 1,
      leaseTtlMs: LEASE_TTL_MS, leaseRenewIntervalMs: LEASE_RENEW_INTERVAL_MS });

    const { parseState } = await import("../engine/state.mjs");
    const leaseStates = writeStateBodies.map((b) => parseState(b)?.lease).filter(Boolean);
    // At least: the pre-loop claim + the pre-phase renew-before-phase write.
    // Both are plain sequential `await`s — no timer involved. See the block
    // comment above: this assertion is intentionally satisfied without the
    // setInterval heartbeat ever firing.
    assert.ok(leaseStates.length >= 2,
      `expected at least 2 lease-bearing writes (pre-loop claim + pre-phase renew), got ${leaseStates.length}`);
  });

  it("the setInterval heartbeat itself renews the lease one or more times while the phase runner is still in flight (timer-driven path, distinct from the pre-loop/pre-phase writes above)", async () => {
    // forge#2333: isolates the ONE code path the test above does not
    // exercise — bin/engine.mjs's `renewTimer = setInterval(renewLease,
    // leaseRenewIntervalMs)`, constructed only after the pre-phase renewal
    // write and only while a phase's runner is genuinely in flight.
    //
    // Non-timer lease-bearing writes for a single-phase, single-attempt run
    // are exactly 3, regardless of whether the heartbeat ever fires:
    //   1. the pre-loop unconditional claim,
    //   2. the pre-phase renew-before-phase write, and
    //   3. the post-commit write (after the runner resolves, once the phase
    //      outcome is known — see the `state = deriveState(...); await
    //      projector.writeState(...)` call right after the phase loop's
    //      commit branch).
    // None of these three depend on `setInterval` — they are step 2 and
    // step 4 above (an earlier/renamed test) plus the always-present
    // post-commit write. So asserting a COUNT STRICTLY GREATER than 3 (i.e.
    // >= 4) can only be satisfied by at least one additional write that came
    // from the timer-driven `renewLease()` firing during the runner's
    // in-flight window — which is exactly the mechanism this issue found
    // uncovered.
    //
    // Non-vacuousness proof (performed manually against a local copy of
    // bin/engine.mjs, per this issue's mandate — not merely reasoned about):
    // commenting out the `setInterval(renewLease, leaseRenewIntervalMs)`
    // call (equivalently, never scheduling `renewLease`) drops the observed
    // write count to exactly 3, and this assertion (`>= 4`) then fails. The
    // renamed test above, by contrast, is unaffected by that same sabotage —
    // it continues to pass at exactly 2, confirming it only ever covers the
    // non-timer writes.
    const { w, io } = fakeWorld();
    const writeStateBodies = [];
    const origGh = io.gh;
    io.gh = async (args) => {
      const out = await origGh(args);
      const i = args.indexOf("--body");
      if (i >= 0) writeStateBodies.push(args[i + 1]);
      return out;
    };

    // Same tiny TTL/interval convention as the sibling test above — long
    // enough (80ms runner delay vs. 10ms interval) that the heartbeat has
    // several opportunities to fire before the runner resolves, without
    // waiting on the real 10-minute production default.
    const LEASE_TTL_MS = 30;
    const LEASE_RENEW_INTERVAL_MS = 10;

    // Terminate immediately after this ONE phase (INVESTIGATION:INVALID makes
    // the investigate phase's isTerminalAfter fire — see phases.mjs), rather
    // than INVESTIGATION:COMPLETE which lets the loop continue on to
    // work-on/build/context, work-on/build/architect, etc. Letting the loop
    // continue would add further phases' own pre-phase-renew/post-commit
    // writes on top of investigate's, making the total count depend on how
    // many downstream phases happen to run before this mocked world blocks —
    // which has nothing to do with whether the timer fired during THIS
    // phase's in-flight window, and would make the ">= 4" threshold below
    // meaningless. Confirmed empirically: with INVESTIGATION:COMPLETE here,
    // the run proceeds through context/architect before blocking, and even
    // with the setInterval heartbeat fully disabled the total write count
    // stays >= 4 purely from those extra phases — i.e. that variant of this
    // test would be exactly the vacuous-count trap this issue is about.
    // Ending the run after exactly one phase is what makes "3 without the
    // timer, 4+ with it" a hard invariant instead of an environment-dependent
    // guess.
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      w.markers += " INVESTIGATION:INVALID";
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => Date.now(), maxAttempts: 1,
      leaseTtlMs: LEASE_TTL_MS, leaseRenewIntervalMs: LEASE_RENEW_INTERVAL_MS });

    assert.equal(res.terminalReason, "invalid",
      "sanity check: the run must terminate right after the single investigate phase, " +
      "so the write count below reflects only that one phase's writes");

    const { parseState } = await import("../engine/state.mjs");
    const leaseStates = writeStateBodies.map((b) => parseState(b)?.lease).filter(Boolean);
    // 3 non-timer writes (pre-loop claim + pre-phase renew + post-commit) can
    // never satisfy this on their own — a 4th+ write requires the
    // setInterval-driven renewLease() to have actually fired during the
    // runner's in-flight window.
    assert.ok(leaseStates.length >= 4,
      `expected at least 4 lease-bearing writes (pre-loop claim + pre-phase renew + >=1 timer-driven ` +
      `renewal + post-commit write), got ${leaseStates.length} — the setInterval heartbeat may not be firing`);
  });

  it("no regression: terminate() still clears the lease to null on a terminal state", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:INVALID"; },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1 });

    assert.equal(res.terminalReason, "invalid");
    const { parseState } = await import("../engine/state.mjs");
    const finalState = parseState(w.body);
    assert.equal(finalState.lease, null, "terminal states must still publish lease: null (no regression)");
  });

  it("review finding: a slow in-flight heartbeat renewal write must not resurrect the lease after terminate()'s lease:null write", async () => {
    // Regression test for a CONFIRMED HIGH review finding on this PR:
    // projector.writeState is a plain read-body/edit-body round trip with no
    // CAS, so whichever `gh issue edit` call lands last on GitHub wins,
    // regardless of dispatch order. The heartbeat renewal write is
    // fire-and-forget (best-effort .catch()) — without joining it before the
    // loop proceeds to a commit/terminate write, a slow renewal write that
    // was already in flight when the phase finished could land AFTER
    // terminate()'s lease:null write, resurrecting a phantom non-null lease
    // on an already-terminated run. The fix: track the most recently
    // dispatched renewal's promise and await it in `finally` before letting
    // the loop continue.
    const { w, io } = fakeWorld();
    const origGh = io.gh;
    let delayNextEdit = false;
    // Track the slow write's own promise so the test can deterministically wait
    // for it to actually land on `w.body`, regardless of whether runIssue()
    // itself joins it (pre-fix: it doesn't; post-fix: it does). Without this,
    // asserting on `w.body` immediately after `runIssue()` resolves would race
    // ahead of the slow write in BOTH the buggy and fixed code paths, making
    // the assertion pass trivially either way.
    let slowEditPromise = null;
    io.gh = async (args) => {
      if (args[0] === "issue" && args[1] === "edit" && delayNextEdit) {
        delayNextEdit = false;
        // Simulate a slow GitHub API round trip for exactly one renewal write —
        // long enough that, without the fix, it would still be in flight when
        // the phase finishes and the run reaches terminate().
        const delayed = new Promise((resolve) => setTimeout(resolve, 60)).then(() => origGh(args));
        slowEditPromise = delayed;
        return delayed;
      }
      return origGh(args);
    };

    const LEASE_TTL_MS = 20;
    const LEASE_RENEW_INTERVAL_MS = 5;

    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") {
        // Let exactly one renewal heartbeat fire and become "slow", then
        // immediately finish the phase — this is the exact window where the
        // pre-fix code would leave the slow write unjoined.
        await new Promise((resolve) => setTimeout(resolve, LEASE_RENEW_INTERVAL_MS + 1));
        delayNextEdit = true;
        await new Promise((resolve) => setTimeout(resolve, LEASE_RENEW_INTERVAL_MS + 1));
      }
      // Terminal (INVALID) on first phase — reaches terminate()'s lease:null
      // write shortly after the slow renewal write was dispatched.
      w.markers += " INVESTIGATION:INVALID";
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => Date.now(), maxAttempts: 1,
      leaseTtlMs: LEASE_TTL_MS, leaseRenewIntervalMs: LEASE_RENEW_INTERVAL_MS });

    assert.equal(res.terminalReason, "invalid");
    // Critical: explicitly wait for the slow write to actually land before
    // inspecting `w.body`. Pre-fix, `runIssue()` itself resolves WITHOUT
    // joining the slow renewal write (that's the bug) — so checking `w.body`
    // immediately after `await runIssue(...)` would race ahead of the slow
    // write in BOTH the buggy and fixed code, making this assertion pass
    // trivially either way. Post-fix, `runIssue()` already joins the slow
    // write internally before returning, so this await is a no-op there.
    if (slowEditPromise) await slowEditPromise;
    const { parseState } = await import("../engine/state.mjs");
    const finalState = parseState(w.body);
    assert.equal(finalState.lease, null,
      "a slow in-flight renewal write must be joined before terminate()'s lease:null write, " +
      "so it can never land afterward and resurrect a phantom lease");
  });

  it("forge#2348 (review finding): renewLease() must not dispatch an overlapping renewal write while a previous one is still in flight", async () => {
    // Regression for a CONFIRMED MEDIUM review finding, related to but distinct
    // from #2338: the join-tracking scheme fixed by #2239/#2338 only ever holds
    // ONE promise in `pendingRenewal` — it protects against a single in-flight
    // write landing late, but has no backpressure against a SECOND renewal tick
    // firing (and dispatching its own write) while the first write is still in
    // flight. Without a guard, `pendingRenewal` is simply overwritten by the
    // newer write's promise, silently orphaning the earlier one from every join
    // point. Since projector.writeState is a plain read-body/edit-body round
    // trip with no CAS (see #2239), an orphaned earlier write landing after a
    // later one (or after commit/terminate) can resurrect stale state.
    //
    // This test proves the fix at the dispatch level directly: while the phase
    // runner is in flight, every "issue edit" renewal write dispatched during a
    // bounded observation window is held artificially slow (60ms — longer than
    // the whole window), and the renewal interval (10ms) is short enough for
    // several ticks to become eligible to fire during that window. Pre-fix,
    // `renewLease()` unconditionally dispatches a NEW overlapping write on every
    // eligible tick regardless of whether the previous one has settled, so 2+
    // writes would be dispatched during the window. Post-fix, the
    // `if (pendingRenewal) return;` guard means every tick after the first is a
    // no-op until the in-flight write settles, so exactly 1 write is dispatched.
    // Delays are bounded (not indefinite) throughout, so this cannot hang even
    // if a future refactor changes how many writes land — worst case is a
    // failed assertion, not a stuck promise.
    const { w, io } = fakeWorld();
    const origGh = io.gh;
    let delayEdits = false;
    let dispatchCountDuringWindow = 0;
    const delayedEditPromises = [];
    io.gh = async (args) => {
      if (args[0] === "issue" && args[1] === "edit" && args.includes("--body") && delayEdits) {
        dispatchCountDuringWindow += 1;
        const delayed = new Promise((resolve) => setTimeout(resolve, 60)).then(() => origGh(args));
        delayedEditPromises.push(delayed);
        return delayed;
      }
      return origGh(args);
    };

    const LEASE_TTL_MS = 1000;
    const LEASE_RENEW_INTERVAL_MS = 10;

    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") {
        // Arm delay only once inside the runner — well after the two
        // synchronous pre-loop lease-claim writes (the unconditional claim
        // before the phase loop starts, and the per-phase renewal write
        // immediately before renewTimer is created) have already resolved
        // normally. This guarantees renewTimer is already running before any
        // write is ever delayed, so the timer-driven ticks below are real.
        delayEdits = true;
        // Stay "in phase" long enough for several renewal ticks (10ms
        // interval) to become eligible while every dispatched write during
        // this window sits at a fixed 60ms delay — this is the overlap
        // window where a second, unguarded write would be dispatched.
        await new Promise((resolve) => setTimeout(resolve, LEASE_RENEW_INTERVAL_MS * 6));
        delayEdits = false;
      }
      // Terminal (INVALID) on first phase — reaches terminate() shortly after
      // the observation window, same shape as the sibling "slow in-flight
      // heartbeat" test above.
      w.markers += " INVESTIGATION:INVALID";
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => Date.now(), maxAttempts: 1,
      leaseTtlMs: LEASE_TTL_MS, leaseRenewIntervalMs: LEASE_RENEW_INTERVAL_MS });

    // Wait for every delayed write to actually land before asserting, so a
    // write dispatched right at the edge of the window isn't missed.
    await Promise.all(delayedEditPromises);

    assert.equal(res.terminalReason, "invalid");
    assert.equal(dispatchCountDuringWindow, 1,
      "renewLease() must not dispatch a new renewal write while a previous one is still in flight — " +
      "observed " + dispatchCountDuringWindow + " writes dispatched during a single 60ms-delayed window " +
      "against a 10ms renewal interval (6 ticks eligible), meaning the backpressure guard did not engage");
  });

  it("a second concurrent run-issue is deferred by the now-real (non-null) lease claimed by the first run", async () => {
    // End-to-end proof that the concurrency guard (bin/engine.mjs I3 check) is
    // actually reachable now: run agent "a1" far enough to claim a lease (but
    // not finish), then have agent "a2" attempt to start against the same
    // GitHub state and confirm it defers instead of racing in.
    const { w, io } = fakeWorld();
    let leaseSnapshotAfterA1Start = null;
    const runnerA1 = async ({ commandName }) => {
      if (commandName === "work-on/investigate") {
        const { parseState } = await import("../engine/state.mjs");
        leaseSnapshotAfterA1Start = parseState(w.body)?.lease ?? null;
      }
      // Never resolves the investigate phase — simulates a run that is still
      // genuinely in flight when a2 attempts to start.
      return new Promise(() => {});
    };

    // Fire a1 but don't await it to completion (it never resolves) — just
    // enough ticks for it to have claimed the lease and be "running".
    runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner: runnerA1, now: () => Date.now(), maxAttempts: 1 });
    // Yield a couple of microtask/timer turns so a1's pre-loop lease claim lands.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(leaseSnapshotAfterA1Start, "a1 must have claimed a lease before its phase runner was invoked");

    const runnerA2 = async () => { throw new Error("a2's runner must never be called while a1 holds the lease"); };
    const res2 = await runIssue({ issue: 42, dir: mkdtempSync(join(tmpdir(), "fd-engine-a2-")), agentId: "a2", lane: "staging",
      io, runner: runnerA2, now: () => Date.now(), maxAttempts: 1 });

    assert.equal(res2.terminalReason, "deferred");
    assert.ok(res2.detail.includes("a1"));
  });
});

// forge#2352: state-vs-GitHub divergence guard. Previously, none of the
// PHASES entries' entryCondition/reconcile/detectOutcome (other than close,
// which only runs at the very end) ever checked the issue's live GitHub
// state/labels before advancing — so a phase could run to completion against
// an issue that was independently closed or labeled workflow:invalid /
// needs-human. These tests drive a run where the issue diverges mid-flight
// and assert the engine halts/escalates at that boundary instead of
// advancing to the next phase's runner.
describe("runIssue — forge#2352: state-vs-GitHub divergence guard", () => {
  it("halts before 'context' when the issue is closed workflow:invalid immediately after 'investigate' commits", async () => {
    const { w, io } = fakeWorld();
    const runCounts = {};
    const script = {
      "work-on/investigate": () => {
        // investigate commits normally (CONFIRMED verdict marker) — but the
        // issue is independently closed as workflow:invalid out-of-band
        // (e.g. a human, or a sibling agent) between this phase committing
        // and the engine picking the next phase. This is exactly the
        // production scenario cited in the issue: the marker says CONFIRMED,
        // but the issue's real GitHub state has already diverged.
        w.markers += " INVESTIGATION:COMPLETE";
        w.issueState = "CLOSED";
        w.labels.push("workflow:invalid");
      },
      "work-on/build/context": () => { throw new Error("context must never run against a closed/invalid issue"); },
    };
    const runner = async ({ commandName }) => {
      runCounts[commandName] = (runCounts[commandName] || 0) + 1;
      script[commandName]();
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "invalid");
    assert.equal(runCounts["work-on/investigate"], 1);
    assert.equal(runCounts["work-on/build/context"] || 0, 0, "context must not have run");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate"]);
  });

  it("halts before 'build' when the issue is closed (no workflow:merged) after 'architect' commits", async () => {
    const { w, io } = fakeWorld();
    const runCounts = {};
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => {
        w.markers += " FORGE:ARCHITECT:COMPLETE";
        // Issue closed out-of-band (not via workflow:invalid this time — a
        // bare CLOSED state with no workflow:merged label must be treated
        // the same way: dead, not a merge).
        w.issueState = "CLOSED";
      },
      "work-on/build": () => { throw new Error("build must never run against a closed issue"); },
    };
    const runner = async ({ commandName }) => {
      runCounts[commandName] = (runCounts[commandName] || 0) + 1;
      script[commandName]();
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "invalid");
    assert.equal(runCounts["work-on/build"] || 0, 0, "build must not have run");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate", "context", "architect"]);
  });

  it("pauses (terminalReason needs-human) rather than advancing when the issue carries needs-human mid-run, and does not touch the needs-human label itself", async () => {
    const { w, io } = fakeWorld();
    const editCalls = [];
    const origGh = io.gh;
    io.gh = async (args) => {
      if (args[0] === "issue" && args[1] === "edit") editCalls.push([...args]);
      return origGh(args);
    };
    const runCounts = {};
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => {
        w.markers += " FORGE:CONTEXT:COMPLETE";
        // A human (or a sibling automation) escalates the issue mid-run.
        w.labels.push("needs-human");
      },
      "work-on/build/architect": () => { throw new Error("architect must not run while needs-human is set"); },
    };
    const runner = async ({ commandName }) => {
      runCounts[commandName] = (runCounts[commandName] || 0) + 1;
      script[commandName]();
      return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "needs-human");
    assert.equal(runCounts["work-on/build/architect"] || 0, 0, "architect must not have run");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate", "context"]);
  });

  it("does not guard the close phase itself — close still runs and reads the same CLOSED state as its normal success signal", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate", "context", "architect", "build", "review", "close"]);
  });

  it("a healthy, non-diverged run is unaffected by the guard (baseline — no closed/invalid/needs-human state at any point)", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
  });

  it("fail-open: a gh error on the divergence-guard snapshot does not block a healthy run", async () => {
    const { w, io } = fakeWorld();
    const origGh = io.gh;
    let snapshotCalls = 0;
    io.gh = async (args) => {
      const a = args.join(" ");
      // Only fail the guard's own snapshot calls (issued for every phase
      // except close, while the issue is still OPEN) — once the close
      // phase's script sets the issue CLOSED, its own reconcile/detectOutcome
      // (which share this exact call shape) must be allowed to see the real,
      // final state, since those are not covered by this fail-open guarantee.
      if (a.startsWith("issue view") && a.includes("--json state,labels") && w.issueState === "OPEN") {
        snapshotCalls++;
        throw new Error("transient gh failure");
      }
      return origGh(args);
    };
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    assert.ok(snapshotCalls > 0, "the guard's snapshot call must actually have been exercised (and failed) at least once");
  });
});

// forge#2381: engine-native phase dispatch — a phase declaring `execute`
// (currently only `close`) must skip runner()/the LLM subagent entirely, and
// its PHASE_COMMIT run-log event must carry a distinct `engineNative` field.
describe("runIssue — forge#2381: engine-native phase dispatch (execute)", () => {
  it("close never invokes the injected runner mock — the whole pipeline still reaches terminalReason merged via close.execute()", async () => {
    const { w, io } = fakeWorld();
    let closeRunnerCalled = false;
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      // Intentionally NOT scripted for "work-on/close" — if runner() is ever
      // called for close, this throws, proving the dispatch actually skipped it.
    };
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/close") { closeRunnerCalled = true; throw new Error("runner() must never be called for an execute()-dispatched phase"); }
      script[commandName](); return { status: "complete" };
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(closeRunnerCalled, false);
    assert.equal(res.terminalReason, "merged");
    assert.equal(w.issueState, "CLOSED", "close.execute() itself performed the real `gh issue close` call");
    assert.ok(w.labels.includes("workflow:merged"));
  });

  it("PHASE_COMMIT for close carries engineNative: true; every runner()-dispatched phase carries engineNative: false", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    const events = readLog(dir, 42).filter(e => e.event === "PHASE_COMMIT");
    const byPhase = Object.fromEntries(events.map(e => [e.phase, e.engineNative]));
    assert.equal(byPhase.close, true);
    for (const p of ["investigate", "context", "architect", "build", "review"]) {
      assert.equal(byPhase[p], false, `${p} must not be tagged engineNative`);
    }
  });

  // forge#2442: eventsFromIndex() (hydrate/C2 reconstruction path) must derive
  // `engineNative` on read from the static PHASES table, since the compact
  // FORGE:STATE index's `committed` field is a flat phase-id string[] and
  // never carried the flag itself.
  it("C2 + forge#2381: hydrate reconstructs PHASE_COMMIT events with engineNative — close: true, all runner()-dispatched phases: false", async () => {
    const { w, io } = fakeWorld();
    const remoteIndex = {
      v: 6, run: "r_42_staging", issue: 42, lane: "staging",
      committed: ["investigate", "context", "architect", "build", "review", "close"],
      phase: null, branch: "fix/real-branch-42", pr: 7,
      terminal: true, terminalReason: "merged", lease: null,
    };
    w.body = serializeState(remoteIndex);

    const runner = async () => { throw new Error("runner must not be called — remote state is already terminal"); };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const events = readLog(dir, 42).filter(e => e.event === "PHASE_COMMIT");
    const byPhase = Object.fromEntries(events.map(e => [e.phase, e.engineNative]));
    assert.equal(byPhase.close, true, "close must be reconstructed as engineNative: true after hydrate");
    for (const p of ["investigate", "context", "architect", "build", "review"]) {
      assert.equal(byPhase[p], false, `${p} must be reconstructed as engineNative: false after hydrate`);
    }
  });

  it("a throwing execute() (failure on the load-bearing 'gh issue close' call) is caught by runExecutePhase and surfaces as needs-human, not an unhandled crash", async () => {
    const { w, io } = fakeWorld();
    const origGh = io.gh;
    io.gh = async (args) => {
      if (args.join(" ").startsWith("issue close")) throw new Error("boom from the load-bearing close call");
      return origGh(args);
    };
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    // runExecutePhase() catches the throw and returns {status: "blocked"} — runIssue's
    // existing blocked-outcome handling then terminates with reason "needs-human"
    // (no `reason` field on the returned outcome → defaults to "needs-human").
    assert.equal(res.terminalReason, "needs-human");
    assert.equal(w.issueState, "OPEN", "the issue was never actually closed given the injected failure");
  });
});

describe("runIssue — forge#2382: engine-issued label transitions and worktree lifecycle", () => {
  function happyScript(w) {
    return {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
    };
  }

  it("sets workflow:ready-to-build after investigate commits and workflow:building after architect commits", async () => {
    const { w, io } = fakeWorld();
    const script = happyScript(w);
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 3 });

    assert.ok(w.ghCalls.some((c) => c.includes("--add-label") && c.includes("workflow:ready-to-build")),
      "investigate committing (non-terminal) must set workflow:ready-to-build");
    assert.ok(w.ghCalls.some((c) => c.includes("--add-label") && c.includes("workflow:building")),
      "architect committing must set workflow:building");
    // Final state still ends up workflow:merged — earlier transitions are
    // superseded (setWorkflowLabel removes every other workflow:* state).
    assert.ok(w.labels.includes("workflow:merged"));
    assert.ok(!w.labels.includes("workflow:ready-to-build"));
    assert.ok(!w.labels.includes("workflow:building"));
  });

  it("does NOT set workflow:ready-to-build when investigate commits with a terminal reason (invalid)", async () => {
    const { w, io } = fakeWorld();
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") { w.markers += " INVESTIGATION:INVALID"; return { status: "complete" }; }
      throw new Error(`unexpected phase dispatch: ${commandName}`);
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "invalid");
    assert.ok(!w.ghCalls.some((c) => c.includes("--add-label") && c.includes("workflow:ready-to-build")),
      "a terminal (invalid) investigate commit must not also get the forward-progress label");
  });

  it("review.reconcile sets workflow:in-review once a PR is adopted/created (via the shared engine label state machine)", async () => {
    const { w, io } = fakeWorld();
    const script = happyScript(w);
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 3 });

    assert.ok(w.ghCalls.some((c) => c.includes("--add-label") && c.includes("workflow:in-review")));
  });

  it("cleans up the worktree/branch when the run terminates merged", async () => {
    const { w, io } = fakeWorld();
    // Simulate the build runner having created a worktree for the real branch,
    // the way commands/work-on/build.md's own Phase B1C would in production.
    const script = {
      ...happyScript(w),
      "work-on/build": () => {
        w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`";
        w.commitsAhead = 2;
        w.worktrees.push({ path: ".claude/worktrees/real-branch-42", branch: "fix/real-branch-42" });
      },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    assert.equal(w.worktrees.length, 0, "the worktree must be removed once the run terminates merged");
    assert.ok(w.gitCalls.some((c) => c.startsWith("worktree remove")));
    assert.ok(w.gitCalls.some((c) => c === "branch -D fix/real-branch-42"));
  });

  it("does NOT clean up the worktree/branch when the run terminates needs-human", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT:COMPLETE"; },
      "work-on/build": () => {
        w.markers += " FORGE:BUILDER:COMPLETE **Branch**: `fix/real-branch-42`";
        w.commitsAhead = 2;
        w.worktrees.push({ path: ".claude/worktrees/real-branch-42", branch: "fix/real-branch-42" });
      },
      "work-on/review": () => { w.pr = 7; w.prNeedsHuman = true; }, // open, needs-human -> "blocked"
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "needs-human");
    assert.equal(w.worktrees.length, 1, "a needs-human terminal state must leave the worktree/branch intact for a human/remediation run");
    assert.ok(!w.gitCalls.some((c) => c.startsWith("worktree remove")));
    assert.ok(!w.gitCalls.some((c) => c.startsWith("branch -D")));
  });

  it("ensureWorktreeForBuild re-attaches a lost worktree before dispatching review, once build has already committed a branch", async () => {
    const { w, io } = fakeWorld();
    // Simulate a resumed run: "build" already committed (state.branch is
    // therefore genuinely resolvable via eventsFromIndex's hydrate path — see
    // bin/engine.mjs's own comment on why state.branch can never be known
    // BEFORE "build" itself dispatches), the branch still exists locally, but
    // no worktree is currently registered for it (lost/deleted out-of-band
    // between sessions) — this is exactly the gap ensureWorktreeForBuild
    // exists to close for "review"/"remediate", whose own phase specs `cd
    // {WORKTREE_PATH}` and would otherwise fail outright.
    w.knownLocalBranch = "fix/resumed-branch-42";
    const remoteIndex = {
      v: 1, run: "r_42_staging", issue: 42, lane: "staging",
      committed: ["investigate", "context", "architect", "build"],
      phase: null, branch: "fix/resumed-branch-42", pr: null,
      terminal: false, terminalReason: null, lease: null,
    };
    w.body = serializeState(remoteIndex);
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/review") { w.pr = 7; w.prMerged = true; return { status: "complete" }; }
      throw new Error(`unexpected phase dispatch: ${commandName} — "build" is already committed and must not be re-run`);
    };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    assert.ok(w.gitCalls.some((c) => c.startsWith("worktree add") && c.includes("fix/resumed-branch-42")),
      "must re-attach the surviving local branch via `git worktree add` before dispatching review");
  });

  it("ensureWorktreeForBuild is a no-op while state.branch is still unresolved (first-time build)", async () => {
    const { w, io } = fakeWorld();
    const script = happyScript(w);
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 3 });

    // No worktree was ever registered in this fake world (the test never
    // injected one, unlike the "cleans up the worktree" test above) — so any
    // "worktree add" call here would have to have come from
    // ensureWorktreeForBuild firing on the "build" phase's own dispatch,
    // which must not happen (state.branch is still null at that point — see
    // the function's own doc comment).
    assert.ok(!w.gitCalls.some((c) => c.startsWith("worktree add")),
      "ensureWorktreeForBuild must not fire while state.branch is unresolved");
  });
});

describe("runIssue — forge#2383: per-phase context pack", () => {
  it("threads a non-empty contextPack into runner() and records packBytes/packSections on PHASE_START", async () => {
    const { w, io } = fakeWorld();
    w.body = "## Problem\n\nSomething is broken.";
    const script = { "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; } };
    const calls = [];
    const runner = async (call) => { calls.push(call); script[call.commandName]?.(); return { status: "complete" }; };

    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 1 });

    assert.ok(calls.length > 0);
    const investigateCall = calls.find((c) => c.commandName === "work-on/investigate");
    assert.ok(investigateCall.contextPack, "contextPack must be forwarded to runner()");
    assert.match(investigateCall.contextPack, /Something is broken\./);

    const starts = readLog(dir, 42).filter((e) => e.event === "PHASE_START" && e.phase === "investigate");
    assert.ok(starts.length > 0);
    for (const s of starts) {
      assert.ok(typeof s.packBytes === "number" && s.packBytes > 0, "packBytes must be recorded as a positive number");
      assert.ok(Array.isArray(s.packSections) && s.packSections.includes("issue"), "packSections must list the included sections");
    }
  });

  it("fail-open: a gh failure while building the pack degrades to no contextPack, phase still dispatches normally", async () => {
    const { w, io } = fakeWorld();
    const origGh = io.gh;
    io.gh = async (args) => {
      const a = args.join(" ");
      if (a.startsWith("issue view") && a.includes("title,body")) throw new Error("simulated transient gh failure");
      return origGh(args);
    };
    const script = { "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; } };
    const calls = [];
    const runner = async (call) => { calls.push(call); script[call.commandName]?.(); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 1 });

    // The phase must still dispatch and reach its normal outcome — a pack
    // build failure must never block or crash the run (fail-open contract).
    assert.notEqual(res.terminalReason, "engine-error");
    assert.ok(calls.length > 0, "runner must still be called despite the pack-build gh failure");
  });

  it("reuses local run-log data for prior phase outputs without an extra gh call", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT:COMPLETE"; },
    };
    const calls = [];
    const runner = async (call) => {
      calls.push(call);
      script[call.commandName]?.();
      // Simulate #2380-style typed outputs from the investigate phase so the
      // "context" phase's own pack should include a Prior Phase Outputs section.
      return { status: "complete", outputs: call.commandName === "work-on/investigate" ? { verdict: "CONFIRMED" } : {} };
    };

    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 1 });

    const contextCall = calls.find((c) => c.commandName === "work-on/build/context");
    assert.ok(contextCall, "context phase must have dispatched");
    assert.ok(contextCall.contextPack, "context phase must receive a contextPack");
    assert.match(contextCall.contextPack, /Prior Phase Outputs/);
    assert.match(contextCall.contextPack, /"verdict": "CONFIRMED"/);
  });
});
