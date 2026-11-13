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
 * #5649: `contract` (contract authoring and corrections) and `fix` (review/CI fix rounds) are their own phases; the batch summary
 * compares each phase's median/p75 with the previous 7 days of batches (`comparePhases`, `readBaselineRows`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const LANE_PHASES = Object.freeze(["queue_wait", "sandbox_start", "deps_install", "validate", "plan", "contract", "implement", "precheck", "review", "fix", "ci_wait", "base_sync", "merge"]);
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
  const ms = {}, model = {}, usd = {}, wait = {}, steps = {};
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
    /** #5435: `stepMs` spent in the named step of `phase` (sub-timing, e.g. sandbox_start's fetch); not added to the phase total. */
    addStep(phase, name, stepMs) {
      const id = LANE_PHASES.includes(phase) ? phase : cur;
      if (!id || typeof name !== "string" || !name || !isNum(stepMs) || stepMs < 0) return;
      (steps[id] ??= {})[name] = (steps[id][name] ?? 0) + stepMs;
    },
    /** The ledger as of now (the open phase counted up to now); does not end the current phase. */
    snapshot() {
      const t = now(), total = { ...ms };
      if (cur) total[cur] = (total[cur] ?? 0) + Math.max(0, t - since);
      const out = {};
      for (const id of LANE_PHASES) {
        if (!(id in total) && !(id in model) && !(id in usd)) continue;
        const w = waitOf(total[id] ?? 0, model[id] ?? 0, wait[id], id);
        out[id] = { ms: Math.round(total[id] ?? 0), ...(model[id] ? { model_ms: Math.round(model[id]) } : {}), ...(usd[id] ? { usd: Math.round(usd[id] * 1e6) / 1e6 } : {}), ...(Object.keys(w).length ? { wait: w } : {}), ...(steps[id] ? { steps: Object.fromEntries(Object.entries(steps[id]).map(([k, x]) => [k, Math.round(x)])) } : {}) };
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
    phases[id] = { n: by[id].length, p50: pct(by[id], 50), p75: pct(by[id], 75), p90: pct(by[id], 90), sum };
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
  const phases = {}, total = { ms: 0, model_ms: 0, wait: {} }, per = {}; // per[id][cause]: one value per lane, for p50/p90
  for (const p of lanes) for (const [id, v] of Object.entries(p)) {
    if (!LANE_PHASES.includes(id) || !isNum(v?.ms) || id === "queue_wait") continue;
    const g = (phases[id] ??= { ms: 0, model_ms: 0, wait: {} });
    for (const c of WAIT_CAUSES) if (isNum(v.wait?.[c])) ((per[id] ??= {})[c] ??= []).push(v.wait[c]);
    g.ms += v.ms; total.ms += v.ms;
    if (isNum(v.model_ms)) { g.model_ms += v.model_ms; total.model_ms += v.model_ms; }
    for (const c of WAIT_CAUSES) if (isNum(v.wait?.[c])) { g.wait[c] = (g.wait[c] ?? 0) + v.wait[c]; total.wait[c] = (total.wait[c] ?? 0) + v.wait[c]; }
  }
  for (const [id, byCause] of Object.entries(per)) phases[id].pct = Object.fromEntries(Object.entries(byCause).map(([c, vs]) => [c, { p50: pct(vs, 50), p90: pct(vs, 90) }]));
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

const DAY_MS = 86400000, GROWTH = 0.25;
const merged = (r) => r?.outcome === "merged";

/**
 * #5649: per phase the current median/p75 and the baseline's, with the median delta (ratio - 1, null without a baseline), plus
 * the lane wall time (merged rows' `minutes`) the same way. `prevRows` null/empty (no prior batches) gives `prev: null` everywhere.
 * Pure; rows without a ledger are skipped; a phase on one side only keeps the other side null.
 */
export function comparePhases(curRows, prevRows) {
  const side = (rows) => ({ s: summarizePhases((rows ?? []).map((r) => r?.phases)), wall: (rows ?? []).filter(merged).map((r) => r.minutes).filter(isNum).map((m) => m * 60000) });
  const c = side(curRows), p = side(prevRows);
  const stat = (v) => (v ? { median: v.p50, p75: v.p75, n: v.n } : null);
  const delta = (cur, prev) => (cur && prev && prev.median > 0 ? cur.median / prev.median - 1 : null);
  const phases = {};
  for (const id of LANE_PHASES) {
    const cur = stat(c.s.phases[id]), prev = stat(p.s.phases[id]);
    if (cur || prev) phases[id] = { cur, prev, delta: delta(cur, prev) };
  }
  const w = (a) => (a.length ? { median: pct(a, 50), p75: pct(a, 75), n: a.length } : null);
  const wall = { cur: w(c.wall), prev: w(p.wall) };
  wall.delta = delta(wall.cur, wall.prev);
  return { phases, wall, baseline: Boolean(p.s.n || p.wall.length) };
}

/**
 * #5649: the lane rows of the batches under `root` (default `~/.forge/batches`) whose last progress is within the previous
 * `days` days, excluding batch `excludeId`; the last row per issue of each batch. Read-only; null when it cannot be read.
 */
export function readBaselineRows({ root = process.env.FORGEDOCK_BATCH_DIR || join(homedir(), ".forge", "batches"), excludeId = null, now = Date.now(), days = 7 } = {}) {
  try {
    const out = [];
    for (const id of readdirSync(root)) {
      if (id === excludeId) continue;
      try {
        const f = join(root, id, "log.jsonl");
        if (now - statSync(f).mtimeMs > days * DAY_MS) continue;
        const last = new Map();
        for (const l of readFileSync(f, "utf8").split("\n")) { try { const r = l && JSON.parse(l); if (r && r.issue != null) last.set(r.issue, r); } catch { /* skip */ } }
        out.push(...last.values());
      } catch { /* a batch without a log */ }
    }
    return out;
  } catch { return null; }
}

/** #5649: one line per phase, `<phase> median Xm (prev7d Ym) p75 Xm (prev7d Ym)`, `!` after a median that grew over 25%; then lane wall. */
export function formatPhaseComparison(curRows, prevRows) {
  try {
    const c = comparePhases(curRows, prevRows);
    const m = (v, k) => (v ? min(v[k]) : "n/a");
    const wm = (v, k) => (v ? `${v[k].toFixed(1)}m` : "n/a");
    const line = (id, v, f) => `${id} median ${f(v.cur, "median")} (prev7d ${f(v.prev, "median")}) p75 ${f(v.cur, "p75")} (prev7d ${f(v.prev, "p75")})${v.delta != null && v.delta > GROWTH ? ` ! median +${Math.round(v.delta * 100)}%` : ""}`;
    const lines = Object.entries(c.phases).map(([id, v]) => line(id, v, m));
    if (c.wall.cur || c.wall.prev) lines.push(line("lane wall (merged)", { ...c.wall, cur: c.wall.cur && { median: c.wall.cur.median / 60000, p75: c.wall.cur.p75 / 60000 }, prev: c.wall.prev && { median: c.wall.prev.median / 60000, p75: c.wall.prev.p75 / 60000 } }, wm));
    return lines.length ? lines : ["phases vs prev7d: n/a"];
  } catch { return ["phases vs prev7d: n/a"]; }
}

/** #5435: the local `sandbox_start` budget (issue: p50 <= 3 s on the bench corpus). */
export const SANDBOX_START_P50_BUDGET_MS = 3000;

/** p50 of `sandbox_start` over the lanes' `phases` objects against the budget; `ok` is true when no lane carried the phase. */
export function sandboxStartBudget(list, budgetMs = SANDBOX_START_P50_BUDGET_MS) {
  const v = summarizePhases(list).phases.sandbox_start;
  return { n: v?.n ?? 0, p50: v?.p50 ?? null, budgetMs, ok: !v || v.p50 <= budgetMs };
}
