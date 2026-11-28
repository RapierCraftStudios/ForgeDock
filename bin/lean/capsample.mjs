// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pool capacity sampler (#4540, #5048, #5985): `capacity()` is sync (admission is sync) and refreshes `provider.capacity()` in the
 * background at most every `pollMs`. `null` = unknown, `{free, online, load_per_core?, mem_available_gb?, at}` = a sample (`at` counts
 * samples, failures included). A failed probe makes every caller see a throw until the next SUCCESSFUL sample; the refresh runs
 * before that throw, so a recovered pool clears it. (It used to run after, so one failed probe, e.g. a pool restart, kept the
 * batch on "capacity probe failed" for good: no capacity gating, no K controller input, the pool marked down until a daemon restart.)
 */
export function makeCapacitySampler({ provider, now = Date.now, pollMs = 5000 } = {}) {
  let free = null, online = null, at = 0, last = -Infinity, failed = false, live = {}, hosts = null;
  return () => {
    const t = now();
    if (typeof provider?.capacity === "function" && t - last >= pollMs) {
      last = t;
      Promise.resolve().then(() => provider.capacity()).then((c) => {
        failed = false; free = c && Number.isInteger(c.free) ? c.free : null; online = c && Number.isInteger(c.online) ? c.online : null;
        live = { ...(Number.isFinite(c?.load_per_core) ? { load_per_core: c.load_per_core } : {}), ...(Number.isFinite(c?.mem_available_gb) ? { mem_available_gb: c.mem_available_gb } : {}) };
        hosts = Array.isArray(c?.hosts) && c.hosts.length ? c.hosts : null; // #6267
        at++;
      }, () => { free = null; online = null; failed = true; at++; });
    }
    if (failed) throw new Error("capacity probe failed"); // #5048: until the next successful sample, so every caller sees it (release review CONC-1)
    return free === null && online === null ? null : { free, online, ...live, ...(hosts ? { hosts } : {}), at };
  };
}
