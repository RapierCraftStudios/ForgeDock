// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPiModelArgs,
  buildPiPhaseArgs,
  buildPiPhasePrompt,
  modelPattern,
  parseWorktrees,
  worktreeForBranch,
} from "../../pi/runtime/engine.mjs";
import { reconcileReviewFindings } from "../../pi/runtime/review-findings.mjs";

test("Pi runtime resolves provider/model objects into an explicit model pattern", () => {
  assert.equal(modelPattern({ provider: "openai", id: "gpt-5.5" }), "openai/gpt-5.5");
  assert.equal(modelPattern("anthropic/claude-sonnet"), "anthropic/claude-sonnet");
  assert.equal(modelPattern(undefined), undefined);
});

test("Pi runtime passes the active model and thinking level to workers", () => {
  assert.deepEqual(
    buildPiModelArgs({ model: { provider: "openai", id: "gpt-5.5" }, thinkingLevel: "high" }),
    ["--model", "openai/gpt-5.5", "--thinking", "high"],
  );
  assert.deepEqual(buildPiModelArgs({ thinkingLevel: "unsupported" }), []);
});

test("Pi worker argv is isolated and loads the selected ForgeDock extension", () => {
  assert.deepEqual(
    buildPiPhaseArgs({
      extensionPath: "C:/forge/pi/extensions/forgedock.ts",
      model: "anthropic/claude-sonnet",
      thinkingLevel: "medium",
      name: "forge-pi-42-build",
      prompt: "run phase",
    }),
    [
      "--no-session",
      "--approve",
      "--no-extensions",
      "-e",
      "C:/forge/pi/extensions/forgedock.ts",
      "--model",
      "anthropic/claude-sonnet",
      "--thinking",
      "medium",
      "--name",
      "forge-pi-42-build",
      "-p",
      "run phase",
    ],
  );
});

test("Pi runtime parses worktrees by branch ref, including Windows paths with spaces", () => {
  const output = [
    "worktree C:/Users/Me/Documents/My Project/.pi/worktrees/fix-42",
    "HEAD abc123",
    "branch refs/heads/fix/repair-42",
    "",
    "worktree C:/Users/Me/Documents/My Project",
    "HEAD def456",
    "detached",
    "",
  ].join("\n");
  const records = parseWorktrees(output);
  assert.equal(records.length, 2);
  assert.equal(worktreeForBranch(output, "fix/repair-42"), "C:/Users/Me/Documents/My Project/.pi/worktrees/fix-42");
  assert.equal(worktreeForBranch(output, "missing"), undefined);
});

test("historical resolved findings do not re-enter a clean review", () => {
  const result = reconcileReviewFindings({
    comments: [
      { body: "<!-- FORGE:REVIEW-AGENT:protocols --> <!-- FORGE:REVIEW-RUN:old-run --> <!-- FINDING:HISTORICAL -->" },
      { body: "<!-- FORGE:REVIEW-AGENT:protocols --> <!-- FORGE:REVIEW-RUN:current-run --> PASS" },
    ],
    runId: "current-run",
    domains: ["security", "workflow", "runtime", "protocols"],
    findingIssues: [
      { number: 1, state: "CLOSED", labels: [{ name: "review-finding" }, { name: "validated" }] },
      { number: 2, state: "OPEN", labels: ["review-finding", { name: "false-positive" }] },
    ],
  });
  assert.equal(result.currentRunFindings.length, 0);
  assert.equal(result.openPriorFindings.length, 0);
  assert.equal(result.hasBlockingFindings, false);
});

test("historical open findings remain blocking", () => {
  const result = reconcileReviewFindings({
    comments: [{ body: "<!-- FORGE:REVIEW-AGENT:workflow --> <!-- FORGE:REVIEW-RUN:old-run --> <!-- FINDING:OPEN -->" }],
    runId: "current-run",
    domains: ["security", "workflow", "runtime", "protocols"],
    findingIssues: [{ number: 3, state: "OPEN", labels: [{ name: "review-finding" }, "validated"] }],
  });
  assert.equal(result.currentRunFindings.length, 0);
  assert.equal(result.openPriorFindings.length, 1);
  assert.equal(result.hasBlockingFindings, true);
});

test("current-run findings block even without a prior finding issue", () => {
  const result = reconcileReviewFindings({
    comments: [{ body: "<!-- FORGE:REVIEW-AGENT:runtime --> <!-- FORGE:REVIEW-RUN:current-run --> <!-- FINDING:CURRENT -->" }],
    runId: "current-run",
    domains: ["security", "workflow", "runtime", "protocols"],
    findingIssues: [],
  });
  assert.equal(result.currentRunFindings.length, 1);
  assert.equal(result.openPriorFindings.length, 0);
  assert.equal(result.hasBlockingFindings, true);
});

test("a clean current run ignores historical comments after lifecycle reconciliation", () => {
  const result = reconcileReviewFindings({
    comments: [
      { body: "<!-- FORGE:REVIEW-AGENT:security --> <!-- FORGE:REVIEW-RUN:old-run --> <!-- FINDING:OLD -->" },
      { body: "<!-- FORGE:REVIEW-AGENT:security --> <!-- FORGE:REVIEW-RUN:current-run --> PASS" },
      { body: "<!-- FORGE:REVIEW-AGENT:workflow --> <!-- FORGE:REVIEW-RUN:current-run --> PASS" },
    ],
    runId: "current-run",
    domains: ["security", "workflow", "runtime", "protocols"],
    findingIssues: [{ number: 4, state: "CLOSED", labels: ["review-finding", { name: "false-positive" }] }],
  });
  assert.equal(result.currentRunFindings.length, 0);
  assert.equal(result.openPriorFindings.length, 0);
  assert.equal(result.hasBlockingFindings, false);
});

test("Pi phase prompt binds the worker to one phase and one working directory", () => {
  const prompt = buildPiPhasePrompt({
    forgeHome: "C:/forge",
    projectRoot: "C:/project",
    phaseCwd: "C:/project/.pi/worktrees/fix-42",
    issue: 42,
    commandName: "work-on/review",
    args: ["42"],
  });
  assert.match(prompt, /Execute exactly one workflow phase: work-on\/review/);
  assert.match(prompt, /Current working directory: C:\/project\/\.pi\/worktrees\/fix-42/);
  assert.match(prompt, /Do not run or summarize a later phase/);
});
