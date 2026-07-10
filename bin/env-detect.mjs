#!/usr/bin/env node
/**
 * env-detect.mjs — Pure deterministic environment detection for ForgeDock.
 *
 * Exports a single function: detectEnvironment(opts)
 *
 * Returns a flat, structured description of the host environment the
 * installer is running in — platform, WSL status, shell, and a best-guess at
 * symlink support. Mirrors the conventions established by init-detect.mjs:
 *
 * Contract guarantees:
 *   - Pure: no prompts, no writes; reads only injectable inputs (or their
 *     process defaults) — process.platform, os.release(), process.env, and
 *     (best-effort) /proc/version.
 *   - Safe: every risky read is wrapped in try/catch and degrades to a
 *     best-guess default. detectEnvironment() never throws.
 *   - Testable: inject `platform`, `env`, `release`, and `readFileSync` to
 *     simulate any OS/shell/WSL combination without mocking global process
 *     state.
 */

import { readFileSync as fsReadFileSync } from "fs";
import os from "os";

// ---------------------------------------------------------------------------
// Detection helpers — each is pure and never throws
// ---------------------------------------------------------------------------

/**
 * Detect whether the process is running inside WSL, and which distro.
 *
 * Strategy (first success wins):
 *   1. `WSL_DISTRO_NAME` env var — set by WSL itself, authoritative when present.
 *   2. On `linux`, best-effort read `/proc/version` and test for "microsoft"
 *      (case-insensitive) — covers WSL setups that don't export the env var
 *      (e.g. processes launched without inheriting the interactive shell's
 *      environment).
 *
 * Never throws: a missing/unreadable /proc/version degrades to "not WSL".
 *
 * @param {string} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {(path: string, encoding: string) => string} readFile
 * @returns {{ isWSL: boolean, wslDistro: string | null }}
 */
function detectWSL(platform, env, readFile) {
  if (env.WSL_DISTRO_NAME) {
    return { isWSL: true, wslDistro: env.WSL_DISTRO_NAME };
  }

  if (platform === "linux") {
    try {
      const version = readFile("/proc/version", "utf-8");
      if (/microsoft/i.test(version)) {
        return { isWSL: true, wslDistro: env.WSL_DISTRO_NAME || null };
      }
    } catch {
      // /proc/version missing or unreadable — not WSL, or undetectable; degrade quietly.
    }
  }

  return { isWSL: false, wslDistro: null };
}

/**
 * Derive a human-readable platform label.
 *
 * Windows build numbers >= 22000 report as "Windows 11" (Node's os.release()
 * on win32 returns the kernel version, e.g. "10.0.22631" — Windows 11 never
 * bumped the major.minor past 10.0, only the build number). Anything that
 * doesn't match a recognized pattern falls back to a generic label rather
 * than throwing or guessing wildly.
 *
 * @param {string} platform
 * @param {string} release
 * @returns {string}
 */
function detectPlatformLabel(platform, release) {
  switch (platform) {
    case "win32": {
      const buildMatch = String(release).match(/^10\.0\.(\d+)/);
      if (buildMatch && Number(buildMatch[1]) >= 22000) return "Windows 11";
      if (String(release).startsWith("10.")) return "Windows 10";
      return "Windows";
    }
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

/**
 * Best-effort shell name detection.
 *
 * Strategy (first success wins):
 *   1. `$SHELL` — set on POSIX (bash/zsh/fish/...) and also by Git-Bash/MSYS
 *      environments on Windows. Basename it (strip any path).
 *   2. On `win32` without `$SHELL`: `$PSModulePath` presence indicates
 *      PowerShell; otherwise `$ComSpec` presence indicates cmd.exe.
 *   3. "unknown" — no shell signal found.
 *
 * Never throws.
 *
 * @param {string} platform
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function detectShell(platform, env) {
  if (env.SHELL) {
    const parts = String(env.SHELL).split(/[\\/]/);
    const name = parts[parts.length - 1];
    return name || env.SHELL;
  }

  if (platform === "win32") {
    if (env.PSModulePath) return "PowerShell";
    if (env.ComSpec) return "cmd";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   platform: string,
 *   platformLabel: string,
 *   isWSL: boolean,
 *   wslDistro: string | null,
 *   shell: string,
 *   symlinkSupport: boolean,
 * }} EnvironmentInfo
 */

/**
 * Detect the current host environment: platform, WSL status, shell, and a
 * best-guess at symlink support. Never throws — every risky read degrades to
 * a best-guess default.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform] - Defaults to `process.platform`. Inject to test other OSes.
 * @param {NodeJS.ProcessEnv} [opts.env] - Defaults to `process.env`. Inject to test WSL/shell scenarios.
 * @param {string} [opts.release] - Defaults to `os.release()`. Inject to force a specific Windows
 *   build number (e.g. "10.0.22631") so Windows 10 vs 11 labeling is deterministically testable.
 * @param {(path: string, encoding: string) => string} [opts.readFileSync] - Defaults to `fs.readFileSync`.
 *   Inject to simulate /proc/version contents (or failures) without touching the real filesystem.
 * @returns {EnvironmentInfo}
 */
export function detectEnvironment(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  let release = opts.release;
  if (release === undefined) {
    try {
      release = os.release();
    } catch {
      release = "";
    }
  }
  const readFile = opts.readFileSync ?? fsReadFileSync;

  let isWSL = false;
  let wslDistro = null;
  try {
    ({ isWSL, wslDistro } = detectWSL(platform, env, readFile));
  } catch {
    // Best-effort — degrade to "not WSL" on any unexpected failure.
  }

  let platformLabel = platform;
  try {
    platformLabel = detectPlatformLabel(platform, release);
  } catch {
    platformLabel = platform;
  }

  let shell = "unknown";
  try {
    shell = detectShell(platform, env);
  } catch {
    shell = "unknown";
  }

  // Best-guess only — POSIX filesystems support symlinks unconditionally;
  // Windows requires Developer Mode or elevation, which isn't reliably
  // detectable without a live filesystem probe (out of scope: this module is
  // pure/read-only). journey.mjs's forge() already handles the real-world
  // EPERM/EACCES case reactively via a copy fallback.
  const symlinkSupport = platform !== "win32";

  return { platform, platformLabel, isWSL, wslDistro, shell, symlinkSupport };
}
