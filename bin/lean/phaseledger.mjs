// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-lane phase ledger (#4908): where a lane's wall time goes. Engine phases only, nothing repo-specific.
 * The lane marks the phase it enters; entering one closes the previous, so the lane phases sum to the lane's wall time.
 * `queue_wait` (and, for a remote lane, the sandbox start the dispatcher saw) happens before the lane clock starts, so the
 * batch runner adds them to the row; they are not part of the lane-wall sum.
 * Row shape: `phases: { <id>: { ms, model_ms?, usd?, wait? } }`. FORGE:TELEMETRY values are scalars, so `flattenPhases` gives
 * `phase_<id>_ms|_model_ms|_usd|_wait_<cause>_ms` keys for it and `unflattenPhases` reads them back.
 * #5349: `wait` is the phase's non-model time by cause (WAIT_CAUSES); what no typed wait explains is `command` (`sandbox` in
 * sandbox_start), so model_ms + the wait causes close to ms.
 */

export const LANE_PHASES = Object.freeze(["queue_wait", "sandbox_start", "deps_install", "validate", "plan", "implement", "precheck", "review", "ci_wait", "base_sync", "merge"]);
/** Why a lane was not in a model call: queued for a heavy slot, paused for host load, rate-limited, sandbox start, or running a command. */
export const WAIT_CAUSES = Object.freeze(["heavy_queue", "host_load", "rate_limit", "sandbox", "command"]);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

function pct(values, p) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  if (p === 50) return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return v[Math.max(0, Math.ceil((v.length * p) / 100) - 1)];
}

/** Typed waits rounded, plus the residual (ms - model - typed waits, never negative) as `sandbox` in sandbox_start, else `command`. */
function waitOf(ms, modelMs, typed = {}, id) {
  const w = {};
  for (const c of WAIT_CAUSES) if (typed[c] > 0) w[c] = Math.round(typed[c]);
  const rest = Math.round(ms - modelMs - Object.values(w).reduce((a, b) => a + b, 0));
  if (rest > 0) { const c = id === "sandbox_start" ? "sandbox" : "command"; w[c] = (w[c] ?? 0) + rest; }
  return w;
}

/** Sequential ledger starting in `first` at `start`. `now` is the lane clock. */
export function createLedger(now, first = "sandbox_start", start = now()) {
  let cur = LANE_PHASES.includes(first) ? first : null, since = start;
  const ms = {}, model = {}, usd = {}, wait = {};
  const close = (t) => { if (cur) ms[cur] = (ms[cur] ?? 0) + Math.max(0, t - since); };
  const enter = (phase) => {
    if (!LANE_PHASES.includes(phase) || phase === cur) return;
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
      const id = LANE_PHASES.includes(phase) ? phase : cur;
      if (!id) return;
      if (isNum(modelMs) && modelMs > 0) model[id] = (model[id] ?? 0) + modelMs;
      if (isNum(cost) && cost > 0) usd[id] = (usd[id] ?? 0) + cost;
    },
    /** `waitMs` of `cause` (a typed wait) spent in `phase` (the current one when it is not a ledger phase). */
    addWait(phase, cause, waitMs) {
      const id = LANE_PHASES.includes(phase) ? phase : cur;
      if (!id || !WAIT_CAUSES.includes(cause) || !isNum(waitMs) || waitMs <= 0) return;
      (wait[id] ??= {})[cause] = (wait[id][cause] ?? 0) + waitMs;
    },
    /** The ledger as of now (the open phase counted up to now); does not end the current phase. */
    snapshot() {
      const t = now(), total = { ...ms };
      if (cur) total[cur] = (total[cur] ?? 0) + Math.max(0, t - since);
      const out = {};
      for (const id of LANE_PHASES) {
        if (!(id in total) && !(id in model) && !(id in usd)) continue;
        const w = waitOf(total[id] ?? 0, model[id] ?? 0, wait[id], id);
        out[id] = { ms: Math.round(total[id] ?? 0), ...(model[id] ? { model_ms: Math.round(model[id]) } : {}), ...(usd[id] ? { usd: Math.round(usd[id] * 1e6) / 1e6 } : {}), ...(Object.keys(w).length ? { wait: w } : {}) };
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
    if (!LANE_PHASES.includes(id) || !v) continue;
    if (isNum(v.ms)) out[`phase_${id}_ms`] = v.ms;
    if (isNum(v.model_ms)) out[`phase_${id}_model_ms`] = v.model_ms;
    if (isNum(v.usd)) out[`phase_${id}_usd`] = v.usd;
    for (const c of WAIT_CAUSES) if (isNum(v.wait?.[c])) out[`phase_${id}_wait_${c}_ms`] = v.wait[c];
  }
  return out;
}

export function unflattenPhases(rec) {
  const out = {};
  for (const id of LANE_PHASES) {
    const ms = rec?.[`phase_${id}_ms`], mm = rec?.[`phase_${id}_model_ms`], usd = rec?.[`phase_${id}_usd`];
    if (!isNum(ms)) continue;
    const wait = {};
    for (const c of WAIT_CAUSES) if (isNum(rec?.[`phase_${id}_wait_${c}_ms`])) wait[c] = rec[`phase_${id}_wait_${c}_ms`];
    out[id] = { ms, ...(isNum(mm) ? { model_ms: mm } : {}), ...(isNum(usd) ? { usd } : {}), ...(Object.keys(wait).length ? { wait } : {}) };
  }
  return out;
}

/**
 * p50/p90 per phase over the given `phases` objects, and the phase with the largest share of the summed time.
 * `{ n: 0, phases: {}, largest: null }` when none carries a ledger.
 */
export function summarizePhases(list) {
  const by = {}, lanes = (list ?? []).filter((p) => p && typeof p === "object" && Object.keys(p).length);
  for (const p of lanes) for (const [id, v] of Object.entries(p)) if (LANE_PHASES.includes(id) && isNum(v?.ms) && v.ms >= 0) (by[id] ??= []).push(v.ms);
  const phases = {};
  let total = 0;
  for (const id of LANE_PHASES) {
    if (!by[id]) continue;
    const sum = by[id].reduce((a, b) => a + b, 0);
    total += sum;
    phases[id] = { n: by[id].length, p50: pct(by[id], 50), p90: pct(by[id], 90), sum };
  }
  let largest = null;
  for (const [id, v] of Object.entries(phases)) if (!largest || v.sum > phases[largest].sum) largest = id;
  return { n: lanes.length, phases, largest: largest ? { phase: largest, share: total > 0 ? phases[largest].sum / total : 0 } : null };
}

/**
 * #5349: non-model time over the given `phases` objects: per phase the summed wall, model and wait-by-cause, and the totals.
 * Only lanes that carry a `wait` breakdown count (older runs have none); `{ n: 0, ... }` when there is none.
 */
export function summarizeWaits(list) {
  const lanes = (list ?? []).filter((p) => p && typeof p === "object" && Object.values(p).some((v) => v?.wait && typeof v.wait === "object"));
  const phases = {}, total = { ms: 0, model_ms: 0, wait: {} };
  for (const p of lanes) for (const [id, v] of Object.entries(p)) {
    if (!LANE_PHASES.includes(id) || !isNum(v?.ms) || id === "queue_wait") continue;
    const g = (phases[id] ??= { ms: 0, model_ms: 0, wait: {} });
    g.ms += v.ms; total.ms += v.ms;
    if (isNum(v.model_ms)) { g.model_ms += v.model_ms; total.model_ms += v.model_ms; }
    for (const c of WAIT_CAUSES) if (isNum(v.wait?.[c])) { g.wait[c] = (g.wait[c] ?? 0) + v.wait[c]; total.wait[c] = (total.wait[c] ?? 0) + v.wait[c]; }
  }
  return { n: lanes.length, phases, total };
}

const min = (ms) => `${(ms / 60000).toFixed(1)}m`;

/** Report line(s) for p50/p90 per phase and the largest phase; `n/a` when no lane carried a ledger. Never throws. */
export function formatLedgerSummary(rows) {
  try {
    const s = summarizePhases((rows ?? []).map((r) => r?.phases));
    if (!s.n) return "phases (wall time): n/a";
    const parts = Object.entries(s.phases).map(([id, v]) => `${id} ${min(v.p50)}/${min(v.p90)}`);
    return `phases (p50/p90 per lane, ${s.n} lane${s.n === 1 ? "" : "s"}): ${parts.join(", ")}; largest: ${s.largest.phase} (${Math.round(s.largest.share * 100)}% of ledger time)`;
  } catch { return "phases (wall time): n/a"; }
}
