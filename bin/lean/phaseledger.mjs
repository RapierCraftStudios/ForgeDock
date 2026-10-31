// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-lane phase ledger (#4908): where a lane's wall time goes. Engine phases only, nothing repo-specific.
 * The lane marks the phase it enters; entering one closes the previous, so the lane phases sum to the lane's wall time.
 * `queue_wait` (and, for a remote lane, the sandbox start the dispatcher saw) happens before the lane clock starts, so the
 * batch runner adds them to the row; they are not part of the lane-wall sum.
 * Row shape: `phases: { <id>: { ms, model_ms?, usd? } }`. FORGE:TELEMETRY values are scalars, so `flattenPhases` gives
 * `phase_<id>_ms|_model_ms|_usd` keys for it and `unflattenPhases` reads them back.
 */

export const PHASES = Object.freeze(["queue_wait", "sandbox_start", "deps_install", "validate", "plan", "implement", "precheck", "review", "ci_wait", "base_sync", "merge"]);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

function pct(values, p) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  if (p === 50) return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return v[Math.max(0, Math.ceil((v.length * p) / 100) - 1)];
}

/** Sequential ledger starting in `first` at `start`. `now` is the lane clock. */
export function createLedger(now, first = "sandbox_start", start = now()) {
  let cur = PHASES.includes(first) ? first : null, since = start;
  const ms = {}, model = {}, usd = {};
  const close = (t) => { if (cur) ms[cur] = (ms[cur] ?? 0) + Math.max(0, t - since); };
  const enter = (phase) => {
    if (!PHASES.includes(phase) || phase === cur) return;
    const t = now(); close(t); cur = phase; since = t;
  };
  return {
    enter,
    /** Run `fn` inside `phase`, then return to the phase that was current. */
    async during(phase, fn) {
      const prev = cur; enter(phase);
      try { return await fn(); } finally { if (prev) enter(prev); }
    },
    current: () => cur,
    addModel(phase, modelMs, cost) {
      const id = PHASES.includes(phase) ? phase : cur;
      if (!id) return;
      if (isNum(modelMs) && modelMs > 0) model[id] = (model[id] ?? 0) + modelMs;
      if (isNum(cost) && cost > 0) usd[id] = (usd[id] ?? 0) + cost;
    },
    /** The ledger as of now (the open phase counted up to now); does not end the current phase. */
    snapshot() {
      const t = now(), total = { ...ms };
      if (cur) total[cur] = (total[cur] ?? 0) + Math.max(0, t - since);
      const out = {};
      for (const id of PHASES) {
        if (!(id in total) && !(id in model) && !(id in usd)) continue;
        out[id] = { ms: Math.round(total[id] ?? 0), ...(model[id] ? { model_ms: Math.round(model[id]) } : {}), ...(usd[id] ? { usd: Math.round(usd[id] * 1e6) / 1e6 } : {}) };
      }
      return out;
    },
  };
}

/** Sum of the lane phases' durations (queue_wait excluded: it precedes the lane clock). */
export const laneSum = (phases) => Object.entries(phases ?? {}).reduce((s, [id, v]) => (id === "queue_wait" || !isNum(v?.ms) ? s : s + v.ms), 0);

/** True when the lane phases sum to within `tol` of `wallMs`. */
export const withinWall = (phases, wallMs, tol = 0.05) => isNum(wallMs) && wallMs >= 0 && Math.abs(laneSum(phases) - wallMs) <= Math.max(1, wallMs * tol);

export function flattenPhases(phases) {
  const out = {};
  for (const [id, v] of Object.entries(phases ?? {})) {
    if (!PHASES.includes(id) || !v) continue;
    if (isNum(v.ms)) out[`phase_${id}_ms`] = v.ms;
    if (isNum(v.model_ms)) out[`phase_${id}_model_ms`] = v.model_ms;
    if (isNum(v.usd)) out[`phase_${id}_usd`] = v.usd;
  }
  return out;
}

export function unflattenPhases(rec) {
  const out = {};
  for (const id of PHASES) {
    const ms = rec?.[`phase_${id}_ms`], mm = rec?.[`phase_${id}_model_ms`], usd = rec?.[`phase_${id}_usd`];
    if (!isNum(ms)) continue;
    out[id] = { ms, ...(isNum(mm) ? { model_ms: mm } : {}), ...(isNum(usd) ? { usd } : {}) };
  }
  return out;
}

/**
 * p50/p90 per phase over the given `phases` objects, and the phase with the largest share of the summed time.
 * `{ n: 0, phases: {}, largest: null }` when none carries a ledger.
 */
export function summarizePhases(list) {
  const by = {}, lanes = (list ?? []).filter((p) => p && typeof p === "object" && Object.keys(p).length);
  for (const p of lanes) for (const [id, v] of Object.entries(p)) if (PHASES.includes(id) && isNum(v?.ms) && v.ms >= 0) (by[id] ??= []).push(v.ms);
  const phases = {};
  let total = 0;
  for (const id of PHASES) {
    if (!by[id]) continue;
    const sum = by[id].reduce((a, b) => a + b, 0);
    total += sum;
    phases[id] = { n: by[id].length, p50: pct(by[id], 50), p90: pct(by[id], 90), sum };
  }
  let largest = null;
  for (const [id, v] of Object.entries(phases)) if (!largest || v.sum > phases[largest].sum) largest = id;
  return { n: lanes.length, phases, largest: largest ? { phase: largest, share: total > 0 ? phases[largest].sum / total : 0 } : null };
}

const min = (ms) => `${(ms / 60000).toFixed(1)}m`;

/** Report line(s) for p50/p90 per phase and the largest phase; `n/a` when no lane carried a ledger. Never throws. */
export function formatPhaseSummary(rows) {
  try {
    const s = summarizePhases((rows ?? []).map((r) => r?.phases));
    if (!s.n) return "phases (wall time): n/a";
    const parts = Object.entries(s.phases).map(([id, v]) => `${id} ${min(v.p50)}/${min(v.p90)}`);
    return `phases (p50/p90 per lane, ${s.n} lane${s.n === 1 ? "" : "s"}): ${parts.join(", ")}; largest: ${s.largest.phase} (${Math.round(s.largest.share * 100)}% of ledger time)`;
  } catch { return "phases (wall time): n/a"; }
}
