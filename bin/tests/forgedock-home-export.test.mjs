// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withForgedockHome, toPosixRoot, runCliBackend, getToolHandlers } from "../runner.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("FORGEDOCK_HOME export to phase children (forge#3778)", () => {
  it("defaults to the package root, which carries the shared helpers", () => {
    const env = withForgedockHome({});
    assert.equal(env.FORGEDOCK_HOME, PKG_ROOT);
    assert.ok(existsSync(join(env.FORGEDOCK_HOME, "scripts", "lib", "forge-resolve.sh")));
  });
  it("never overrides a value the operator set", () => {
    assert.equal(withForgedockHome({ FORGEDOCK_HOME: "/opt/forge" }).FORGEDOCK_HOME, "/opt/forge");
  });
  it("normalizes a Windows drive-letter root to /c/x (INFRA-6) and leaves POSIX roots alone", () => {
    assert.equal(toPosixRoot("C:\\Users\\me\\forge", "win32"), "/c/Users/me/forge");
    assert.equal(toPosixRoot("D:/a/forge", "win32"), "/d/a/forge");
    assert.equal(toPosixRoot("/opt/forge", "win32"), "/opt/forge");
    assert.equal(toPosixRoot("C:\\Users\\me", "linux"), "C:\\Users\\me");
  });
  it("runCliBackend passes FORGEDOCK_HOME to the child env", () => {
    const saved = process.env.FORGEDOCK_HOME; delete process.env.FORGEDOCK_HOME;
    let seen;
    try {
      runCliBackend({ spec: "x", userMessage: "y", cwd: process.cwd(), bin: "claude",
        spawnFn: (_b, _a, opts) => { seen = opts.env; return { status: 0, stdout: "", stderr: "" }; } });
    } catch { /* output parsing may reject the empty stub result; the env was already captured */ }
    finally { if (saved !== undefined) process.env.FORGEDOCK_HOME = saved; }
    assert.equal(seen?.FORGEDOCK_HOME, PKG_ROOT);
  });
  it("run_bash passes FORGEDOCK_HOME to the child env", () => {
    const saved = process.env.FORGEDOCK_HOME; delete process.env.FORGEDOCK_HOME;
    try {
      const out = getToolHandlers(PKG_ROOT).run_bash({ command: "node -e \"process.stdout.write(process.env.FORGEDOCK_HOME || 'ABSENT')\"" });
      assert.match(out, new RegExp(PKG_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally { if (saved !== undefined) process.env.FORGEDOCK_HOME = saved; }
  });
});
