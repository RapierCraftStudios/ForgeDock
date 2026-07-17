import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readLog, deriveState } from "../engine/runlog.mjs";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fd-runlog-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runlog", () => {
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
    assert.equal(s.complexity, null); // forge#2387
  });

  // forge#2387: deterministic scope classification carried through the fold,
  // same pattern as branch/pr above.
  it("deriveState: PHASE_COMMIT(investigate) with outputs.complexity carries it into state.complexity", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: { verdict: "CONFIRMED", complexity: "trivial" } });
    const s = deriveState(readLog(dir, 42));
    assert.equal(s.complexity, "trivial");
  });

  it("deriveState: PHASE_COMMIT(investigate) with outputs.complexity: null does NOT overwrite the null default (falsy values are not folded)", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: { verdict: "CONFIRMED", complexity: null } });
    const s = deriveState(readLog(dir, 42));
    assert.equal(s.complexity, null);
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
});
