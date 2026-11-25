// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Closed-loop lane concurrency (#5985). K (`getParallel`/`--parallel`) is the ceiling; the operating point moves under it:
 * additive increase while the pool reports headroom and has refused nothing lately, multiplicative decrease (halve) on a
 * `pool.*` refusal or load above 1.5/core. A lane the pool refused is held for REFUSAL_HOLD_MS unless the named condition
 * (load below 1.0, free memory above the floor) clears first. Pure: no I/O, the caller feeds samples and persists events.
 */
export const REFUSAL_HOLD_MS = 5 * 60_000;
export const HEAVY_CPU_AVG = 1.5;
export const LOAD_HALVE = 1.5;
export const LOAD_GREEN = 1.0;
export const MEM_FLOOR_GB = 4;
export const MEM_HEADROOM_GB = 2;

const fin = (v) => typeof v === "number" && Number.isFinite(v);
/** `host_load` from a refusal reason/code (`pool.host_load` or `host_load`); "" when it is not a pool reason. */
export const poolReason = (v) => { const m = /^(?:pool\.)?(host_load|host_mem|projected_peak|disk(?:_low|_cap)?)$/.exec(String(v ?? "")); return m ? m[1].replace(/^disk_.*/, "disk") : ""; };

/** The named condition a refusal waits on: true = cleared, false = still holding, null = unknown (no figures, or no named condition). */
export function conditionCleared(reason, cap, { memFloorGb = MEM_FLOOR_GB } = {}) {
  const r = poolReason(reason);
  if (r === "host_load") return fin(cap?.load_per_core) ? cap.load_per_core < LOAD_GREEN : null;
  if (r === "host_mem") return fin(cap?.mem_available_gb) ? cap.mem_available_gb > memFloorGb : null;
  return null;
}

/** A repo is heavy when its recent finished lanes average more than 1.5 cpus (`usage-history.jsonl` rows `{repo, cpu_avg}`). */
export function classifyRepo(rows, repo, { window = 20 } = {}) {
  const v = (rows ?? []).filter((x) => x && x.repo === repo && fin(x.cpu_avg)).slice(-window).map((x) => x.cpu_avg);
  return v.length > 0 && v.reduce((a, b) => a + b, 0) / v.length > HEAVY_CPU_AVG ? "heavy" : "light";
}

export function makeController({ ceiling, heavyCap = null, now = Date.now, memFloorGb = MEM_FLOOR_GB, holdMs = REFUSAL_HOLD_MS, start = null } = {}) {
  let top = Math.max(1, Number.isInteger(ceiling) ? ceiling : 1);
  let k = Math.min(top, Math.max(1, Number.isInteger(start) ? start : top)); // no signal yet: run at the ceiling, as before
  let factor = "ceiling";
  let lastRefusal = -Infinity;
  const held = new Map(); // issue -> { at, reason }
  const hcap = () => Math.max(1, Math.min(top, Number.isInteger(heavyCap) ? heavyCap : Math.ceil(top / 3)));
  const ev = (change, inputs) => ({ event: "concurrency", change, k, ceiling: top, factor, inputs });
  return {
    setCeiling(c) { if (Number.isInteger(c) && c >= 1) { const was = top; top = c; k = k >= was ? top : Math.min(k, top); } },
    /** The operating point under the ceiling; a heavy lane class has its own, lower cap. */
    operating(klass = "light") { return Math.min(top, k, klass === "heavy" ? hcap() : Infinity); },
    ceiling: () => top,
    /** Concurrent heavy lanes allowed, separate from light lanes. */
    heavyLimit: () => hcap(),
    limiting(klass = "light") { return klass === "heavy" && hcap() < Math.min(top, k) ? "heavy cap" : k < top ? factor : "ceiling"; },
    /** A launch was refused. Halves on a `pool.*` reason or load above 1.5/core. Returns the event, or null when nothing moved. */
    refused({ issue = null, code = "", reason = "", live = null } = {}) {
      const r = poolReason(reason) || poolReason(code);
      const hot = fin(live?.load_per_core) && live.load_per_core > LOAD_HALVE;
      if (issue !== null && r) held.set(issue, { at: now(), reason: r });
      if (!r && !hot) return null;
      const t = now();
      if (t - lastRefusal < 1000) return null; // one storm of simultaneous refusals is one halving
      lastRefusal = t;
      const before = k;
      k = Math.max(1, Math.floor(k / 2));
      factor = r || "host_load";
      return k === before ? null : ev("decrease", { from: before, reason: r || "load", live });
    },
    /** One pool sample: +1 while memory is above floor+headroom, load below 1 and nothing was refused for `holdMs`. */
    observe(cap) {
      if (!cap || !fin(cap.load_per_core) || !fin(cap.mem_available_gb)) return null; // unknown pool: K applies unchanged
      if (k >= top) { factor = "ceiling"; return null; }
      if (cap.mem_available_gb > memFloorGb + MEM_HEADROOM_GB && cap.load_per_core < LOAD_GREEN && now() - lastRefusal >= holdMs) {
        const before = k; k += 1;
        if (k >= top) factor = "ceiling";
        return ev("increase", { from: before, load_per_core: cap.load_per_core, mem_available_gb: cap.mem_available_gb });
      }
      return null;
    },
    /** True while `issue` must not be launched: refused within holdMs and its named condition has not cleared. */
    holding(issue, cap) {
      const h = held.get(issue);
      if (!h) return false;
      if (conditionCleared(h.reason, cap, { memFloorGb }) === true || now() - h.at >= holdMs) { held.delete(issue); return false; }
      return true;
    },
    release(issue) { held.delete(issue); },
  };
}

/** `running/K/ceiling (limiting factor)`, with the configured ceiling as the achieved-vs-configured reference. */
export function formatConcurrency({ running, k, ceiling, factor = "ceiling" } = {}) {
  return `concurrency: ${running ?? 0}/${k ?? ceiling}/${ceiling} (${factor})`;
}
