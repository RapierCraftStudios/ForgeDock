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
import { parsePiReResolveConfig, piReResolveDecision } from "../../pi/runtime/reresolve.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const extensionSource = readFileSync(new URL("../../pi/extensions/forgedock.ts", import.meta.url), "utf8");

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

test("Pi package publishes the reviewer guidance at the package root", () => {
  assert.ok(packageJson.files.includes("AGENTS.md"));
});

test("Pi reviewer validates ForgeDock guidance before dispatch and reuses its path", () => {
  assert.match(extensionSource, /function requireReviewerGuidance\(forgeHome: string\): string/);
  assert.match(extensionSource, /statSync\(guidancePath\)\.isFile\(\)/);
  assert.match(extensionSource, /readFileSync\(guidancePath, "utf8"\)/);
  assert.match(extensionSource, /const guidancePath = requireReviewerGuidance\(forgeHome\);/);
  assert.match(extensionSource, /reviewAgentPrompt\(guidancePath, repo, pr, domain, runId, headSha\)/);
  assert.ok(
    extensionSource.indexOf("const guidancePath = requireReviewerGuidance(forgeHome);") <
      extensionSource.indexOf("Promise.all(domains.map"),
    "guidance must be validated before reviewer workers are spawned",
  );
});

test("Pi reviewer reads the complete durable comment ledger", () => {
  assert.match(
    extensionSource,
    /ghJson\(projectRoot, \["api", "--paginate", "--slurp", `repos\/\$\{repo\}\/issues\/\$\{pr\}\/comments`\]\)/,
  );
  assert.match(extensionSource, /const pages = ghJson[\s\S]*return pages\.flat\(\);/);
  assert.ok(
    extensionSource.indexOf("const readComments = () =>") < extensionSource.indexOf("decideReviewRunAdmission({ comments, headSha"),
    "the complete ledger must be loaded before review admission",
  );
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

test("Pi orchestration passes raw GitHub URLs to the shared preflight", () => {
  const source = readFileSync(new URL("../../pi/extensions/forgedock.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /function normalizeInput\(/);
  assert.match(source, /"--args", input\]/);
});

test("Pi re-resolves standing issue-search URLs after each ordinary completion event", () => {
  const source = readFileSync(new URL("../../pi/extensions/forgedock.ts", import.meta.url), "utf8");
  assert.match(source, /standingIssueSearchUrl = \/\^https:\\\/\\\/\/i\.test\(String\(plan\.input \|\| ""\)\.trim\(\)\)/);
  assert.match(source, /await Promise\.race\(running\.values\(\)\)[\s\S]*if \(standingIssueSearchUrl && piReResolveDecision\(reResolveConfig, reResolveRounds\)\.reResolve\)[\s\S]*reResolveRounds \+= 1;[\s\S]*preflight\(forgeHome, projectRoot, input\)/);
  assert.doesNotMatch(source, /await Promise\.all\(batch\.map/);
  assert.match(source, /if \(completed\.has\(issue\.number\) \|\| blocked\.has\(issue\.number\) \|\| running\.has\(issue\.number\)\) continue;[\s\S]*pending\.add\(issue\.number\)/);
  assert.match(source, /externalDependencies/);
});

test("Pi standing-query refresh honors the configured disable switch and round cap", () => {
  const disabled = parsePiReResolveConfig(`
project:
  owner: example
orchestration:
  reresolve:
    enabled: false
    max_rounds: 5
  cascade:
    enabled: true
    max_rounds: 99
`);
  assert.deepEqual(disabled, { enabled: false, maxRounds: 5 });
  assert.equal(piReResolveDecision(disabled, 0).reResolve, false);

  const bounded = parsePiReResolveConfig(`
orchestration:
  reresolve:
    enabled: true
    max_rounds: 2
`);
  assert.equal(piReResolveDecision(bounded, 1).reResolve, true);
  assert.equal(piReResolveDecision(bounded, 2).reResolve, false);
});

test("Pi standing-query controls preserve valid YAML representations", () => {
  const inline = parsePiReResolveConfig(`
"orchestration": { "reresolve": { "enabled": false, "max_rounds": 1 } }
`);
  assert.deepEqual(inline, { enabled: false, maxRounds: 1 });
  assert.equal(piReResolveDecision(inline, 0).reResolve, false);

  const quotedKeys = parsePiReResolveConfig(`
'orchestration':
  'reresolve':
    'enabled': true
    'max_rounds': 2
`);
  assert.deepEqual(quotedKeys, { enabled: true, maxRounds: 2 });
  assert.equal(piReResolveDecision(quotedKeys, 1).reResolve, true);
  assert.equal(piReResolveDecision(quotedKeys, 2).reResolve, false);

  const malformed = parsePiReResolveConfig("orchestration: [unterminated");
  assert.deepEqual(malformed, { enabled: false });
  assert.equal(piReResolveDecision(malformed, 0).reResolve, false);
});
