// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Batch efficiency ledger (#5987): a pure fold of a batch's `log.jsonl` rows, its state and the schedd's pool samples into a
 * versioned `efficiency.json` (schema in devdocs/modules/lean.md). The failure/stall gates (batch-health.mjs) say a batch is broken;
 * this says it is slow: achieved vs ceiling concurrency, idle slot-minutes by cause, attempts per merge, engine comments per
 * issue, repeated failure signatures, operator interventions, phase p50/p90 vs a baseline, merged/hour, wasted lane-hours, $ per merge.
 *
 * Row fields read are the ones the orchestrator's `update(row)` writes to log.jsonl (all optional): `at`, `issue`, `outcome` (a terminal
 * lane row; `merged` is a good end; `added`, `breaker`, `deferred` are engine/operator notes), `code`, `detail`, `minutes`, `cost_usd`,
 * `phases:{id:{ms}}`. "Engine comments per issue" = the status updates (rows with a `detail`) the engine emitted for the issue.
 * Operator interventions = `--add` rows, `run.interrupted` rows (schedd restart), FORGE:DECISION text in a `detail`, plus `operator`
 * events the caller reads from the batch files (`requeue`, `hold-info`, `parallel`, see `operatorEvents`). Samples `{t, running, ceiling, ready, cause?}` are pushed by the daemon each pass and persisted in the file.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./batch.mjs";

export const EFFICIENCY_FILE = "efficiency.json";
export const EFFICIENCY_VERSION = 1;
export const IDLE_CAUSES = ["capacity", "lease-held", "base.red", "hold", "breaker", "auth-pause", "no-ready"];
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** Rows that are progress notes, not the end of a run; never counted as a failed attempt. */
const NOTE_OUTCOME = new Set(["recovering", "added", "breaker", "planned", "plan-failed", "pool-offline", "host-overloaded", "sched", "integration", "drift", "budget"]);
const OPERATOR_ROW = (r) => r.outcome === "added" || r.code === "run.interrupted" || /FORGE:DECISION/.test(String(r.detail ?? ""));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
const round = (v, d = 2) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const atMs = (r) => { const t = Date.parse(r?.at ?? ""); return Number.isFinite(t) ? t : null; };

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Phase durations (ms) by phase id over `rows`. */
export function phaseSpans(rows) {
  const by = {};
  for (const r of rows) for (const [id, v] of Object.entries(r?.phases ?? {})) { const ms = num(v?.ms); if (ms !== null && ms >= 0) (by[id] ??= []).push(ms); }
  const out = {};
  for (const [id, xs] of Object.entries(by)) { xs.sort((a, b) => a - b); out[id] = { n: xs.length, p50: percentile(xs, 0.5), p90: percentile(xs, 0.9) }; }
  return out;
}

const runMinutes = (r) => num(r.minutes) ?? (Object.entries(r.phases ?? {}).reduce((s, [id, v]) => (id === "queue_wait" ? s : s + (num(v?.ms) ?? 0)), 0) / MIN);

/** Time-weighted `{achieved, ceiling, ratio}` over the samples since `since`; each sample holds until the next one (or `now`). */
export function concurrencyOver(samples, since, now) {
  let dt = 0, run = 0, cap = 0;
  samples.forEach((s, i) => {
    const from = Math.max(s.t, since), to = Math.min(samples[i + 1]?.t ?? now, now);
    if (to <= from) return;
    dt += to - from; run += (num(s.running) ?? 0) * (to - from); cap += (num(s.ceiling) ?? 0) * (to - from);
  });
  return dt ? { achieved: round(run / dt), ceiling: round(cap / dt), ratio: cap ? round(run / cap, 3) : null } : { achieved: null, ceiling: null, ratio: null };
}

/**
 * Compute the ledger. `prev`: the prior efficiency.json (carries samples and SLO filing state), `sample`: this pass's pool sample,
 * `baseline`: `{phase: {p90}}` over the previous 14 days (default: this log's rows from the 14 days before the last 24 h), `concurrencyMin`: threshold used
 * for `lowSinceMin`. Pure; never throws on malformed rows.
 */
export function computeEfficiency({ rows = [], state = null, prev = null, sample = null, now = Date.now(), batchId = null, repo = null, operator = [], baseline = null, concurrencyMin = 0.6, windowMin = 15 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object");
  const samples = [...(Array.isArray(prev?.samples) ? prev.samples : []), ...(sample ? [{ ...sample, t: sample.t ?? now }] : [])]
    .filter((s) => Number.isFinite(s?.t) && s.t > now - DAY).slice(-1500);
  const day = list.filter((r) => (atMs(r) ?? now) > now - DAY);
  const terminal = day.filter((r) => r.outcome && r.issue != null && !NOTE_OUTCOME.has(r.outcome));
  const merged = new Set(terminal.filter((r) => r.outcome === "merged").map((r) => r.issue));
  for (const [n, v] of Object.entries(state?.results ?? {})) if (v?.outcome === "merged") merged.add(Number(n));
  const mergedNow = new Set([...merged].filter((n) => terminal.some((r) => r.issue === n && r.outcome === "merged")));

  // concurrency and idle slot-minutes by cause (24 h)
  const conc = concurrencyOver(samples, now - windowMin * MIN, now);
  const ready = num(samples.at(-1)?.ready) ?? (Array.isArray(state?.pending) ? state.pending.length : 0);
  let lowSince = null;
  for (let i = samples.length - 1; i >= 0; i--) { const s = samples[i]; if (!(num(s.ready) > 0) || !(num(s.ceiling) > 0) || num(s.running) / num(s.ceiling) >= concurrencyMin) break; lowSince = s.t; }
  const idle = {}; let slot = 0;
  samples.forEach((s, i) => {
    const to = Math.min(samples[i + 1]?.t ?? now, now), dt = (to - s.t) / MIN;
    if (dt <= 0) return;
    const cap = num(s.ceiling) ?? 0, run = num(s.running) ?? 0;
    slot += cap * dt;
    if (cap > run) { const c = s.cause ?? (num(s.ready) > 0 ? "capacity" : "no-ready"); idle[c] = (idle[c] ?? 0) + (cap - run) * dt; }
  });
  const idleByCause = Object.fromEntries(Object.entries(idle).map(([c, m]) => [c, round(m, 1)]));
  const idleShare = Object.fromEntries(Object.entries(idle).map(([c, m]) => [c, slot ? round(m / slot, 3) : 0]));

  // attempts, comments, signatures, interventions
  const attempts = terminal.filter((r) => mergedNow.has(r.issue)).length;
  const comments = {};
  for (const r of day) if (r.issue != null) { if (typeof r.detail === "string" && r.detail) comments[r.issue] = (comments[r.issue] ?? 0) + 1; }
  const sigs = {};
  for (const r of terminal) if (r.outcome !== "merged") { const sig = String(r.signature ?? `${r.outcome}:${r.code ?? r.reason ?? r.error ?? ""}`).slice(0, 160); (sigs[sig] ??= new Set()).add(r.issue); (sigs[sig].n = (sigs[sig].n ?? 0) + 1); }
  const repeats = Object.entries(sigs).map(([signature, s]) => ({ signature, count: s.n, issues: [...s].sort((a, b) => a - b) })).sort((a, b) => b.count - a.count);
  const opAt = (e) => (typeof e?.at === "number" ? e.at : Date.parse(e?.at ?? ""));
  const interventions = day.filter(OPERATOR_ROW).length + (Array.isArray(operator) ? operator : []).filter((e) => opAt(e) > now - DAY && opAt(e) <= now).length;
  const capacityRefusals = list.filter((r) => (atMs(r) ?? 0) > now - HOUR && /capacity/.test(String(r.code ?? ""))).length;

  // phases vs baseline
  const cur = phaseSpans(day);
  const base = baseline ?? Object.fromEntries(Object.entries(phaseSpans(list.filter((r) => { const t = atMs(r) ?? now; return t <= now - DAY && t > now - 15 * DAY; }))).map(([id, v]) => [id, { p90: v.p90 }]));
  const phases = Object.fromEntries(Object.entries(cur).map(([id, v]) => [id, { ...v, baselineP90: base[id]?.p90 ?? null, ratio: base[id]?.p90 ? round(v.p90 / base[id].p90) : null }]));

  // merged/hour, wasted lane-hours, $ per merge
  const spanH = Math.max(1, Math.min(24, (now - Math.min(now, ...day.map((r) => atMs(r) ?? now))) / HOUR));
  let wastedLater = 0, wastedNever = 0, usd = 0;
  for (const r of terminal) {
    usd += num(r.cost_usd) ?? 0;
    if (r.outcome === "merged") continue;
    (merged.has(r.issue) ? (wastedLater += runMinutes(r)) : (wastedNever += runMinutes(r)));
  }
  const running = state?.running && typeof state.running === "object" ? Object.keys(state.running).length : null;
  return {
    v: EFFICIENCY_VERSION, at: new Date(now).toISOString(), batch: batchId, repo,
    concurrency: { ...conc, windowMin, running, ready, lowSinceMin: lowSince === null ? 0 : round((now - lowSince) / MIN, 1), min: concurrencyMin },
    idle: { slotMinutes: round(slot, 1), byCause: idleByCause, share: idleShare },
    limiters: Object.entries(idleByCause).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c),
    attemptsPerMerged: mergedNow.size ? round(attempts / mergedNow.size) : null, merged: mergedNow.size,
    commentsPerIssue: { max: Math.max(0, ...Object.values(comments)), issues: Object.entries(comments).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => ({ issue: Number(n), comments: c })) },
    repeats: repeats.slice(0, 10), interventionsPerDay: interventions, capacityRefusalsPerHour: capacityRefusals,
    phases, mergedPerHour: round(mergedNow.size / spanH),
    wastedLaneHours: { laterMerged: round(wastedLater / 60), neverMerged: round(wastedNever / 60) },
    usdPerMerge: mergedNow.size ? round(usd / mergedNow.size) : null,
    samples, slo: prev?.slo ?? { sigs: {} }, breaches: prev?.breaches ?? [],
  };
}

/** Idle cause of the pool right now, from the batch's recent log rows (last 10 min); undefined when none applies (capacity/no-ready are inferred from `ready`). */
export function idleCause(rows, now = Date.now()) {
  const recent = (Array.isArray(rows) ? rows : []).filter((r) => r && (atMs(r) ?? 0) > now - 10 * MIN).reverse();
  const brk = recent.find((r) => r.outcome === "breaker");
  if (brk && !/cleared/.test(String(brk.detail ?? ""))) return "breaker";
  for (const r of recent) {
    const d = String(r.detail ?? "");
    if (/base\.red|base is red/.test(`${r.code ?? ""} ${d}`)) return "base.red";
    if (r.outcome === "deferred" && /live lane in batch/.test(d)) return "lease-held";
    if (/capacity/.test(String(r.code ?? ""))) return "capacity";
  }
  return undefined;
}

/** Operator actions recorded in a batch dir's files: `requeue` entries, `hold-info` (non-engine owners), the `parallel` file (`--set-parallel`). `[{at, kind}]`. */
export function operatorEvents(dir) {
  const out = [], j = (n) => { try { return JSON.parse(readFileSync(join(dir, n), "utf8")); } catch { return null; } };
  for (const e of Array.isArray(j("requeue")) ? j("requeue") : []) if (typeof e?.at === "string") out.push({ at: Date.parse(e.at), kind: "requeue" });
  for (const e of Object.values(j("hold-info") ?? {})) if (e && e.owner !== "engine" && typeof e.since === "string") out.push({ at: Date.parse(e.since), kind: "hold" });
  try { out.push({ at: statSync(join(dir, "parallel")).mtimeMs, kind: "set" }); } catch { /* none */ }
  return out.filter((e) => Number.isFinite(e.at));
}

export const readEfficiency = (dir) => { try { const v = JSON.parse(readFileSync(join(dir, EFFICIENCY_FILE), "utf8")); return v && v.v === EFFICIENCY_VERSION ? v : null; } catch { return null; } };
export const writeEfficiency = (dir, eff) => writeAtomic(join(dir, EFFICIENCY_FILE), JSON.stringify(eff) + "\n", { private: true });
export const hasEfficiency = (dir) => existsSync(join(dir, EFFICIENCY_FILE));

/** The `forgedock status` line: `efficiency: 3/12 lanes (25%) - limiter a b; 2 SLO breaches -> FD#NNNN`. null with no ledger. */
export function efficiencyLine(eff) {
  const c = eff?.concurrency;
  if (!c || c.running == null && c.achieved == null) return null;
  const run = c.running ?? Math.round(c.achieved), cap = Math.round(c.ceiling ?? 0), pct = cap ? Math.round((run / cap) * 100) : 0;
  const n = (eff.breaches ?? []).length, issues = [...new Set((eff.breaches ?? []).map((b) => b.issue).filter(Boolean))];
  return `efficiency: ${run}/${cap} lanes (${pct}%)${eff.limiters?.length ? ` - limiter ${eff.limiters.join(" ")}` : ""}${n ? `; ${n} SLO breach${n === 1 ? "" : "es"}${issues.length ? ` -> ${issues.map((i) => `FD#${i}`).join(" ")}` : ""}` : ""}`;
}
