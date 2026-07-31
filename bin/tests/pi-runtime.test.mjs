// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPiChildEnv,
  buildPiModelArgs,
  buildPiPhaseArgs,
  buildPiPhasePrompt,
  buildPiSubagentArgs,
  modelPattern,
  parseWorktrees,
  resolvePiLaunch,
  worktreeForBranch,
} from "../../pi/runtime/engine.mjs";

test("Pi runtime resolves a Windows npm shim to a shell-free Node launch", () => {
  const shimPath = "C:\\Pi\\pi.cmd";
  const scriptPath = "C:\\Pi\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js";
  const files = new Map([
    [shimPath, String.raw`@ECHO off
SET dp0=%~dp0
"%_prog%" "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*`],
    [scriptPath, ""],
  ]);
  const launch = resolvePiLaunch({
    platform: "win32",
    executablePath: shimPath,
    nodeExecutable: "C:\\Node\\node.exe",
    readFile: (path) => {
      if (!files.has(path)) throw new Error(`missing fixture: ${path}`);
      return files.get(path);
    },
    exists: (path) => files.has(path),
  });

  assert.deepEqual(launch, {
    command: "C:\\Node\\node.exe",
    args: [scriptPath],
    options: { shell: false },
  });
  assert.equal(launch.command.toLowerCase().endsWith(".cmd"), false);
});

test("Pi runtime accepts native Windows executables without shell parsing", () => {
  assert.deepEqual(
    resolvePiLaunch({ platform: "win32", executablePath: "C:\\Pi\\pi.exe" }),
    { command: "C:\\Pi\\pi.exe", args: [], options: { shell: false } },
  );
});

test("Pi runtime fails closed for missing or malformed Windows shims", () => {
  assert.throws(
    () => resolvePiLaunch({ platform: "win32", executablePath: "C:\\Pi\\missing.cmd" }),
    /unable to read Windows shim/,
  );
  assert.throws(
    () => resolvePiLaunch({
      platform: "win32",
      executablePath: "C:\\Pi\\malformed.cmd",
      readFile: () => "@echo off",
      exists: () => false,
    }),
    /no existing JavaScript entrypoint/,
  );
});

test("Pi runtime keeps non-Windows launches shell-free", () => {
  assert.deepEqual(
    resolvePiLaunch({ platform: "linux", executablePath: "pi" }),
    { command: "pi", args: [], options: { shell: false } },
  );
});

test("Pi child environments retain runtime basics but omit credentials and arbitrary variables", () => {
  assert.deepEqual(
    buildPiChildEnv({
      env: {
        PATH: "C:/bin",
        HOME: "C:/Users/test",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        ANTHROPIC_API_KEY: "secret",
        FORGEDOCK_APP_PEM: "secret",
        SOPS_AGE_KEY_FILE: "C:/secret.txt",
        UNTRUSTED_MARKER: "discard",
      },
      forgeHome: "C:/forge",
      phaseWorker: true,
    }),
    {
      PATH: "C:/bin",
      HOME: "C:/Users/test",
      FORGE_HOME: "C:/forge",
      FORGE_RUNTIME: "pi",
      FORGE_PI_WORKER: "1",
    },
  );
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

test("Pi subagent argv disables project extensions and preserves literal prompts", () => {
  const prompt = "review with spaces; do not split this";
  assert.deepEqual(
    buildPiSubagentArgs({ name: "security-review", prompt }),
    ["--no-session", "--approve", "--no-extensions", "--name", "security-review", "-p", prompt],
  );
  assert.deepEqual(
    buildPiSubagentArgs({ name: "read-only-review", prompt, readOnly: true }),
    [
      "--no-session",
      "--approve",
      "--no-extensions",
      "--name",
      "read-only-review",
      "--tools",
      "read,grep,find,ls",
      "-p",
      prompt,
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
