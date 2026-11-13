// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Actions minutes per release (#5569, epic #5549 5.8): minutes = sum of ceil(job minutes) from the jobs API (billable_ms is 0 on
 * some repos, so it is ignored), recorded in the release state (mirrored to the ledger when managed); the forecast is the lane's
 * trailing median; `budget.on_exceed` (local-first | hold | proceed) is applied at the gate before the release starts. p0 is never
 * blocked (I14). The monthly model report and its 25% check are pure. Used only when `release.managed`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ON_EXCEED = Object.freeze(["local-first", "hold", "proceed"]);
export const MODEL_TOLERANCE = 0.25;
const json = (s) => { try { return JSON.parse(String(s)); } catch { return null; } };

/** forge.yaml `budget:` -> {onExceed, ignore}; junk falls back to local-first. `ignore: true` (lane config `budget: ignore`) never blocks. */
export function parseBudgetConfig(sec) {
  const s = sec && typeof sec === "object" ? sec : {};
  const v = String(s.on_exceed ?? "").trim().toLowerCase();
  return { onExceed: ON_EXCEED.includes(v) ? v : "local-first", modelPerRelease: Number(s.model_release_minutes) > 0 ? Number(s.model_release_minutes) : 500, ignore: String(s.ignore ?? "").trim().toLowerCase() === "true" };
}

/** Sum of ceil(minutes) over the jobs of a jobs-API payload (jobs without both timestamps count 0). */
export function jobMinutes(payload) {
  let total = 0;
  for (const j of payload?.jobs ?? []) {
    const ms = Date.parse(j.completed_at) - Date.parse(j.started_at);
    if (ms > 0) total += Math.ceil(ms / 60_000);
  }
  return total;
}

/** Minutes of the runs created since `sinceMs` (optionally one branch), from the jobs API; null when the runs are unreadable. */
export async function releaseMinutes({ gh, repo, sinceMs, branch = null }) {
  const q = `repos/${repo}/actions/runs?per_page=100&created=>=${new Date(sinceMs).toISOString()}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`;
  const runs = json(await gh(["api", q]))?.workflow_runs;
  if (!Array.isArray(runs)) return null;
  let minutes = 0;
  for (const r of runs) minutes += jobMinutes(json(await gh(["api", `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`])));
  return { runs: runs.length, minutes };
}

/** Records `{lane, minutes}` of the finished releases kept under `root` (the local cache of the ledger states). */
export function historyFromRoot(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const id of readdirSync(root)) {
    try { const s = JSON.parse(readFileSync(join(root, id, "state.json"), "utf8")); if (s?.minutes?.total > 0) out.push({ lane: s.lane ?? "release", minutes: s.minutes.total }); } catch { /* skip */ }
  }
  return out;
}

/** Gate telemetry records (#5583) of the releases kept under `root`, oldest release first, each with `release` and `at`; [] when none. */
export function gateHistoryFromRoot(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const id of readdirSync(root).sort()) {
    try { const s = JSON.parse(readFileSync(join(root, id, "state.json"), "utf8")); for (const g of Array.isArray(s?.gates) ? s.gates : []) out.push({ ...g, release: id, at: s.startedAt }); } catch { /* skip */ }
  }
  return out;
}

/** Median of the last `n` records of `lane`; null with no history. */
export function trailingMedian(records, lane = "release", n = 5) {
  const v = records.filter((r) => (r.lane ?? "release") === lane).slice(-n).map((r) => r.minutes).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The action at the gate: `proceed` when p0, budget ignored, forecast unknown or it fits `remaining`; else the configured `onExceed`.
 * @returns {{action: "proceed"|"local-first"|"hold", why}}
 */
export function applyOnExceed({ lane = "release", forecast, remaining, cfg }) {
  if (lane === "p0" || cfg?.ignore) return { action: "proceed", why: lane === "p0" ? "p0 is never blocked by budget" : "budget ignored" };
  if (forecast == null || remaining == null) return { action: "proceed", why: "no forecast or budget known" };
  if (forecast <= remaining) return { action: "proceed", why: `forecast ${forecast} min within ${Math.round(remaining)} min left` };
  return { action: cfg?.onExceed ?? "local-first", why: `forecast ${forecast} min exceeds ${Math.round(remaining)} min left` };
}

/** True when the measured minutes are within `tol` of the model's (the 25% exit criterion of 5.8). */
export const withinTolerance = (model, measured, tol = MODEL_TOLERANCE) => model > 0 && Math.abs(measured - model) / model <= tol;

/** Monthly model report: items [{name, model, measured}] -> {lines, model, measured, within}; measured-less items are shown as `n/a`. */
export function monthlyModel(items) {
  const done = items.filter((i) => i.measured != null);
  const model = items.reduce((a, i) => a + i.model, 0), measured = done.reduce((a, i) => a + i.measured, 0);
  const comparable = done.reduce((a, i) => a + i.model, 0);
  return {
    lines: items.map((i) => `${i.name}: model ${i.model} min, measured ${i.measured ?? "n/a"}`),
    model, measured, within: done.length > 0 && withinTolerance(comparable, measured),
  };
}

/** Report over the first 3 recorded releases (the managed waves of 5.8): model = `model_release_minutes` each (default 500) vs measured. */
export function waveReport(records, cfg = parseBudgetConfig(null)) {
  const waves = records.filter((r) => (r.lane ?? "release") === "release").slice(0, 3);
  const m = monthlyModel(waves.map((w, i) => ({ name: `release wave ${i + 1}`, model: cfg.modelPerRelease, measured: w.minutes })));
  const verdict = waves.length < 3 ? `${waves.length}/3 waves measured` : m.within ? "within 25% of the model" : "OUTSIDE 25% of the model: tune budget.on_exceed and the nightly cadence";
  return { ...m, waves: waves.length, lines: [...m.lines, `total: model ${m.model} min, measured ${m.measured} min (${verdict})`] };
}
