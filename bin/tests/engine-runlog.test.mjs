import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readLog, deriveState } from "../engine/runlog.mjs";
import { runIssue } from "../engine.mjs";
import { serializeState } from "../engine/state.mjs";
import { asComments, inv as investigationComment, ctx, arch, builder, remediation, decomposed } from "./helpers/comments.mjs";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fd-runlog-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runlog", () => {
  it("a blocked PHASE_COMMIT persists its pr and terminalReason across deriveState (forge#3503/#3504)", () => {
    appendEvent(dir, 7, { event: "RUN_START", issue: 7, run: "r", lane: "staging" });
    appendEvent(dir, 7, { event: "PHASE_COMMIT", phase: "review", outputs: { pr: 12 }, terminalReason: "needs-human" });
    const s = deriveState(readLog(dir, 7));
    assert.equal(s.pr, 12);
    assert.equal(s.terminalReason, "needs-human");
    assert.ok(s.committed.includes("review"));
  });

  it("forge#3530: the review remediation kind survives deriveState; a remediate commit consumes it; a later review replaces it", () => {
    appendEvent(dir, 7, { event: "RUN_START", issue: 7, run: "r", lane: "staging" });
    appendEvent(dir, 7, { event: "PHASE_COMMIT", phase: "review", outputs: { pr: 12, remediation: "base-sync" }, terminalReason: "needs-human" });
    assert.equal(deriveState(readLog(dir, 7)).remediationKind, "base-sync");
    appendEvent(dir, 7, { event: "PHASE_COMMIT", phase: "remediate", outputs: {} });
    assert.equal(deriveState(readLog(dir, 7)).remediationKind, null);
    appendEvent(dir, 7, { event: "PHASE_COMMIT", phase: "review", outputs: { pr: 12, remediation: "ci-gate" } });
    assert.equal(deriveState(readLog(dir, 7)).remediationKind, "ci-gate");
  });

  it("append then read returns events in order with assigned seq", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_START", phase: "investigate" });
    const events = readLog(dir, 42);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.seq), [1, 2]);
    assert.equal(events[0].event, "RUN_START");
  });

  it("readLog tolerates a truncated final line (crash mid-write)", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42 });
    appendFileSync(join(dir, "42.jsonl"), '{"seq":2,"event":"PHA'); // no newline, partial JSON
    const events = readLog(dir, 42);
    assert.equal(events.length, 1); // partial final line ignored
  });

  it("deriveState: a PHASE_START without a following PHASE_COMMIT is NOT committed", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_START", phase: "investigate" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 42, { event: "PHASE_START", phase: "build" }); // crashed here
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate"]);
    assert.equal(s.v, 3);       // last committed seq
    assert.equal(s.terminal, false);
  });

  it("deriveState: RUN_TERMINAL sets terminal + reason and carries branch/pr from commits", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "build", outputs: { branch: "fix/x-42" } });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "review", outputs: { pr: 7 } });
    appendEvent(dir, 42, { event: "RUN_TERMINAL", reason: "merged" });
    const s = deriveState(readLog(dir, 42));
    assert.equal(s.terminal, true);
    assert.equal(s.terminalReason, "merged");
    assert.equal(s.branch, "fix/x-42");
    assert.equal(s.pr, 7);
  });

  it("deriveState of empty log is a zero-value state", () => {
    const s = deriveState([]);
    assert.equal(s.v, 0);
    assert.deepEqual(s.committed, []);
    assert.equal(s.phase, null);
  });

  it("readLog throws on corrupted non-final line (mid-file data loss)", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42 });
    appendFileSync(join(dir, "42.jsonl"), "not json\n"); // corrupted line in the middle
    appendFileSync(join(dir, "42.jsonl"), '{"seq":3,"event":"PHASE_COMMIT","phase":"investigate","outputs":{}}\n');
    assert.throws(
      () => readLog(dir, 42),
      /corrupt run-log line/,
      "should throw on mid-file corruption"
    );
  });

  // forge#3506: the writer side. These drive runIssue itself rather than hand-building events.
  function world() {
    const w = { markers: "", pr: null, prNeedsHuman: false, issueState: "OPEN", labels: [], commitsAhead: 0, body: "Issue." };
    const io = {
      gh: async (args) => {
        const a = args.join(" ");
        if (a.startsWith("repo view")) return "acme/widgets";
        if (a.startsWith("api ") && a.includes("/comments")) return asComments(w.markers);
        if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: w.body });
        if (a.startsWith("issue view")) return JSON.stringify({ state: w.issueState, labels: w.labels });
        if (a.startsWith("issue edit")) {
          const bi = args.indexOf("--body"); if (bi >= 0) w.body = args[bi + 1];
          const li = args.indexOf("--add-label"); if (li >= 0) w.labels.push(args[li + 1]);
          return "";
        }
        if (a.startsWith("pr list")) return JSON.stringify(w.pr ? [{ number: w.pr }] : []);
        if (a.startsWith("pr view")) return JSON.stringify({ number: w.pr, state: "OPEN", mergedAt: null,
          labels: w.prNeedsHuman ? [{ name: "needs-human" }] : [] });
        return "";
      },
      git: async (args) => {
        if (args?.[0] === "worktree") return "worktree /repo\nHEAD 0\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/fix-b-42\nHEAD 1\nbranch refs/heads/fix/b-42\n";
        return String(w.commitsAhead);
      },
    };
    return { w, io };
  }

  it("forge#3506: runIssue writes pr and terminalReason needs-human into the blocked review PHASE_COMMIT", async () => {
    const { w, io } = world();
    const script = {
      "work-on/investigate": () => { w.markers += investigationComment("COMPLETE"); },
      "work-on/build": () => { w.markers += builder("fix/b-42"); w.commitsAhead = 1; },
      "work-on/review": () => { w.pr = 7; w.prNeedsHuman = true; w.labels.push("needs-human"); },
      "work-on/remediate": () => { w.markers += remediation("HELD-AWAITING-MERGE"); },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };
    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 1 });
    const commits = Object.fromEntries(readLog(dir, 42).filter(e => e.event === "PHASE_COMMIT").map(e => [e.phase, e]));
    assert.equal(commits.review.outputs.pr, 7);
    assert.equal(commits.review.terminalReason, "needs-human");
    // committed-outcome reasons are persisted too (remediate -> awaiting-merge)
    assert.equal(commits.remediate.terminalReason, "awaiting-merge");
    assert.equal(commits.build.terminalReason, undefined);
  });

  it("forge#3506: runIssue persists investigate's decomposed reason on its PHASE_COMMIT", async () => {
    const { w, io } = world();
    w.markers = investigationComment("COMPLETE", { decompose: true });
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/decompose") w.markers += decomposed();
      return { status: "complete" };
    };
    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 1 });
    const inv = readLog(dir, 42).find(e => e.event === "PHASE_COMMIT" && e.phase === "investigate");
    assert.equal(inv.terminalReason, "decomposed");
  });

  it("forge#3506: a hydrated log (eventsFromIndex via rewriteLog) derives the same reason as a local-log resume", async () => {
    const { w, io } = world();
    w.body = serializeState({
      v: 5, run: "r_42_staging", issue: 42, lane: "staging",
      committed: ["investigate", "build", "review"], phase: "remediate", branch: "fix/b-42", pr: 7,
      terminal: false, terminalReason: "needs-human", lease: null,
    });
    w.pr = 7; w.prNeedsHuman = true; w.commitsAhead = 1;
    w.markers = investigationComment("COMPLETE") + builder("fix/b-42");
    let seen = null;
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/remediate") {
        seen = deriveState(readLog(dir, 42));
        w.markers += remediation("RE-ESCALATED");
      }
      return { status: "complete" };
    };
    await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1000, maxAttempts: 1 });
    assert.equal(seen.terminalReason, "needs-human");
    assert.equal(seen.pr, 7);
    assert.equal(seen.terminal, false, "a non-terminal handoff reason must not be replayed as RUN_TERMINAL");
    assert.deepEqual(seen.committed, ["investigate", "build", "review"]);
  });
});
