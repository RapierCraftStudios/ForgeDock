// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPiModelArgs,
  buildPiPhaseArgs,
  buildPiPhasePrompt,
  modelPattern,
  parseWorktrees,
  worktreeForBranch,
} from "../../pi/runtime/engine.mjs";

const forgedockExtension = readFileSync(new URL("../../pi/extensions/forgedock.ts", import.meta.url), "utf8");

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

test("Pi review launch failures are normalized before the durable blocked-panel gate", () => {
  assert.match(forgedockExtension, /function failedProcessResult\(error: unknown\)/);
  assert.match(
    forgedockExtension,
    /catch \(error\) \{\s*return \{ domain, result: failedProcessResult\(error\) \};\s*\}/,
  );

  const reviewResultsStart = forgedockExtension.indexOf("const reviewResults = await Promise.all");
  const incompletePanelStart = forgedockExtension.indexOf("if (missing.length || reviewResults.some", reviewResultsStart);
  const findingsStart = forgedockExtension.indexOf("const findings = comments.filter", incompletePanelStart);
  assert.ok(reviewResultsStart >= 0);
  assert.ok(incompletePanelStart > reviewResultsStart);
  assert.ok(findingsStart > incompletePanelStart);

  const incompletePanel = forgedockExtension.slice(incompletePanelStart, findingsStart);
  assert.match(incompletePanel, /FORGE:GATE_FAILURE:TYPE=review-panel-integrity/);
  assert.match(incompletePanel, /FORGE:REVIEW_BLOCKED/);
  assert.match(incompletePanel, /needs-human/);
  assert.match(incompletePanel, /review-degraded/);
  assert.doesNotMatch(incompletePanel, /<!-- FORGE:GATE_PASS -->/);
  assert.doesNotMatch(incompletePanel, /<!-- FORGE:REVIEW -->/);
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
