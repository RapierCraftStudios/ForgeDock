// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host overload signal (#5174). Remote lanes already run every heavy step inside their sandbox (sandbox-remote.mjs runs
 * `forgedock run-issue` there). What loads a small dispatcher are the lanes that run on it: local placements and fallbacks.
 * - `hostOverload` is the snapshot: overloaded when the 1-min load average divided by cores is above
 *   `engine.overload_load_per_core` (default 2; 0 disables; env FORGEDOCK_OVERLOAD_LOAD_PER_CORE overrides). An unreadable probe never counts as overloaded.
 * - orchestrate `grant()` holds new local admissions while it is overloaded (remote placements are never held).
 * - `forgedock status` and `forgedock schedd status` print `formatOverload`.
 * - `lowerPriority` runs a local heavy step at nice 10 (plus `ionice -c3` on Linux when available), so test runners and
 *   installs do not starve the schedd event loop. Best effort, never throws.
 */
import { spawn } from "node:child_process";
import { cpus, loadavg, setPriority as osSetPriority } from "node:os";
import { which } from "./toolchain.mjs";

export const OVERLOAD_DEFAULTS = Object.freeze({ load_per_core: 2 });
export const HEAVY_NICE = 10;

/** Threshold (load per core) from cfg.overload_load_per_core: > 0 sets it, 0 disables (null), unset or invalid is the default. */
export function overloadThreshold(cfg = {}) {
  const v = cfg?.overload_load_per_core;
  if (v === undefined || v === null || String(v).trim() === "") return OVERLOAD_DEFAULTS.load_per_core;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return OVERLOAD_DEFAULTS.load_per_core;
  return n === 0 ? null : n;
}

/** Snapshot {overloaded, load1, cores, perCore, threshold}; threshold null (disabled) or an unreadable probe is never overloaded. */
export function hostOverload({ threshold = OVERLOAD_DEFAULTS.load_per_core, host = { loadAvg1: () => loadavg()[0], cores: () => cpus().length || 1 } } = {}) {
  const probe = (f) => { try { const v = f?.(); return Number.isFinite(v) ? v : null; } catch { return null; } };
  const load1 = probe(host?.loadAvg1), cores = probe(host?.cores);
  const perCore = load1 !== null && cores ? load1 / cores : null;
  const t = Number.isFinite(threshold) && threshold > 0 ? threshold : null;
  return { overloaded: perCore !== null && t !== null && perCore > t, load1, cores, perCore, threshold: t };
}

/**
 * A `() => snapshot` probe with the threshold read from an admission cfg (engine-cli `readAdmission`). The env
 * `FORGEDOCK_OVERLOAD_LOAD_PER_CORE` (same values; 0 disables) overrides forge.yaml host-wide; the test helper sets it to 0.
 */
export function liveOverload(cfg = {}, { host, env = process.env } = {}) {
  const e = env?.FORGEDOCK_OVERLOAD_LOAD_PER_CORE;
  const threshold = overloadThreshold(e !== undefined && String(e).trim() !== "" ? { overload_load_per_core: e } : cfg);
  return () => hostOverload({ threshold, ...(host ? { host } : {}) });
}

/** `host_overloaded (load X.X/core > T): new local admissions held`, or null when not overloaded. */
export function formatOverload(snap) {
  if (!snap?.overloaded) return null;
  return `host_overloaded (load ${Number(snap.perCore).toFixed(1)}/core > ${snap.threshold}): new local admissions held`;
}

/** One-line host summary: the overload line, else `load X.X/core (threshold T)`, else null when load is unknown. */
export function formatHostLoad(snap) {
  const o = formatOverload(snap);
  if (o) return o;
  if (!Number.isFinite(snap?.perCore)) return null;
  return `load ${snap.perCore.toFixed(1)}/core${snap.threshold ? ` (threshold ${snap.threshold})` : " (overload hold off)"}`;
}

/** Default `spawnIonice`: `ionice -c3 -p <pid>` detached and unref'd when ionice is on PATH; returns whether it was started. */
export function spawnIoniceIdle(pid, { find = (n) => which(n, process.env.PATH ?? ""), run = spawn } = {}) {
  const ionice = find("ionice");
  if (!ionice) return false;
  const c = run(ionice, ["-c3", "-p", String(pid)], { stdio: "ignore", detached: true });
  c?.on?.("error", () => {}); c?.unref?.();
  return true;
}

/** Lower a heavy step's CPU (nice 10) and, on Linux, IO (ionice idle class) priority; returns whether nice was applied. Never throws. */
export function lowerPriority(pid, { setPriority = osSetPriority, spawnIonice = spawnIoniceIdle, platform = process.platform, level = HEAVY_NICE } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let ok = false;
  try { setPriority(pid, level); ok = true; } catch { ok = false; }
  if (platform === "linux") { try { spawnIonice(pid); } catch { /* best effort */ } }
  return ok;
}
