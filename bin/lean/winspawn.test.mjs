// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsPath, resolveSpawn } from "./winspawn.mjs";

test("#5799 isAbsPath: POSIX, Windows drive and UNC paths are absolute; relative ones are not", () => {
  for (const p of ["/repo/.git/info/exclude", "C:/Users/u/repo/.git/info/exclude", "C:\\Users\\u\\repo\\.git", "d:/x", "\\\\srv\\share\\repo"]) assert.equal(isAbsPath(p), true, p);
  for (const p of [".git/info/exclude", "info/exclude", "C:", "c:repo", "", null, undefined]) assert.equal(isAbsPath(p), false, String(p));
});

/** In-memory fs keyed by win32 path. */
const memFs = (files) => ({
  statSync: (f) => { if (!(f in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { isFile: () => true }; },
  existsSync: (f) => f in files,
  readFileSync: (f) => { if (!(f in files)) throw new Error("ENOENT"); return files[f]; },
});
const NPM = "C:\\npm";
const PNPM_CMD = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n`;
const env = { PATH: `C:\\Windows;${NPM}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

test("#5799 resolveSpawn: an npm node-script .cmd shim runs as node <script> with the argv untouched", () => {
  const fs = memFs({ [`${NPM}\\pnpm.cmd`]: PNPM_CMD, [`${NPM}\\node_modules\\pnpm\\bin\\pnpm.cjs`]: "" });
  const r = resolveSpawn("pnpm", ["install", "--frozen-lockfile", "a&b"], { platform: "win32", env, fs, nodePath: "C:\\node\\node.exe" });
  assert.deepEqual(r, { bin: "C:\\node\\node.exe", args: [`${NPM}\\node_modules\\pnpm\\bin\\pnpm.cjs`, "install", "--frozen-lockfile", "a&b"] });
});

test("#5799 resolveSpawn: prefers the node.exe beside the shim, and a native .exe on PATH wins as found", () => {
  const fs = memFs({ [`${NPM}\\pnpm.cmd`]: PNPM_CMD, [`${NPM}\\node_modules\\pnpm\\bin\\pnpm.cjs`]: "", [`${NPM}\\node.exe`]: "" });
  assert.equal(resolveSpawn("pnpm", [], { platform: "win32", env, fs }).bin, `${NPM}\\node.exe`);
  const fs2 = memFs({ "C:\\Windows\\pnpm.exe": "", [`${NPM}\\pnpm.cmd`]: PNPM_CMD });
  assert.deepEqual(resolveSpawn("pnpm", ["-v"], { platform: "win32", env, fs: fs2 }), { bin: "C:\\Windows\\pnpm.exe", args: ["-v"] });
});

test("#5799 resolveSpawn: a .cmd shim delegating to a native .exe runs that .exe", () => {
  const fs = memFs({ [`${NPM}\\tool.cmd`]: `@ECHO off\r\n"%~dp0\\node_modules\\tool\\bin\\tool.exe"   %*\r\n`, [`${NPM}\\node_modules\\tool\\bin\\tool.exe`]: "" });
  assert.deepEqual(resolveSpawn("tool", ["x"], { platform: "win32", env, fs }), { bin: `${NPM}\\node_modules\\tool\\bin\\tool.exe`, args: ["x"] });
});

test("#5799 resolveSpawn: unchanged off Windows, for paths, unknown batch scripts and missing tools", () => {
  const fs = memFs({ [`${NPM}\\odd.cmd`]: "@echo off\r\nset X=%1\r\ncall something %X%\r\n" });
  for (const [bin, opt] of [["pnpm", { platform: "linux", env, fs }], ["C:\\x\\pnpm.cmd", { platform: "win32", env, fs }], ["odd", { platform: "win32", env, fs }], ["nope", { platform: "win32", env, fs }]]) {
    assert.deepEqual(resolveSpawn(bin, ["a"], opt), { bin, args: ["a"] }, bin);
  }
});
