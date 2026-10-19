// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host-resource admission for the core work-on (#4105): refuse to start a run when the host is out of headroom, so a
 * batch of lanes does not push the machine into OOM or a full /tmp. Every probe is injected through `host`.
 */
export const ADMISSION_DEFAULTS = Object.freeze({ enabled: true, min_free_mem_mb: 2048, min_free_tmp_mb: 1024, max_load_per_core: 4 });
export const ADMISSION_RETRY_SECONDS = 60;

/** Workers one lane's verification may use (#4182): max(1, floor(cores / live lanes)); bad inputs count as 1. */
export function hostParallelism({ cores, lanes } = {}) {
  const c = Number.isFinite(cores) && cores > 0 ? cores : 1, l = Number.isFinite(lanes) && lanes > 0 ? lanes : 1;
  return Math.max(1, Math.floor(c / l));
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
  const load = await safe(host.loadAvg1), cores = await safe(host.cores);
  if (load !== null && cores && load / cores > c.max_load_per_core) reasons.push(`load ${(load / cores).toFixed(1)}/core > ${c.max_load_per_core}`);
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
  const load = await safe(host.loadAvg1), cores = await safe(host.cores);
  if (load !== null && cores && load / cores >= r * c.max_load_per_core) return true;
  const mem = await safe(host.memAvailableMb);
  if (mem !== null && mem <= c.min_free_mem_mb / r) return true;
  let paths = [];
  try { paths = (await host.tmpPaths?.()) ?? []; } catch { paths = []; }
  for (const p of paths) { const free = await safe(host.freeMb, p); if (free !== null && free <= c.min_free_tmp_mb / r) return true; }
  return false;
}
