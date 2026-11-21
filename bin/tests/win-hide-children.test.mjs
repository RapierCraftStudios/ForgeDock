// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { withHide, hideFileArgs, hideCmdArgs, shouldInstall, install } from "../win-hide-children.mjs";

const H = { windowsHide: true };
const cb = () => {};

test("withHide defaults windowsHide and respects an explicit value", () => {
  assert.deepEqual(withHide(undefined), H);
  assert.deepEqual(withHide(null), H);
  assert.deepEqual(withHide({ cwd: "x" }), { cwd: "x", windowsHide: true });
  const explicit = { windowsHide: false };
  assert.equal(withHide(explicit), explicit);
});

test("hideFileArgs handles every spawn/execFile/fork shape", () => {
  assert.deepEqual(hideFileArgs(["gh"]), ["gh", [], H]);
  assert.deepEqual(hideFileArgs(["gh", ["api"]]), ["gh", ["api"], H]);
  assert.deepEqual(hideFileArgs(["gh", ["api"], { cwd: "c" }]), ["gh", ["api"], { cwd: "c", windowsHide: true }]);
  assert.deepEqual(hideFileArgs(["gh", { cwd: "c" }]), ["gh", { cwd: "c", windowsHide: true }]);
  assert.deepEqual(hideFileArgs(["gh", ["api"], cb]), ["gh", ["api"], H, cb]);
  assert.deepEqual(hideFileArgs(["gh", cb]), ["gh", [], H, cb]);
  assert.deepEqual(hideFileArgs(["gh", ["api"], { encoding: "utf8" }, cb]), ["gh", ["api"], { encoding: "utf8", windowsHide: true }, cb]);
  assert.deepEqual(hideFileArgs(["gh", ["api"], { windowsHide: false }]), ["gh", ["api"], { windowsHide: false }]);
});

test("hideCmdArgs handles every exec/execSync shape", () => {
  assert.deepEqual(hideCmdArgs(["ls"]), ["ls", H]);
  assert.deepEqual(hideCmdArgs(["ls", { cwd: "c" }]), ["ls", { cwd: "c", windowsHide: true }]);
  assert.deepEqual(hideCmdArgs(["ls", cb]), ["ls", H, cb]);
  assert.deepEqual(hideCmdArgs(["ls", { cwd: "c" }, cb]), ["ls", { cwd: "c", windowsHide: true }, cb]);
});

test("shouldInstall: only on win32 without a TTY, with an opt-out", () => {
  assert.equal(shouldInstall({ platform: "linux", isTTY: false, env: {} }), false);
  assert.equal(shouldInstall({ platform: "darwin", isTTY: undefined, env: {} }), false);
  assert.equal(shouldInstall({ platform: "win32", isTTY: true, env: {} }), false);
  assert.equal(shouldInstall({ platform: "win32", isTTY: false, env: {} }), true);
  assert.equal(shouldInstall({ platform: "win32", isTTY: undefined, env: {} }), true);
  assert.equal(shouldInstall({ platform: "win32", isTTY: false, env: { FORGEDOCK_NO_WINDOWS_HIDE: "1" } }), false);
});

test("install wraps a child_process-shaped object, keeps promisify working, and is idempotent", async () => {
  const seen = [];
  const rec = (name) => (...a) => { seen.push([name, ...a]); return name; };
  const fake = { spawn: rec("spawn"), spawnSync: rec("spawnSync"), execFile: rec("execFile"), execFileSync: rec("execFileSync"), fork: rec("fork"), exec: rec("exec"), execSync: rec("execSync") };
  fake.exec[Symbol.for("nodejs.util.promisify.custom")] = async (...a) => { seen.push(["exec.p", ...a]); return { stdout: "ok" }; };

  assert.equal(install(fake), true);
  assert.equal(install(fake), false, "second install is a no-op");

  fake.spawn("gh", ["api"]);
  fake.execFileSync("gh", ["api"], { encoding: "utf8" });
  fake.execSync("dir");
  fake.spawnSync("gh", ["x"], { windowsHide: false });
  assert.deepEqual(seen, [
    ["spawn", "gh", ["api"], H],
    ["execFileSync", "gh", ["api"], { encoding: "utf8", windowsHide: true }],
    ["execSync", "dir", H],
    ["spawnSync", "gh", ["x"], { windowsHide: false }],
  ]);

  seen.length = 0;
  assert.deepEqual(await promisify(fake.exec)("dir", { cwd: "c" }), { stdout: "ok" });
  assert.deepEqual(seen, [["exec.p", "dir", { cwd: "c", windowsHide: true }]]);
});
