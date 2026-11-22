// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
/**
 * Windows: stop background ForgeDock processes from flashing a console window per child process.
 *
 * The schedd daemon and batch lanes are spawned `detached` (DETACHED_PROCESS), so they own no console.
 * On Windows every console-subsystem child (gh, git, bash, node, …) they start without `windowsHide`
 * then gets a brand-new *visible* console window — an orchestrate run opens a window per `gh` call.
 *
 * Rather than thread `windowsHide: true` through ~600 call sites, this module defaults it on the
 * `child_process` module itself. It must be imported before anything else in the CLI entry so every
 * module's named imports (live-synced via `syncBuiltinESMExports`) see the wrapped functions.
 *
 * Scope: only on win32, and only when stdout is not a TTY (background/daemon/piped runs). Interactive
 * runs keep their defaults, so anything that opens a GUI (browser, editor) from a terminal behaves as before.
 * An explicit `windowsHide: false` is always respected.
 *
 * `detached` + piped stdio (#5799): on Windows `detached` means DETACHED_PROCESS, a child with *no console at
 * all*, and it overrides `windowsHide`. Every console program that child starts then gets its own visible
 * window: a lane's `claude --print` (runner.mjs) opened a window per bash tool call, and `bash -c` step
 * commands (effects.mjs) one per tool they ran. When the parent reads the child's output through pipes the two
 * lifetimes are tied anyway, so on win32 (interactive runs too) such spawns drop `detached`: the child gets a
 * windowless console that its own children share. Fire-and-forget spawns (stdio ignore / file descriptors)
 * keep `detached` so lanes and the daemon still outlive their parent.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PROMISIFY = Symbol.for("nodejs.util.promisify.custom");

// What the wrapper changes in this process: `hide` (default windowsHide) only for background runs.
const policy = { hide: true };

/** True when the parent reads the child's stdio through pipes (Node's default stdio is "pipe"). */
export function pipedStdio(stdio) {
  if (stdio === undefined || stdio === "pipe" || stdio === "overlapped") return true;
  return Array.isArray(stdio) && stdio.slice(0, 3).some((s) => s === "pipe" || s === "overlapped" || s === undefined || s === null);
}

/** Return `opts` adjusted for Windows: default `windowsHide` (background runs), drop `detached` when piped. */
export function withHide(opts) {
  if (opts == null) return policy.hide ? { windowsHide: true } : opts;
  if (typeof opts !== "object") return opts;
  let out = opts;
  if (policy.hide && out.windowsHide === undefined) out = { ...out, windowsHide: true };
  if (out.detached === true && pipedStdio(out.stdio)) out = { ...out, detached: false };
  return out;
}

/** Re-shape `(file, args?, options?, ...rest)` — the spawn/execFile/fork signature. */
export function hideFileArgs(argv) {
  const a = [...argv];
  if (Array.isArray(a[1])) {
    if (typeof a[2] === "function") a.splice(2, 0, withHide(undefined));
    else a[2] = withHide(a[2]);
  } else if (a[1] != null && typeof a[1] === "object") {
    a[1] = withHide(a[1]);
  } else if (typeof a[1] === "function") {
    a.splice(1, 0, [], withHide(undefined));
  } else {
    // (file) or (file, undefined, …): keep positions, fill options
    a[1] = a[1] ?? [];
    if (typeof a[2] === "function") a.splice(2, 0, withHide(undefined));
    else a[2] = withHide(a[2]);
  }
  return a;
}

/** Re-shape `(command, options?, ...rest)` — the exec/execSync signature. */
export function hideCmdArgs(argv) {
  const a = [...argv];
  if (typeof a[1] === "function") a.splice(1, 0, withHide(undefined));
  else a[1] = withHide(a[1]);
  return a;
}

/** Whether this process defaults `windowsHide` (win32 background runs). */
export function shouldInstall({ platform = process.platform, isTTY = process.stdout?.isTTY, env = process.env } = {}) {
  if (platform !== "win32") return false;
  if (env.FORGEDOCK_NO_WINDOWS_HIDE === "1") return false;
  return !isTTY;
}

/** Whether the wrapper is installed at all (win32, not opted out); the detached rule applies to every run. */
export function shouldWrap({ platform = process.platform, env = process.env } = {}) {
  return platform === "win32" && env.FORGEDOCK_NO_WINDOWS_HIDE !== "1";
}

export function install(cp = require("node:child_process"), { hide = true } = {}) {
  if (cp.__forgedockWindowsHide) return false;
  policy.hide = hide;
  const FILE = ["spawn", "spawnSync", "execFile", "execFileSync", "fork"];
  const CMD = ["exec", "execSync"];
  for (const name of FILE) {
    const orig = cp[name];
    if (typeof orig !== "function") continue;
    const wrapped = function (...argv) { return orig.apply(this, hideFileArgs(argv)); };
    const custom = orig[PROMISIFY];
    if (typeof custom === "function") wrapped[PROMISIFY] = (...argv) => custom(...hideFileArgs(argv));
    cp[name] = wrapped;
  }
  for (const name of CMD) {
    const orig = cp[name];
    if (typeof orig !== "function") continue;
    const wrapped = function (...argv) { return orig.apply(this, hideCmdArgs(argv)); };
    const custom = orig[PROMISIFY];
    if (typeof custom === "function") wrapped[PROMISIFY] = (...argv) => custom(...hideCmdArgs(argv));
    cp[name] = wrapped;
  }
  Object.defineProperty(cp, "__forgedockWindowsHide", { value: true });
  require("node:module").syncBuiltinESMExports();
  return true;
}

if (shouldWrap()) install(undefined, { hide: shouldInstall() });
