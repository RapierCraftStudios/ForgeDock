// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stale FORGE_HOME detection (#5796).
 *
 * `FORGE_HOME` is a legacy variable: current installs never export it, but `scripts/lib/forge-resolve.sh`
 * still ranks it *above* the install symlink and `~/.forge`. A value left over from an old dev checkout
 * therefore silently wins, so specs and scripts run from a tree that can be dozens of versions behind the CLI.
 * Doctor used to report any set value as ✔.
 *
 * `assessForgeHome` classifies the value against the running install. On Windows the value usually lives in
 * the user environment (HKCU\Environment), which the shell-profile cleanup in `uninstall` never touched, so
 * this module also reads and clears that.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const norm = (p, real) => {
  try { p = real(resolve(p)); } catch { p = resolve(p); }
  return process.platform === "win32" ? p.toLowerCase() : p;
};

/**
 * @param {object} o
 * @param {string|undefined} o.value       FORGE_HOME as seen by this process
 * @param {string} o.sourceDir             the running install's root
 * @param {string} o.sourceVersion         the running install's version
 * @param {string} [o.persistedHome]       ~/.forge
 * @returns {{ state: "unset"|"current"|"missing"|"not-forgedock"|"stale"|"same-version", version?: string }}
 */
export function assessForgeHome({ value, sourceDir, sourceVersion, persistedHome,
  exists = existsSync, read = (p) => readFileSync(p, "utf8"), real = realpathSync }) {
  if (!value) return { state: "unset" };
  const v = norm(value, real);
  if (v === norm(sourceDir, real) || (persistedHome && v === norm(persistedHome, real))) return { state: "current" };
  if (!exists(value)) return { state: "missing" };
  let pkg;
  try { pkg = JSON.parse(read(join(value, "package.json"))); } catch { pkg = null; }
  if (!pkg || pkg.name !== "forgedock") {
    // ~/.forge-style persisted homes carry a bare `version` file instead of package.json
    try { const ver = read(join(value, "version")).trim(); if (ver) return ver === sourceVersion ? { state: "same-version", version: ver } : { state: "stale", version: ver }; } catch { /* not a toolset */ }
    return { state: "not-forgedock" };
  }
  const version = String(pkg.version ?? "");
  return version && version === sourceVersion ? { state: "same-version", version } : { state: "stale", version: version || "unknown" };
}

/**
 * Which tree a registered hook script lives in: 'current' when it sits under the running install
 * or the persisted ~/.forge, 'foreign' for any other (e.g. an old checkout that still exists on disk).
 * Segment-wise containment, so `src-old` is not inside `src`.
 */
export function hookScriptTree({ scriptPath, sourceDir, persistedHome, real = realpathSync }) {
  const s = norm(scriptPath, real);
  const inside = (root) => {
    if (!root) return false;
    const rel = relative(norm(root, real), s);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  return inside(sourceDir) || inside(persistedHome) ? "current" : "foreign";
}

/** True when the assessment means FORGE_HOME points somewhere other than the running install's toolset. */
export const isProblem = (a) => ["missing", "not-forgedock", "stale"].includes(a.state);

/** Human-readable reason for a problem state. */
export function describe(a, value, sourceVersion) {
  if (a.state === "missing") return `points at "${value}", which does not exist`;
  if (a.state === "not-forgedock") return `points at "${value}", which is not a ForgeDock toolset`;
  if (a.state === "stale") return `points at "${value}" (v${a.version}) but the running install is v${sourceVersion} — scripts resolve FORGE_HOME before ~/.forge, so the old tree wins`;
  return "";
}

/** Windows: FORGE_HOME stored in the user environment (HKCU\Environment), or null. */
export function readUserForgeHomeWin({ run = spawnSync } = {}) {
  const r = run("reg", ["query", "HKCU\\Environment", "/v", "FORGE_HOME"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const m = /FORGE_HOME\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(r.stdout ?? "");
  return m ? m[1].trim() : null;
}

/** Windows: delete FORGE_HOME from the user environment. Returns true on success. */
export function clearUserForgeHomeWin({ run = spawnSync } = {}) {
  const r = run("reg", ["delete", "HKCU\\Environment", "/v", "FORGE_HOME", "/f"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return false;
  // Broadcast WM_SETTINGCHANGE so new shells pick it up without a logoff; best-effort.
  run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::SetEnvironmentVariable('FORGE_HOME', $null, 'User')"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  return true;
}
