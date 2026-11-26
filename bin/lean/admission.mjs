// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host-resource admission for the core work-on (#4105): refuse to start a run when the host is out of headroom, so a
 * batch of lanes does not push the machine into OOM or a full /tmp. Every probe is injected through `host`.
 */
// #4169: load average lags by minutes and is phase-blind, so it is off unless configured; heavy steps are gated by
// the host heavy-step semaphore (heavy.mjs) instead. An explicit `max_load_per_core` is still honoured.
export const ADMISSION_DEFAULTS = Object.freeze({ enabled: true, min_free_mem_mb: 2048, min_free_tmp_mb: 1024, max_load_per_core: null, lane_cpu_reservation: 1, lane_mem_mb: 2048, ramp_s: 60, max_new_per_ramp: 4 });
// #5845: lanes admitted within `ramp_s` have not grown yet; `host.rampingMb/rampingLanes/laneFootprintMb` (effects.mjs) expose them. null `max_new_per_ramp` = no rate limit.
export const ADMISSION_RETRY_SECONDS = 60;

/**
 * #6047: usable cores = min(VM cores, the container's cgroup CPU quota). `read(path)` returns file text or throws; v2 `cpu.max`
 * ("<quota> <period>" or "max <period>"), v1 `cpu.cfs_quota_us` (-1 = unlimited) / `cpu.cfs_period_us`. `CS_CPU_QUOTA` (set by
 * the pool when the cgroup files are hidden from the lane) is the fallback. Unlimited or unreadable gives the VM cores.
 */
export function quotaCores({ cores, read, env = {} } = {}) {
  const vm = Number.isFinite(cores) && cores > 0 ? cores : 1;
  const num = (f) => { try { const v = Number(String(read?.(f) ?? "").trim()); return Number.isFinite(v) ? v : null; } catch { return null; } };
  let q = null;
  try {
    const [quota, period] = String(read?.("/sys/fs/cgroup/cpu.max") ?? "").trim().split(/\s+/);
    if (quota && quota !== "max" && Number(quota) > 0 && Number(period) > 0) q = Number(quota) / Number(period);
  } catch { /* not cgroup v2 */ }
  if (q === null) {
    const quota = num("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"), period = num("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
    if (quota > 0 && period > 0) q = quota / period;
  }
  if (q === null) { const e = Number(env?.CS_CPU_QUOTA); if (Number.isFinite(e) && e > 0) q = e; }
  return q === null ? vm : Math.max(1, Math.min(vm, Math.floor(q)));
}

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
export function localLaneCap({ cfg = {}, cores, memAvailableMb, rampingMb = 0 } = {}) {
  const c = { ...ADMISSION_DEFAULTS, ...Object.fromEntries(Object.entries(cfg ?? {}).filter(([, v]) => v !== undefined && v !== null)) };
  if (c.enabled === false) return null;
  const pos = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const bounds = [];
  if (Number.isFinite(cores) && cores > 0) bounds.push(Math.floor(cores / pos(c.lane_cpu_reservation, 1)));
  if (Number.isFinite(memAvailableMb)) bounds.push(Math.floor((memAvailableMb - (Number.isFinite(rampingMb) && rampingMb > 0 ? rampingMb : 0) - pos(c.min_free_mem_mb, 0)) / pos(c.lane_mem_mb, 2048)));
  return bounds.length ? Math.max(1, Math.min(...bounds)) : null;
}

const gb = (mb) => { const g = mb / 1024; return `${Number.isInteger(g) ? g : g.toFixed(1)}G`; };

/**
 * @param {{cfg?: object, host: {memAvailableMb?: Function, rampingMb?: Function, rampingLanes?: Function, laneFootprintMb?: Function, freeMb?: Function, loadAvg1?: Function, cores?: Function, tmpPaths?: Function}}} p
 * @returns {Promise<{ok: boolean, reasons: string[], detail: string}>}
 */
export async function checkAdmission({ cfg = {}, host }) {
  const c = { ...ADMISSION_DEFAULTS, ...Object.fromEntries(Object.entries(cfg ?? {}).filter(([, v]) => v !== undefined && v !== null)) };
  if (c.enabled === false || !host) return { ok: true, reasons: [], detail: "" };
  const reasons = [];
  const safe = async (fn, ...a) => { try { const v = await fn?.(...a); return Number.isFinite(v) ? v : null; } catch { return null; } };
  const mem = await safe(host.memAvailableMb);
  const rampS = Number.isFinite(c.ramp_s) && c.ramp_s > 0 ? c.ramp_s : ADMISSION_DEFAULTS.ramp_s;
  const ramping = mem === null ? null : await safe(host.rampingMb, rampS);
  if (mem !== null && mem < c.min_free_mem_mb) reasons.push(`mem ${gb(mem)} < ${gb(c.min_free_mem_mb)}`);
  else if (mem !== null && ramping !== null && ramping > 0) {
    const need = ((await safe(host.laneFootprintMb)) ?? c.lane_mem_mb) + c.min_free_mem_mb;
    if (mem - ramping < need) reasons.push(`projected mem ${gb(mem - ramping)} (free ${gb(mem)} − ramping ${gb(ramping)}) < need ${gb(need)}`);
  }
  const maxNew = Number.isFinite(c.max_new_per_ramp) && c.max_new_per_ramp > 0 ? c.max_new_per_ramp : null;
  const rampLanes = maxNew === null ? null : await safe(host.rampingLanes, rampS);
  if (rampLanes !== null && rampLanes >= maxNew) reasons.push(`${rampLanes} lanes admitted in the last ${rampS}s >= ${maxNew}`);
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
export async function nearCeiling({ cfg = {}, host, ratio = 0.8, minFreeGb = null } = {}) {
  const c = { ...ADMISSION_DEFAULTS, ...Object.fromEntries(Object.entries(cfg ?? {}).filter(([, v]) => v !== undefined && v !== null)) };
  if (c.enabled === false || !host) return false;
  const r = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.8;
  const safe = async (fn, ...a) => { try { const v = await fn?.(...a); return Number.isFinite(v) ? v : null; } catch { return null; } };
  const maxLoad = typeof c.max_load_per_core === "number" && Number.isFinite(c.max_load_per_core) ? c.max_load_per_core : null; // off by default (#4169)
  const load = maxLoad === null ? null : await safe(host.loadAvg1), cores = maxLoad === null ? null : await safe(host.cores);
  if (load !== null && cores && load / cores >= r * maxLoad) return true;
  if ((await diskLow({ host, minFreeGb: Number.isFinite(minFreeGb) && minFreeGb > 0 ? minFreeGb / r : null })).low) return true; // #5421
  const mem = await safe(host.memAvailableMb);
  const ramping = mem === null ? 0 : (await safe(host.rampingMb, Number.isFinite(c.ramp_s) && c.ramp_s > 0 ? c.ramp_s : ADMISSION_DEFAULTS.ramp_s)) ?? 0;
  if (mem !== null && mem - Math.max(0, ramping) <= c.min_free_mem_mb / r) return true;
  let paths = [];
  try { paths = (await host.tmpPaths?.()) ?? []; } catch { paths = []; }
  for (const p of paths) { const free = await safe(host.freeMb, p); if (free !== null && free <= c.min_free_tmp_mb / r) return true; }
  return false;
}

/**
 * Free-disk check (#5421): the filesystems holding the worktree root and `~/.forge` (`host.hygienePaths()`, else
 * `host.tmpPaths()`) against `minFreeGb` (hygiene.min_free_gb). A failed probe never counts as low; null/0 is off.
 * @returns {Promise<{low: boolean, reasons: string[]}>}
 */
export async function diskLow({ host, minFreeGb = null } = {}) {
  const min = Number(minFreeGb);
  if (!host || !Number.isFinite(min) || min <= 0) return { low: false, reasons: [] };
  let paths = [];
  try { paths = (await (host.hygienePaths ?? host.tmpPaths)?.call(host)) ?? []; } catch { paths = []; }
  const reasons = [];
  for (const p of paths) {
    let mb = null;
    try { const v = await host.freeMb?.(p); mb = Number.isFinite(v) ? v : null; } catch { mb = null; }
    if (mb !== null && mb / 1024 < min) reasons.push(`disk ${p} ${(mb / 1024).toFixed(1)} GB < ${min} GB`);
  }
  return { low: reasons.length > 0, reasons };
}
