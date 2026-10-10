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
// Since interactive-engine.mjs uses top-level await (main()) and exits when
// run directly, its top-level main()/process.exit(0) is guarded behind a
// direct-execution check so the module can be safely imported for testing.
//
// parseTranscript/detectPhase/detectLane are `export`ed from the hook
// (issue #1580) and driven directly below against realistic nested Claude
// Code JSONL fixtures. phaseFromSkill is also
// `export`ed from the hook (since #1525) and imported directly below — no local reimplementations
// remain for any interactive-engine.mjs function.
//
// The extractFlag reimplementation further down is a separate, pre-existing
// case: it mirrors a private (non-exported) helper in a *different* hook,
// bin/hooks/pre-tool-use.mjs, not a subject of this file. Left as-is per
// #1592's investigation — recommended as a narrow follow-up on pre-tool-use.mjs.
// ---------------------------------------------------------------------------

import { appendEvent, deriveState, readLog } from "../engine/runlog.mjs";
import { reconcileState } from "../engine/reconcile.mjs";
import { detectTrustedOutcome } from "../engine/phases.mjs";
import { serializeState, parseState, upsertStateBlock } from "../engine/state.mjs";
import {
  parseTranscript,
  detectPhase,
  detectLane,
  phaseFromSkill,
  isMissingMarkerOutcome,
} from "../hooks/interactive-engine.mjs";

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
// Flag extraction (mirrors the hook's extractFlag)
//
// extractFlag belongs to a different hook, bin/hooks/pre-tool-use.mjs, which
// does not export it either — out of scope for #1592 (see header note above).
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

describe("detectPhase — skill + issue from Skill tool_use only (#1580, forge#3570)", () => {
  it("detects a Skill invocation and issue number from a nested tool_use block", () => {
    const path = writeTranscript(dir, [
      assistantToolUse("Skill", { skill: "work-on:investigate", args: "1580" }),
      userToolResult("<!-- INVESTIGATION:COMPLETE -->"),
    ]);
    const transcript = parseTranscript(path);
    assert.ok(transcript, "parseTranscript should successfully parse the fixture");
    const { skillInvoked, issueNumber, phaseId } = detectPhase(transcript);
    assert.equal(skillInvoked, true);
    assert.equal(issueNumber, 1580);
    assert.equal(phaseId, "investigate");
  });

  for (const [skill, phase] of [
    ["work-on:build:context", "context"],
    ["work-on:build:architect", "architect"],
    ["work-on:build", "build"],
    ["work-on:review", "review"],
    ["work-on:close", "close"],
  ]) {
    it(`derives phase ${phase} from skill ${skill}, ignoring marker text in tool_result and assistant text`, () => {
      const path = writeTranscript(dir, [
        assistantToolUse("Skill", { skill, args: "1580" }),
        userToolResult("INVESTIGATION:INVALID DECOMPOSE:YES workflow:merged FORGE:BUILDER:COMPLETE"),
        assistantText("quoting <!-- INVESTIGATION:INVALID --> and workflow:merged"),
      ]);
      const result = detectPhase(parseTranscript(path));
      assert.equal(result.phaseId, phase);
      assert.equal(result.issueNumber, 1580);
      assert.equal("terminalReason" in result, false, "no transcript-derived terminalReason");
      assert.equal("annotationMissing" in result, false);
      assert.deepEqual(result.outputs, {});
    });
  }

  it("a transcript quoting INVESTIGATION:INVALID yields no terminalReason and no marker-derived phase", () => {
    const path = writeTranscript(dir, [
      userToolResult("<!-- INVESTIGATION:INVALID -->"),
      assistantText("<!-- INVESTIGATION:INVALID -->"),
    ]);
    const result = detectPhase(parseTranscript(path));
    assert.equal(result.phaseId, null);
    assert.equal(result.skillInvoked, false);
    assert.equal("terminalReason" in result, false);
  });

  it("never extracts a branch or PR number from tool_result text (forge#2375)", () => {
    const path = writeTranscript(dir, [
      assistantToolUse("Skill", { skill: "work-on:review", args: "1580" }),
      userToolResult('branch refs/heads/fix/thing-1580 pushed\n{"number": 42, "state": "OPEN"}'),
    ]);
    const { phaseId, outputs } = detectPhase(parseTranscript(path));
    assert.equal(phaseId, "review");
    assert.deepEqual(outputs, {});
  });

  it("returns no phase/issue for an unrelated transcript (no Skill)", () => {
    const path = writeTranscript(dir, [
      assistantText("just chatting, nothing relevant"),
      userToolResult("plain command output"),
    ]);
    const { skillInvoked, issueNumber, phaseId } = detectPhase(parseTranscript(path));
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

// ---------------------------------------------------------------------------
// detectTrustedOutcome — GitHub ground truth via the engine's trusted, anchored
// detectors (forge#3570). Fake io returns JSONL comments with author data.
// ---------------------------------------------------------------------------

function fakeIo(comments, { ahead = "0" } = {}) {
  return {
    gh: async () => comments.map((c) => JSON.stringify(c)).join("\n"),
    git: async () => ahead,
  };
}
const trusted = (body) => ({ body, author_association: "OWNER", user: { type: "User", login: "owner" } });
const untrusted = (body) => ({ body, author_association: "NONE", user: { type: "User", login: "rando" } });
const st = (extra = {}) => ({ issue: 3570, lane: "staging", committed: [], branch: null, ...extra });

const CONFIRMED_REPORT = [
  "<!-- FORGE:INVESTIGATOR -->",
  "## Investigation Report",
  "The spec mentions INVESTIGATION:INVALID in prose only.",
  "",
  "### Decomposition Assessment",
  "**NO**",
  "<!-- INVESTIGATION:COMPLETE -->",
].join("\n");
const INVALID_REPORT = "<!-- FORGE:INVESTIGATOR -->\n## Report\nnot real\n<!-- INVESTIGATION:INVALID -->";

describe("detectTrustedOutcome — trusted + anchored markers only (forge#3570)", () => {
  it("quoted INVESTIGATION:INVALID in prose + trusted CONFIRMED report -> committed, no terminalReason", async () => {
    const out = await detectTrustedOutcome("investigate", st(), fakeIo([trusted(CONFIRMED_REPORT)]));
    assert.equal(out.status, "committed");
    assert.equal(out.terminalReason, undefined);
  });

  it("untrusted author (author_association NONE) with a perfectly anchored INVESTIGATION:INVALID report -> not committed", async () => {
    const out = await detectTrustedOutcome("investigate", st(), fakeIo([untrusted(INVALID_REPORT)]));
    assert.equal(out.status, "failed");
    assert.equal(out.terminalReason, undefined);
  });

  it("untrusted anchored COMPLETE report does not commit investigate", async () => {
    const out = await detectTrustedOutcome("investigate", st(), fakeIo([untrusted(CONFIRMED_REPORT)]));
    assert.equal(out.status, "failed");
  });

  it("trusted anchored INVALID report -> committed with terminalReason invalid", async () => {
    const out = await detectTrustedOutcome("investigate", st(), fakeIo([trusted(INVALID_REPORT)]));
    assert.equal(out.status, "committed");
    assert.equal(out.terminalReason, "invalid");
  });

  it("a Bot-authored (author_association NONE, user.type Bot) report is trusted", async () => {
    const bot = { body: CONFIRMED_REPORT, author_association: "NONE", user: { type: "Bot", login: "forge[bot]" } };
    const out = await detectTrustedOutcome("investigate", st(), fakeIo([bot]));
    assert.equal(out.status, "committed");
  });

  it("build commits on trusted anchored FORGE:BUILDER:COMPLETE with commits ahead", async () => {
    const body = "<!-- FORGE:BUILDER -->\n## Implementation Complete\n**Branch**: `fix/x-3570`\n<!-- FORGE:BUILDER:COMPLETE -->";
    const out = await detectTrustedOutcome("build", st(), fakeIo([trusted(body)], { ahead: "2" }));
    assert.equal(out.status, "committed");
    assert.equal(out.outputs.branch, "fix/x-3570");
  });

  it("build does not commit on an untrusted FORGE:BUILDER:COMPLETE comment", async () => {
    const body = "<!-- FORGE:BUILDER -->\n**Branch**: `fix/x-3570`\n<!-- FORGE:BUILDER:COMPLETE -->";
    const out = await detectTrustedOutcome("build", st(), fakeIo([untrusted(body)], { ahead: "2" }));
    assert.notEqual(out.status, "committed");
  });

  for (const [phase, header] of [["context", "FORGE:CONTEXT"], ["architect", "FORGE:ARCHITECT"]]) {
    it(`${phase} commits on trusted anchored ${header}:COMPLETE`, async () => {
      const body = `<!-- ${header} -->\n## x\n<!-- ${header}:COMPLETE -->`;
      assert.equal((await detectTrustedOutcome(phase, st(), fakeIo([trusted(body)]))).status, "committed");
    });
    it(`${phase} does not commit on a partial/bare ${header} marker`, async () => {
      const body = `<!-- ${header} -->\n## x\n<!-- ${header}:PARTIAL -->`;
      assert.equal((await detectTrustedOutcome(phase, st(), fakeIo([trusted(body)]))).status, "failed");
    });
    it(`${phase} does not commit when the marker is only quoted in prose or untrusted`, async () => {
      const prose = `I will post ${"`"}<!-- ${header}:COMPLETE -->${"`"} later`;
      const anchored = `<!-- ${header} -->\n<!-- ${header}:COMPLETE -->`;
      assert.equal((await detectTrustedOutcome(phase, st(), fakeIo([trusted(prose)]))).status, "failed");
      assert.equal((await detectTrustedOutcome(phase, st(), fakeIo([untrusted(anchored)]))).status, "failed");
    });
  }

  it("unknown phase id fails; fetch errors propagate (caller fails open)", async () => {
    assert.equal((await detectTrustedOutcome("bogus", st(), fakeIo([]))).status, "failed");
    const io = { gh: async () => { throw new Error("gh down"); }, git: async () => "0" };
    await assert.rejects(detectTrustedOutcome("context", st(), io), /gh down/);
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

describe("phaseFromSkill mapping — real module import (issue #1525, #1592)", () => {
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

describe("isMissingMarkerOutcome — enforce only on a missing marker (forge#3594)", () => {
  it("true for 'no <marker> marker' and builder complete=false", () => {
    assert.equal(isMissingMarkerOutcome({ status: "failed", detail: "no <!-- INVESTIGATION:COMPLETE --> marker" }), true);
    assert.equal(isMissingMarkerOutcome({ status: "failed", detail: "builder complete=false commitsAhead=-1 branch=unresolved" }), true);
  });
  it("false when the marker exists but the ahead-count could not be computed", () => {
    assert.equal(isMissingMarkerOutcome({ status: "failed", detail: "builder complete=true commitsAhead=-1 branch=fix/x" }), false);
  });
  it("false for committed, blocked, and missing outcomes", () => {
    assert.equal(isMissingMarkerOutcome({ status: "committed" }), false);
    assert.equal(isMissingMarkerOutcome({ status: "blocked", detail: "no x marker" }), false);
    assert.equal(isMissingMarkerOutcome(null), false);
  });
});
