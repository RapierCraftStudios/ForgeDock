/**
 * bin/tests/pre-tool-use.test.mjs
 *
 * Unit tests for the PreToolUse enforcement hook (issues #1250, #1323).
 * Tests PR target validation and fail-open behaviour.
 *
 * Run with: node --test bin/tests/pre-tool-use.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK_PATH = resolve(__dirname, "..", "hooks", "pre-tool-use.mjs");

// ---------------------------------------------------------------------------
// Re-implement the pure logic from the hook for unit testing without spawning.
// ---------------------------------------------------------------------------

const FORBIDDEN_PR_BASES = ["main", "master"];

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

function checkPrTarget(command) {
  if (!/gh\s+pr\s+create/.test(command)) return null;
  const base = extractFlag(command, "--base") || extractFlag(command, "-B");
  if (!base) return null;
  if (FORBIDDEN_PR_BASES.includes(base.toLowerCase())) {
    return `BLOCKED: PR targets "${base}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: run the hook script as a subprocess with a JSON payload on stdin.
// Returns { exitCode, stdout, stderr }.
// ---------------------------------------------------------------------------

function runHook(payload) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// ---------------------------------------------------------------------------
// PR target validation (pure logic)
// ---------------------------------------------------------------------------

describe("checkPrTarget — pure logic", () => {
  it("blocks PR targeting main", () => {
    const msg = checkPrTarget("gh pr create --base main --title foo");
    assert.ok(msg, "should return a block message");
    assert.match(msg, /BLOCKED/);
    assert.match(msg, /main/);
  });

  it("blocks PR targeting master", () => {
    const msg = checkPrTarget("gh pr create --base master --title foo");
    assert.ok(msg);
    assert.match(msg, /master/);
  });

  it("allows PR targeting staging", () => {
    assert.equal(checkPrTarget("gh pr create --base staging --title foo"), null);
  });

  it("allows PR targeting milestone/slug", () => {
    assert.equal(checkPrTarget("gh pr create --base milestone/my-feature --title foo"), null);
  });

  it("allows PR with no --base (uses default)", () => {
    assert.equal(checkPrTarget("gh pr create --title foo"), null);
  });

  it("ignores non-pr-create commands", () => {
    assert.equal(checkPrTarget("gh pr list --base main"), null);
    assert.equal(checkPrTarget("git push origin main"), null);
  });

  it("handles equals form --base=main", () => {
    const msg = checkPrTarget("gh pr create --base=main --title foo");
    assert.ok(msg);
    assert.match(msg, /main/);
  });

  it("handles case-insensitive MAIN", () => {
    const msg = checkPrTarget("gh pr create --base MAIN --title foo");
    assert.ok(msg);
  });
});

// ---------------------------------------------------------------------------
// Hook process integration tests (subprocess execution)
// ---------------------------------------------------------------------------

describe("pre-tool-use hook — subprocess", () => {
  it("exits 0 for non-Bash tool calls (fail-open)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: {},
    });
    assert.equal(exitCode, 0);
  });

  it("exits 0 for unrelated Bash commands (fail-open)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    assert.equal(exitCode, 0);
  });

  it("exits 2 and prints BLOCKED for gh pr create --base main", () => {
    const { exitCode, stdout } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base main --title foo" },
    });
    assert.equal(exitCode, 2);
    assert.match(stdout, /BLOCKED/);
  });

  it("exits 2 for --base=master", () => {
    const { exitCode, stdout } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base=master --title foo" },
    });
    assert.equal(exitCode, 2);
    assert.match(stdout, /BLOCKED/);
  });

  it("exits 0 for gh pr create --base staging", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base staging --title foo" },
    });
    assert.equal(exitCode, 0);
  });

  // -------------------------------------------------------------------------
  // Regression tests for issue #1519 — extractFlag() must not misread
  // flag-shaped text embedded inside a quoted --title/--body value as a
  // real --base/-B flag. These run against the actual hook file via
  // runHook() (subprocess), not the duplicated pure-logic copy above.
  // -------------------------------------------------------------------------

  it("exits 0 when -B-shaped text appears inside a quoted --title value (#1519)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --title "Fix -B main thread bug" --body "desc"',
      },
    });
    assert.equal(exitCode, 0);
  });

  it("exits 0 when --base-shaped text appears inside a quoted --body value (#1519)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command:
          'gh pr create --title "fix" --body "Discusses --base main config handling"',
      },
    });
    assert.equal(exitCode, 0);
  });

  it("still exits 2 for a real -B main flag alongside quoted args (#1519)", () => {
    const { exitCode, stdout } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create -B main --title "Fix -B thing"',
      },
    });
    assert.equal(exitCode, 2);
    assert.match(stdout, /BLOCKED/);
  });

  // -------------------------------------------------------------------------
  // Regression tests for issue #1550 — extractFlag() must also recognize the
  // attached short-flag form (-Bvalue, no separating space), which `gh`
  // itself accepts as equivalent to `-B value`. Without this, a forbidden
  // PR base written as -Bmain bypassed the hard block entirely.
  // -------------------------------------------------------------------------

  it("exits 2 and prints BLOCKED for attached short-flag form -Bmain (#1550)", () => {
    const { exitCode, stdout } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create -Bmain --title foo" },
    });
    assert.equal(exitCode, 2);
    assert.match(stdout, /BLOCKED/);
  });

  it("exits 2 for attached short-flag form -Bmaster (#1550)", () => {
    const { exitCode, stdout } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create -Bmaster --title foo" },
    });
    assert.equal(exitCode, 2);
    assert.match(stdout, /BLOCKED/);
  });

  it("exits 0 for attached short-flag form targeting an allowed base -Bstaging (#1550)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create -Bstaging --title foo" },
    });
    assert.equal(exitCode, 0);
  });

  it("exits 0 for non-PreToolUse events (wrong event type)", () => {
    const { exitCode } = runHook({
      hook_event_name: "SessionStart",
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base main" },
    });
    assert.equal(exitCode, 0);
  });

  it("exits 0 for empty stdin (fail-open)", () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: "",
      encoding: "utf-8",
      timeout: 3000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    assert.equal(result.status, 0);
  });

  it("exits 0 for malformed JSON (fail-open)", () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: "{ not json }",
      encoding: "utf-8",
      timeout: 3000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    assert.equal(result.status, 0);
  });
});

// ---------------------------------------------------------------------------
// settings-hook.mjs — SubagentStop and PreToolUse wiring tests
// ---------------------------------------------------------------------------

import {
  installSubagentStopHook,
  removeSubagentStopHook,
  installPreToolUseHook,
  removePreToolUseHook,
  installSessionStartHook,
  SUBAGENT_STOP_MARKER,
  PRE_TOOL_USE_MARKER,
} from "../settings-hook.mjs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";

describe("settings-hook — SubagentStop wiring", () => {
  let tmpDir, settingsPath;
  const before = () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "fd-sh-"));
    settingsPath = join(tmpDir, "settings.json");
  };
  const after = () => rmSync(tmpDir, { recursive: true, force: true });

  it("installs SubagentStop hook into fresh settings", () => {
    before();
    const res = installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    assert.equal(res.status, "installed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(Array.isArray(parsed.hooks.SubagentStop));
    assert.match(JSON.stringify(parsed.hooks.SubagentStop), /interactive-engine\.mjs/);
    after();
  });

  it("is idempotent for SubagentStop", () => {
    before();
    installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    const res = installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    assert.equal(res.status, "already");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const count = (JSON.stringify(parsed).match(/interactive-engine\.mjs/g) || []).length;
    assert.equal(count, 1);
    after();
  });

  it("removes SubagentStop hook", () => {
    before();
    installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    const res = removeSubagentStopHook(settingsPath);
    assert.equal(res.status, "removed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(parsed.hooks.SubagentStop.length, 0);
    after();
  });

  it("reports absent when SubagentStop hook not installed", () => {
    before();
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), "utf-8");
    assert.equal(removeSubagentStopHook(settingsPath).status, "absent");
    after();
  });
});

describe("settings-hook — PreToolUse wiring", () => {
  let tmpDir, settingsPath;
  const before = () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "fd-sh-ptu-"));
    settingsPath = join(tmpDir, "settings.json");
  };
  const after = () => rmSync(tmpDir, { recursive: true, force: true });

  it("installs PreToolUse hook into fresh settings", () => {
    before();
    const res = installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    assert.equal(res.status, "installed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(Array.isArray(parsed.hooks.PreToolUse));
    assert.match(JSON.stringify(parsed.hooks.PreToolUse), /pre-tool-use\.mjs/);
    after();
  });

  it("is idempotent for PreToolUse", () => {
    before();
    installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    const res = installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    assert.equal(res.status, "already");
    after();
  });

  it("removes PreToolUse hook", () => {
    before();
    installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    const res = removePreToolUseHook(settingsPath);
    assert.equal(res.status, "removed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(parsed.hooks.PreToolUse.length, 0);
    after();
  });

  it("all three hooks coexist in same settings.json", () => {
    before();
    installSessionStartHook(settingsPath, "/fake/session-start.mjs");
    installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(Array.isArray(parsed.hooks.SessionStart));
    assert.ok(Array.isArray(parsed.hooks.SubagentStop));
    assert.ok(Array.isArray(parsed.hooks.PreToolUse));
    assert.equal(parsed.hooks.SessionStart.length, 1);
    assert.equal(parsed.hooks.SubagentStop.length, 1);
    assert.equal(parsed.hooks.PreToolUse.length, 1);
    after();
  });
});
