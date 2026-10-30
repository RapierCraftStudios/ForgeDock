// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host-resource admission for the core work-on (#4105): refuse to start a run when the host is out of headroom, so a
 * batch of lanes does not push the machine into OOM or a full /tmp. Every probe is injected through `host`.
 */
// #4169: load average lags by minutes and is phase-blind, so it is off unless configured; heavy steps are gated by
// the host heavy-step semaphore (heavy.mjs) instead. An explicit `max_load_per_core` is still honoured.
export const ADMISSION_DEFAULTS = Object.freeze({ enabled: true, min_free_mem_mb: 2048, min_free_tmp_mb: 1024, max_load_per_core: null, lane_cpu_reservation: 1, lane_mem_mb: 2048 });
export const ADMISSION_RETRY_SECONDS = 60;

/** Workers one verification step may use (#4182): max(1, floor(cores / lanes)); bad inputs count as 1. Heavy shims pass live heavy holders (#4169). */
export function hostParallelism({ cores, lanes } = {}) {
  const c = Number.isFinite(cores) && cores > 0 ? cores : 1, l = Number.isFinite(lanes) && lanes > 0 ? lanes : 1;
  return Math.max(1, Math.floor(c / l));
}

/**
 * Local lane cap (#4777): how many lanes this host can run at once, from cores and free memory:
 * max(1, min(floor(cores / lane_cpu_reservation), floor((memAvailableMb - min_free_mem_mb) / lane_mem_mb))). Evaluated per
 * admission attempt, so it follows the host as lanes come and go; an unknown probe leaves that bound off, and with both
 * unknown (or admission disabled) it is null (no derived cap).
 */
export function localLaneCap({ cfg = {}, cores, memAvailableMb } = {}) {
  const c = { ...ADMISSION_DEFAULTS, ...Object.fromEntries(Object.entries(cfg ?? {}).filter(([, v]) => v !== undefined && v !== null)) };
  if (c.enabled === false) return null;
  const pos = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const bounds = [];
  if (Number.isFinite(cores) && cores > 0) bounds.push(Math.floor(cores / pos(c.lane_cpu_reservation, 1)));
  if (Number.isFinite(memAvailableMb)) bounds.push(Math.floor((memAvailableMb - pos(c.min_free_mem_mb, 0)) / pos(c.lane_mem_mb, 2048)));
  return bounds.length ? Math.max(1, Math.min(...bounds)) : null;
}

const gb = (mb) => { const g = mb / 1024; return `${Number.isInteger(g) ? g : g.toFixed(1)}G`; };

/**
 * @param {{cfg?: object, host: {memAvailableMb?: Function, freeMb?: Function, loadAvg1?: Function, cores?: Function, tmpPaths?: Function}}} p
 * @returns {Promise<{ok: boolean, reasons: string[], detail: string}>}
 */
export async function checkAdmission({ cfg = {}, host }) {
  const c = { ...ADMISSION_DEFAULTS, ...Object.fromEntries(Object.entries(cfg ?? {}).filter(([, v]) => v !== undefined && v !== null)) };
  if (c.enabled === false || !host) return { ok: true, reasons: [], detail: "" };
  const reasons = [];
  const safe = async (fn, ...a) => { try { const v = await fn?.(...a); return Number.isFinite(v) ? v : null; } catch { return null; } };
  const mem = await safe(host.memAvailableMb);
  if (mem !== null && mem < c.min_free_mem_mb) reasons.push(`mem ${gb(mem)} < ${gb(c.min_free_mem_mb)}`);
  let paths = [];
  try { paths = (await host.tmpPaths?.()) ?? []; } catch { paths = []; }
  for (const p of paths) {
    const free = await safe(host.freeMb, p);
    if (free !== null && free < c.min_free_tmp_mb) reasons.push(`tmp ${p} ${gb(free)} < ${gb(c.min_free_tmp_mb)}`);
  }
  const maxLoad = typeof c.max_load_per_core === "number" && Number.isFinite(c.max_load_per_core) ? c.max_load_per_core : null;
  const load = maxLoad === null ? null : await safe(host.loadAvg1), cores = maxLoad === null ? null : await safe(host.cores);
  if (load !== null && cores && load / cores > maxLoad) reasons.push(`load ${(load / cores).toFixed(1)}/core > ${maxLoad}`);
  return { ok: reasons.length === 0, reasons, detail: reasons.length ? `host busy: ${reasons.join(", ")}; retry in ${ADMISSION_RETRY_SECONDS}s` : "" };
}

/**
 * Near the admission ceiling (#4183): within `ratio` of any checkAdmission threshold (load/core >= ratio * max, or free
 * mem/tmp <= min / ratio). Orchestrate runs owned-resource GC before an admission when this is true. A failed or
 * non-finite probe never counts as near.
 */
export async function nearCeiling({ cfg = {}, host, ratio = 0.8 } = {}) {
  const c = { ...ADMISSION_DEFAULTS, ...Object.fromEntries(Object.entries(cfg ?? {}).filter(([, v]) => v !== undefined && v !== null)) };
  if (c.enabled === false || !host) return false;
  const r = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.8;
  const safe = async (fn, ...a) => { try { const v = await fn?.(...a); return Number.isFinite(v) ? v : null; } catch { return null; } };
  const maxLoad = typeof c.max_load_per_core === "number" && Number.isFinite(c.max_load_per_core) ? c.max_load_per_core : null; // off by default (#4169)
  const load = maxLoad === null ? null : await safe(host.loadAvg1), cores = maxLoad === null ? null : await safe(host.cores);
  if (load !== null && cores && load / cores >= r * maxLoad) return true;
  const mem = await safe(host.memAvailableMb);
  if (mem !== null && mem <= c.min_free_mem_mb / r) return true;
  let paths = [];
  try { paths = (await host.tmpPaths?.()) ?? []; } catch { paths = []; }
  for (const p of paths) { const free = await safe(host.freeMb, p); if (free !== null && free <= c.min_free_tmp_mb / r) return true; }
  return false;
}
