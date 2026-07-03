/**
 * bin/tests/settings-hook.test.mjs — Unit tests for bin/settings-hook.mjs.
 * Run with: node --test bin/tests/settings-hook.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { installSessionStartHook, removeSessionStartHook } from "../settings-hook.mjs";

const HOOK_SCRIPT = "C:/fake/forgedock/bin/hooks/session-start.mjs";

let dir, settingsPath;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "fd-hook-"));
  settingsPath = join(dir, "settings.json");
});

describe("installSessionStartHook", () => {
  it("creates settings.json with the hook when absent", () => {
    const res = installSessionStartHook(settingsPath, HOOK_SCRIPT);
    assert.equal(res.status, "installed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const cmds = JSON.stringify(parsed.hooks.SessionStart);
    assert.match(cmds, /session-start\.mjs/);
  });

  it("is idempotent — second run reports already, no duplicate entry", () => {
    installSessionStartHook(settingsPath, HOOK_SCRIPT);
    const res = installSessionStartHook(settingsPath, HOOK_SCRIPT);
    assert.equal(res.status, "already");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const matches = JSON.stringify(parsed).match(/session-start\.mjs/g);
    assert.equal(matches.length, 1);
  });

  it("preserves unrelated hooks and settings keys", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "opus",
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }], Stop: [] },
      }),
      "utf-8",
    );
    installSessionStartHook(settingsPath, HOOK_SCRIPT);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(parsed.model, "opus");
    assert.ok(Array.isArray(parsed.hooks.Stop));
    assert.equal(parsed.hooks.SessionStart.length, 2); // existing + ours
    assert.match(JSON.stringify(parsed.hooks.SessionStart[0]), /echo hi/);
  });

  it("skips (never clobbers) malformed JSON", () => {
    writeFileSync(settingsPath, "{ not json !!", "utf-8");
    const res = installSessionStartHook(settingsPath, HOOK_SCRIPT);
    assert.equal(res.status, "skipped-malformed");
    assert.equal(readFileSync(settingsPath, "utf-8"), "{ not json !!");
  });
});

describe("removeSessionStartHook", () => {
  it("removes only our entry", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
      "utf-8",
    );
    installSessionStartHook(settingsPath, HOOK_SCRIPT);
    const res = removeSessionStartHook(settingsPath);
    assert.equal(res.status, "removed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(parsed.hooks.SessionStart.length, 1);
    assert.match(JSON.stringify(parsed.hooks.SessionStart[0]), /echo hi/);
  });

  it("reports absent when file or entry missing", () => {
    assert.equal(removeSessionStartHook(settingsPath).status, "absent");
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), "utf-8");
    assert.equal(removeSessionStartHook(settingsPath).status, "absent");
  });
});
