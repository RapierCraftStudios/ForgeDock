// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildPiModelArgs,
  buildPiPhaseArgs,
  buildPiPhasePrompt,
  modelPattern,
  parseWorktrees,
  worktreeForBranch,
} from "../../pi/runtime/engine.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI_EXTENSION = join(REPO_ROOT, "pi", "extensions", "forgedock.ts");
const CLASSIFIER = join(REPO_ROOT, "scripts", "classify-lane.sh");

function writeExecutable(path, content) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

test("Pi lane resolution uses the shared classifier and forwards its configured branch", () => {
  const source = readFileSync(PI_EXTENSION, "utf8");
  assert.match(source, /const classifier = join\(projectRoot, "scripts", "classify-lane\.sh"\)/);
  assert.match(source, /spawnSync\("bash", \[classifier, String\(issue\), "-R", repo\]/);
  assert.match(source, /if \(result\.error \|\| result\.status !== 0\)/);
  assert.match(source, /const lane = issueLane\(projectRoot, repo, issue\);[\s\S]*?runPiIssue\(\{[\s\S]*?lane,/);
  assert.doesNotMatch(source, /return[^;\n]*staging/);

  const fixture = mkdtempSync(join(tmpdir(), "forgedock-lane-"));
  const bin = join(fixture, "bin");
  const scripts = join(fixture, "scripts");
  const path = [bin, process.env.PATH || ""].join(process.platform === "win32" ? ";" : ":");
  try {
    writeFileSync(join(fixture, "forge.yaml"), "branches:\n  staging: integration\n", "utf8");
    mkdirSync(bin, { recursive: true });
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "classify-lane.sh"), readFileSync(CLASSIFIER), "utf8");
    writeExecutable(join(bin, "gh"), "#!/bin/sh\nprintf '%s\\n' '{\"milestone\":null,\"labels\":[]}'\n");
    writeExecutable(join(bin, "yq"), "#!/bin/sh\nprintf '%s\\n' integration\n");
    writeExecutable(join(bin, "git"), "#!/bin/sh\n[ \"$1\" = \"ls-remote\" ] && exit 0\nexit 1\n");

    const success = spawnSync("bash", [join(scripts, "classify-lane.sh"), "2950", "-R", "acme/repo"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, PATH: path },
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout.trim(), "integration");

    writeExecutable(join(bin, "gh"), "#!/bin/sh\nexit 7\n");
    const failure = spawnSync("bash", [join(scripts, "classify-lane.sh"), "2950", "-R", "acme/repo"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, PATH: path },
    });
    assert.notEqual(failure.status, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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
