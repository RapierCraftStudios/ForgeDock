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
 * runs are untouched, so anything that opens a GUI (browser, editor) from a terminal behaves as before.
 * An explicit `windowsHide: false` is always respected.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PROMISIFY = Symbol.for("nodejs.util.promisify.custom");

/** Return `opts` with `windowsHide: true` unless the caller set it. */
export function withHide(opts) {
  if (opts == null) return { windowsHide: true };
  if (typeof opts !== "object") return opts;
  return opts.windowsHide === undefined ? { ...opts, windowsHide: true } : opts;
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

export function shouldInstall({ platform = process.platform, isTTY = process.stdout?.isTTY, env = process.env } = {}) {
  if (platform !== "win32") return false;
  if (env.FORGEDOCK_NO_WINDOWS_HIDE === "1") return false;
  return !isTTY;
}

export function install(cp = require("node:child_process")) {
  if (cp.__forgedockWindowsHide) return false;
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

if (shouldInstall()) install();
