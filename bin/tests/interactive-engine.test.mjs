/**
 * bin/tests/interactive-engine.test.mjs
 *
 * Unit tests for the interactive engine adapter hook (issue #1323).
 * Tests the phase detection and run-log commit logic.
 *
 * Run with: node --test bin/tests/interactive-engine.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Import the pure helpers we can test without Claude Code integration.
// We re-export them from the hook for testability via a thin adapter below.
// Since interactive-engine.mjs uses top-level await (main()) and exits,
// we test its internal logic by reconstructing the key functions here.
//
// parseTranscript/detectPhase/detectLane are now `export`ed from the hook
// (issue #1580), and the hook's top-level main()/process.exit(0) is guarded
// behind a direct-execution check, so those three are imported and driven
// directly below against realistic nested Claude Code JSONL fixtures rather
// than reconstructed. The PHASE_MARKERS/detectPhaseFromText/phaseFromSkill
// re-implementations further down remain for focused marker-matching and
// skill-name-normalization unit tests that don't need a transcript at all.
// ---------------------------------------------------------------------------

import { appendEvent, deriveState, readLog } from "../engine/runlog.mjs";
import { reconcileState } from "../engine/reconcile.mjs";
import { serializeState, parseState, upsertStateBlock } from "../engine/state.mjs";
import { parseTranscript, detectPhase, detectLane } from "../hooks/interactive-engine.mjs";

// ---------------------------------------------------------------------------
// Helper: simulate what the hook does after detecting a phase
// ---------------------------------------------------------------------------

function commitPhase(dir, issueNumber, phaseId, outputs = {}, terminalReason = null, lane = "staging") {
  const existing = readLog(dir, issueNumber);
  let state = existing.length ? deriveState(existing) : null;

  if (!state) {
    state = {
      v: 0,
      run: `r_${issueNumber}_${lane}_interactive`,
      issue: issueNumber,
      lane,
      committed: [],
      phase: null,
      branch: null,
      pr: null,
      terminal: false,
      terminalReason: null,
      lease: null,
    };
    appendEvent(dir, issueNumber, {
      event: "RUN_START",
      issue: issueNumber,
      run: state.run,
      lane,
      source: "interactive",
    });
  }

  if (state.committed.includes(phaseId)) return deriveState(readLog(dir, issueNumber));

  appendEvent(dir, issueNumber, {
    event: "PHASE_COMMIT",
    phase: phaseId,
    outputs,
    source: "interactive",
  });
  state = deriveState(readLog(dir, issueNumber));

  if (terminalReason) {
    appendEvent(dir, issueNumber, {
      event: "RUN_TERMINAL",
      reason: terminalReason,
      source: "interactive",
    });
    state = deriveState(readLog(dir, issueNumber));
  }
  return state;
}

// ---------------------------------------------------------------------------
// Phase detection logic (mirrors the hook's detectPhase)
// ---------------------------------------------------------------------------

const PHASE_MARKERS = [
  { marker: "INVESTIGATION:COMPLETE",  phase: "investigate" },
  { marker: "INVESTIGATION:INVALID",   phase: "investigate", terminal: true, terminalReason: "invalid" },
  { marker: "DECOMPOSE:YES",           phase: "investigate", terminal: true, terminalReason: "decomposed" },
  { marker: "FORGE:CONTEXT",           phase: "context" },
  { marker: "FORGE:ARCHITECT",         phase: "architect" },
  { marker: "FORGE:BUILDER:COMPLETE",  phase: "build" },
  { marker: "FORGE:REVIEWER:MERGED",   phase: "review" },
  { marker: "workflow:merged",         phase: "close", terminal: true, terminalReason: "merged" },
];

function detectPhaseFromText(text) {
  let phaseId = null;
  let terminalReason = null;
  for (const { marker, phase, terminal, terminalReason: tr } of PHASE_MARKERS) {
    if (text.includes(marker)) {
      phaseId = phase;
      if (terminal) { terminalReason = tr; break; }
    }
  }
  return { phaseId, terminalReason };
}

// ---------------------------------------------------------------------------
// Skill-name-to-phase fallback (mirrors the hook's phaseFromSkill)
// ---------------------------------------------------------------------------

function phaseFromSkill(skill) {
  const normalized = String(skill || "").replace(/\//g, ":");
  const map = {
    "work-on:investigate": "investigate",
    "work-on:build:context": "context",
    "work-on:build:architect": "architect",
    "work-on:build": "build",
    "work-on:review": "review",
    "work-on:close": "close",
  };
  return map[normalized] || null;
}

// ---------------------------------------------------------------------------
// Flag extraction (mirrors the hook's extractFlag)
// ---------------------------------------------------------------------------

function extractFlag(command, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const eqRe = new RegExp(`${escaped}=([^\\s"']+|"[^"]*"|'[^']*')`);
  const eqM = command.match(eqRe);
  if (eqM) return eqM[1].replace(/^["']|["']$/g, "");
  const spaceRe = new RegExp(`${escaped}\\s+([^-\\s"'][^\\s"']*|"[^"]*"|'[^']*')`);
  const spaceM = command.match(spaceRe);
  if (spaceM) return spaceM[1].replace(/^["']|["']$/g, "");
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let dir;
beforeEach(() => { dir = mkdtempSync(join(os.tmpdir(), "fd-iengine-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Real nested Claude Code transcript fixtures — drives the ACTUAL exported
// parseTranscript/detectPhase/detectLane from the hook, not a
// re-implementation (issue #1580). Real transcript lines nest role/content
// under `message`, e.g.:
//   {"type":"assistant","message":{"role":"assistant","content":[
//     {"type":"tool_use","name":"Skill","input":{...}}]}}
//   {"type":"user","message":{"role":"user","content":[
//     {"type":"tool_result","content":[{"type":"text","text":"..."}]}]}}
// ---------------------------------------------------------------------------

function writeTranscript(dirPath, lines) {
  const path = join(dirPath, "transcript.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return path;
}

function assistantToolUse(name, input) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } };
}

function userToolResult(text) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text }] }] },
  };
}

function assistantText(text) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

describe("detectPhase — real nested Claude Code transcript schema (#1580)", () => {
  it("detects a Skill invocation and issue number from a nested tool_use block", () => {
    const path = writeTranscript(dir, [
      assistantToolUse("Skill", { skill: "work-on:investigate", args: "1580" }),
      userToolResult("<!-- INVESTIGATION:COMPLETE -->"),
    ]);
    const transcript = parseTranscript(path);
    assert.ok(transcript, "parseTranscript should successfully parse the fixture");
    const { skillInvoked, issueNumber, phaseId, annotationMissing } = detectPhase(transcript);
    assert.equal(skillInvoked, true);
    assert.equal(issueNumber, 1580);
    assert.equal(phaseId, "investigate");
    assert.equal(annotationMissing, false);
  });

  it("extracts FORGE marker from a nested tool_result block, not top-level entry.type", () => {
    const path = writeTranscript(dir, [
      assistantToolUse("Skill", { skill: "work-on:build:context", args: "1580" }),
      userToolResult("<!-- FORGE:CONTEXT -->\nsome gh output\n<!-- FORGE:CONTEXT:COMPLETE -->"),
    ]);
    const transcript = parseTranscript(path);
    const { phaseId, skillInvoked, annotationMissing } = detectPhase(transcript);
    assert.equal(phaseId, "context");
    assert.equal(skillInvoked, true);
    assert.equal(annotationMissing, false);
  });

  it("extracts FORGE marker from a nested assistant text block", () => {
    const path = writeTranscript(dir, [
      assistantToolUse("Skill", { skill: "work-on:build:architect", args: "1580" }),
      assistantText("Posting the plan now.\n<!-- FORGE:ARCHITECT -->\n...\n<!-- FORGE:ARCHITECT:COMPLETE -->"),
    ]);
    const transcript = parseTranscript(path);
    const { phaseId, annotationMissing } = detectPhase(transcript);
    assert.equal(phaseId, "architect");
    assert.equal(annotationMissing, false);
  });

  it("flags annotationMissing when a Skill runs but no FORGE marker is found", () => {
    const path = writeTranscript(dir, [
      assistantToolUse("Skill", { skill: "work-on:build:context", args: "1580" }),
      userToolResult("no markers here, just noise"),
    ]);
    const transcript = parseTranscript(path);
    const { skillInvoked, annotationMissing, phaseId } = detectPhase(transcript);
    assert.equal(skillInvoked, true);
    assert.equal(annotationMissing, true);
    // Falls back to phaseFromSkill("work-on:build:context") = "context".
    assert.equal(phaseId, "context");
  });

  it("extracts PR number and branch from a nested tool_result block", () => {
    const path = writeTranscript(dir, [
      assistantToolUse("Skill", { skill: "work-on:review", args: "1580" }),
      userToolResult('branch refs/heads/fix/thing-1580 pushed\n{"number": 42, "state": "OPEN"}\nFORGE:REVIEWER:MERGED'),
    ]);
    const transcript = parseTranscript(path);
    const { phaseId, outputs } = detectPhase(transcript);
    assert.equal(phaseId, "review");
    assert.equal(outputs.pr, 42);
    assert.match(outputs.branch, /fix\/thing-1580/);
  });

  it("returns no phase/issue for an unrelated transcript (no Skill, no markers)", () => {
    const path = writeTranscript(dir, [
      assistantText("just chatting, nothing relevant"),
      userToolResult("plain command output"),
    ]);
    const transcript = parseTranscript(path);
    const { skillInvoked, issueNumber, phaseId } = detectPhase(transcript);
    assert.equal(skillInvoked, false);
    assert.equal(issueNumber, null);
    assert.equal(phaseId, null);
  });
});

describe("detectLane — real nested Claude Code transcript schema (#1580)", () => {
  it("detects the feature lane from a nested tool_result mentioning milestone/", () => {
    const path = writeTranscript(dir, [
      userToolResult("Creating worktree on milestone/durable-onboarding-engine"),
    ]);
    const transcript = parseTranscript(path);
    assert.equal(detectLane(transcript), "feature");
  });

  it("detects the staging lane from a nested tool_result mentioning staging", () => {
    const path = writeTranscript(dir, [
      userToolResult("git worktree add ... origin/staging"),
    ]);
    const transcript = parseTranscript(path);
    assert.equal(detectLane(transcript), "staging");
  });

  it("returns null when no lane signal is present", () => {
    const path = writeTranscript(dir, [
      userToolResult("no lane info here"),
    ]);
    const transcript = parseTranscript(path);
    assert.equal(detectLane(transcript), null);
  });
});

describe("phase detection from marker text", () => {
  it("detects investigate from INVESTIGATION:COMPLETE", () => {
    const { phaseId, terminalReason } = detectPhaseFromText("INVESTIGATION:COMPLETE marker found");
    assert.equal(phaseId, "investigate");
    assert.equal(terminalReason, null);
  });

  it("detects invalid terminal from INVESTIGATION:INVALID", () => {
    const { phaseId, terminalReason } = detectPhaseFromText("INVESTIGATION:INVALID — not actionable");
    assert.equal(phaseId, "investigate");
    assert.equal(terminalReason, "invalid");
  });

  it("detects decomposed terminal from DECOMPOSE:YES", () => {
    const { phaseId, terminalReason } = detectPhaseFromText("DECOMPOSE:YES sub-issues spawned");
    assert.equal(phaseId, "investigate");
    assert.equal(terminalReason, "decomposed");
  });

  it("detects context phase from FORGE:CONTEXT", () => {
    const { phaseId } = detectPhaseFromText("<!-- FORGE:CONTEXT -->");
    assert.equal(phaseId, "context");
  });

  it("detects architect phase from FORGE:ARCHITECT", () => {
    const { phaseId } = detectPhaseFromText("FORGE:ARCHITECT annotation posted");
    assert.equal(phaseId, "architect");
  });

  it("detects build phase from FORGE:BUILDER:COMPLETE", () => {
    const { phaseId } = detectPhaseFromText("FORGE:BUILDER:COMPLETE");
    assert.equal(phaseId, "build");
  });

  it("detects merged terminal from workflow:merged", () => {
    const { phaseId, terminalReason } = detectPhaseFromText("added label workflow:merged");
    assert.equal(phaseId, "close");
    assert.equal(terminalReason, "merged");
  });

  it("returns null for unrelated text", () => {
    const { phaseId, terminalReason } = detectPhaseFromText("some random output");
    assert.equal(phaseId, null);
    assert.equal(terminalReason, null);
  });
});

describe("run-log commit logic", () => {
  it("bootstraps a fresh run on first phase commit", () => {
    const state = commitPhase(dir, 1323, "investigate");
    assert.ok(state.run.startsWith("r_1323_staging_interactive"));
    assert.deepEqual(state.committed, ["investigate"]);
    assert.equal(state.terminal, false);
  });

  it("commits phases sequentially and accumulates", () => {
    commitPhase(dir, 1323, "investigate");
    commitPhase(dir, 1323, "context");
    commitPhase(dir, 1323, "architect");
    const state = commitPhase(dir, 1323, "build", { branch: "fix/pipeline-1323" });
    assert.deepEqual(state.committed, ["investigate", "context", "architect", "build"]);
    assert.equal(state.branch, "fix/pipeline-1323");
  });

  it("is idempotent: committing the same phase twice has no effect", () => {
    commitPhase(dir, 1323, "investigate");
    const state = commitPhase(dir, 1323, "investigate"); // duplicate
    assert.deepEqual(state.committed, ["investigate"]);
    // Run-log should have exactly one PHASE_COMMIT for investigate.
    const events = readLog(dir, 1323).filter((e) => e.event === "PHASE_COMMIT");
    assert.equal(events.length, 1);
  });

  it("writes RUN_TERMINAL when terminalReason is set", () => {
    commitPhase(dir, 1323, "investigate", {}, "invalid");
    const events = readLog(dir, 1323);
    const terminal = events.find((e) => e.event === "RUN_TERMINAL");
    assert.ok(terminal);
    assert.equal(terminal.reason, "invalid");
  });

  it("marks terminal state for merged", () => {
    commitPhase(dir, 1323, "investigate");
    commitPhase(dir, 1323, "context");
    commitPhase(dir, 1323, "architect");
    commitPhase(dir, 1323, "build", { branch: "fix/b" });
    commitPhase(dir, 1323, "review", { pr: 42 });
    const state = commitPhase(dir, 1323, "close", {}, "merged");
    assert.equal(state.terminal, true);
    assert.equal(state.terminalReason, "merged");
    assert.deepEqual(state.committed, ["investigate", "context", "architect", "build", "review", "close"]);
  });

  it("persists across separate readLog calls (simulates session resume)", () => {
    commitPhase(dir, 1323, "investigate");
    commitPhase(dir, 1323, "context");
    // Simulate a new session reading the log.
    const state = deriveState(readLog(dir, 1323));
    assert.deepEqual(state.committed, ["investigate", "context"]);
  });
});

describe("FORGE:STATE round-trip (state.mjs)", () => {
  it("serializes and parses run state correctly", () => {
    const s = {
      v: 2, run: "r_1323_staging_interactive", issue: 1323, lane: "staging",
      committed: ["investigate", "context"], phase: null, branch: null,
      pr: null, terminal: false, terminalReason: null, lease: null,
    };
    const body = upsertStateBlock("Issue body.", s);
    const parsed = parseState(body);
    assert.equal(parsed.issue, 1323);
    assert.deepEqual(parsed.committed, ["investigate", "context"]);
  });

  it("upserts in place on second write", () => {
    const s1 = { v: 1, committed: ["investigate"] };
    const body1 = upsertStateBlock("", s1);
    const s2 = { v: 2, committed: ["investigate", "context"] };
    const body2 = upsertStateBlock(body1, s2);
    // Should contain exactly one FORGE:STATE block (upserted in place).
    const count = (body2.match(/FORGE:STATE/g) || []).length;
    assert.equal(count, 1); // exactly one block, not duplicated
    const parsed = parseState(body2);
    assert.deepEqual(parsed.committed, ["investigate", "context"]);
  });
});

describe("reconcileState — GitHub wins", () => {
  it("prefers remote when remote.v > local.v", () => {
    const local = { v: 1, committed: ["investigate"] };
    const remote = { v: 3, committed: ["investigate", "context", "architect"] };
    const { state, action } = reconcileState(local, remote);
    assert.equal(action, "hydrate");
    assert.deepEqual(state.committed, ["investigate", "context", "architect"]);
  });

  it("prefers local when local is ahead of remote (crash pre-mirror)", () => {
    const local = { v: 5, committed: ["investigate", "context"] };
    const remote = { v: 2, committed: ["investigate"] };
    const { state, action } = reconcileState(local, remote);
    assert.equal(action, "remirror");
    assert.deepEqual(state.committed, ["investigate", "context"]);
  });
});

describe("phaseFromSkill mapping (issue #1525)", () => {
  it("resolves colon-separated skill names to their phase", () => {
    assert.equal(phaseFromSkill("work-on:investigate"), "investigate");
    assert.equal(phaseFromSkill("work-on:build:context"), "context");
    assert.equal(phaseFromSkill("work-on:build:architect"), "architect");
    assert.equal(phaseFromSkill("work-on:build"), "build");
    assert.equal(phaseFromSkill("work-on:review"), "review");
    assert.equal(phaseFromSkill("work-on:close"), "close");
  });

  it("normalizes legacy slash-separated skill names before lookup", () => {
    assert.equal(phaseFromSkill("work-on/investigate"), "investigate");
    assert.equal(phaseFromSkill("work-on/build/context"), "context");
    assert.equal(phaseFromSkill("work-on/build/architect"), "architect");
    assert.equal(phaseFromSkill("work-on/build"), "build");
    assert.equal(phaseFromSkill("work-on/review"), "review");
    assert.equal(phaseFromSkill("work-on/close"), "close");
  });

  it("returns null for unknown skill names", () => {
    assert.equal(phaseFromSkill("quality-gate"), null);
    assert.equal(phaseFromSkill("review-pr"), null);
  });

  it("returns null for empty or missing input", () => {
    assert.equal(phaseFromSkill(""), null);
    assert.equal(phaseFromSkill(undefined), null);
  });
});

describe("extractFlag helper", () => {
  it("extracts --base value (space form)", () => {
    assert.equal(extractFlag("gh pr create --base staging --title foo", "--base"), "staging");
  });

  it("extracts --base value (equals form)", () => {
    assert.equal(extractFlag("gh pr create --base=main --title foo", "--base"), "main");
  });

  it("extracts --base value (quoted)", () => {
    assert.equal(extractFlag('gh pr create --base "staging" --title foo', "--base"), "staging");
  });

  it("returns null when flag not present", () => {
    assert.equal(extractFlag("gh pr create --title foo", "--base"), null);
  });

  it("extracts --add-label value", () => {
    assert.equal(
      extractFlag("gh issue edit 42 --add-label workflow:building", "--add-label"),
      "workflow:building",
    );
  });
});
