// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const forgeExtensionSource = readFileSync(new URL("../../pi/extensions/forgedock.ts", import.meta.url), "utf8");

import {
  buildPiModelArgs,
  buildPiPhaseArgs,
  buildPiPhasePrompt,
  modelPattern,
  parseWorktrees,
  worktreeForBranch,
} from "../../pi/runtime/engine.mjs";

test("Pi review preserves work-on arguments and keeps direct review non-merging", () => {
  const requiredParserContracts = [
    /type ReviewInvocation = \{/,
    /token === "--auto-merge"/,
    /token === "--issue"/,
    /token === "--base"/,
    /token === "--gh-flag"/,
    /split\(\/\\s\+\/\)/,
  ];
  for (const contract of requiredParserContracts) assert.match(forgeExtensionSource, contract);
  assert.match(forgeExtensionSource, /if \(invocation\.autoMerge\)/);
  assert.match(forgeExtensionSource, /String\(params\.pr\)/);
  assert.match(forgeExtensionSource, /Direct review mode does not merge PRs/);
  assert.doesNotMatch(forgeExtensionSource, /function resolveReviewPr\(/);
});

test("Pi review auto-merge uses guarded shell-free argv and durable verification", () => {
  assert.match(forgeExtensionSource, /reviewGuardBlockers\(prSnapshot, issueSnapshot, invocation\)/);
  assert.match(forgeExtensionSource, /mergeable !== "MERGEABLE"/);
  assert.match(forgeExtensionSource, /mergeStateStatus !== "CLEAN"/);
  assert.match(forgeExtensionSource, /\["pr", "merge", String\(invocation\.pr\), "-R", repo, "--merge"\]/);
  assert.match(forgeExtensionSource, /--add-label", "needs-human/);
  assert.match(forgeExtensionSource, /--json", "state,mergedAt"/);
  assert.match(forgeExtensionSource, /verified\.state !== "MERGED" \|\| !verified\.mergedAt/);
});

test("Pi review scopes findings to the current durable reviewer run", () => {
  assert.match(forgeExtensionSource, /comment\.body\.includes\(`<!-- FORGE:REVIEW-RUN:\$\{runId\} -->`\)/);
  assert.match(forgeExtensionSource, /FINDING:\[\^>\]\+ -->/);
});

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
