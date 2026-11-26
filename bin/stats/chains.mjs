// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5834: stacked-lane chain metrics for `forgedock stats --chains`, from the repo's local batch report.json rows (`deps`,
 * `admitted_at`, `ended_at`, `plan_minutes`, `stacked`, `cascade*`). No network, no model. A chain is a connected set of
 * in-batch dependency edges; depth is its longest path in issues; wall time runs from the first admission to the last end.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listBatches } from "../lean/batch.mjs";
import { sameRepo, windowLabel } from "./efficiency.mjs";

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const round1 = (x) => Math.round(x * 10) / 10;
const MIN = 60000;
const p50 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return round1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };

const byDepth = (chains) => {
  const depths = {};
  for (const c of chains) (depths[c.depth] ??= []).push(c.wall_min);
  return Object.fromEntries(Object.entries(depths).map(([d, w]) => [d, { chains: w.length, wall_p50_min: p50(w) }]));
};

/** Cascade rework over the stacked dependents among `rows`: share that cascaded, cascades each, and rework minutes and cost. */
export function cascadeMetrics(rows) {
  const stacked = (rows ?? []).filter((r) => r?.stacked);
  const cascaded = stacked.filter((r) => r.cascade);
  const count = cascaded.reduce((s, r) => s + (Array.isArray(r.cascades) ? r.cascades.length : 1), 0);
  return {
    stacked: stacked.length, cascaded: cascaded.length, cascades: count,
    rework_rate: stacked.length ? Math.round((cascaded.length / stacked.length) * 1000) / 1000 : null,
    per_stacked: stacked.length ? Math.round((count / stacked.length) * 100) / 100 : null,
    cost_usd: Math.round(cascaded.reduce((s, r) => s + (Number(r.cascade_cost_usd) || 0), 0) * 1e6) / 1e6,
    minutes: round1(cascaded.reduce((s, r) => s + (Number(r.cascade_minutes) || 0), 0)),
  };
}

/** Chains, per-depth wall p50 and cascade rework from final rows (latest row per issue). Rows without timestamps are skipped. */
export function chainMetrics(rows) {
  const by = new Map();
  for (const r of rows ?? []) if (Number.isSafeInteger(r?.issue) && Number.isFinite(r.admitted_at) && Number.isFinite(r.ended_at)) by.set(r.issue, r);
  const edges = (n) => (by.get(n)?.deps ?? []).filter((d) => by.has(d) && d !== n);
  const parent = new Map([...by.keys()].map((n) => [n, n]));
  const find = (n) => { while (parent.get(n) !== n) { parent.set(n, parent.get(parent.get(n))); n = parent.get(n); } return n; };
  for (const n of by.keys()) for (const d of edges(n)) parent.set(find(n), find(d));
  const groups = new Map();
  for (const n of by.keys()) { const g = find(n); (groups.get(g) ?? groups.set(g, []).get(g)).push(n); }
  const depthMemo = new Map();
  const depthOf = (n, seen = new Set()) => {
    if (depthMemo.has(n)) return depthMemo.get(n);
    if (seen.has(n)) return 1; // a cycle cannot extend a chain
    seen.add(n);
    const d = 1 + Math.max(0, ...edges(n).map((e) => depthOf(e, seen)));
    seen.delete(n); depthMemo.set(n, d); return d;
  };
  const chains = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a - b);
    const start = Math.min(...members.map((n) => by.get(n).admitted_at)), end = Math.max(...members.map((n) => by.get(n).ended_at));
    const links = [];
    for (const n of members) for (const d of edges(n)) {
      const a = by.get(n), p = by.get(d);
      links.push({ issue: n, dependency: d, overlap_min: round1(Math.max(0, Math.min(a.ended_at, p.ended_at) - a.admitted_at) / MIN) });
    }
    chains.push({ issues: members, depth: Math.max(...members.map((n) => depthOf(n))), wall_min: round1((end - start) / MIN), links });
  }
  return { chains, by_depth: byDepth(chains), cascade: cascadeMetrics(rows) };
}

/** Per window: the repo's batches created in it; an issue in several batches counts once (latest row). */
export function chainsReport({ batchRoot, repo = null, windows, now = Date.now() }) {
  const batches = (existsSync(batchRoot) ? listBatches(batchRoot) : []).map((id) => {
    const dir = join(batchRoot, id), plan = readJson(join(dir, "plan.json")) ?? {};
    return { dir, plan, created: Date.parse(plan.created ?? "") };
  }).filter((b) => Number.isFinite(b.created) && (!repo || sameRepo(b.plan.repo, repo))).sort((a, b) => a.created - b.created);
  const out = {};
  for (const w of windows) {
    const inWin = batches.filter((b) => b.created <= now && now - b.created <= w);
    const chains = [], rows = [];
    for (const b of inWin) { // chains stay within one batch: edges are in-batch; cascade rates pool every batch's rows
      const r = readJson(join(b.dir, "report.json"))?.rows ?? [];
      chains.push(...chainMetrics(r).chains); rows.push(...r);
    }
    out[windowLabel(w)] = { batches: inWin.length, chains: chains.length, by_depth: byDepth(chains), cascade: cascadeMetrics(rows), detail: chains };
  }
  return out;
}

export function formatChainLines(windows) {
  return Object.entries(windows).flatMap(([w, m]) => {
    const head = `chains ${w}: ${m.batches} batch${m.batches === 1 ? "" : "es"}, ${m.chains} chain${m.chains === 1 ? "" : "s"}`;
    const depth = Object.entries(m.by_depth).sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([d, e]) => `  depth ${d}: ${e.chains} chain${e.chains === 1 ? "" : "s"}, wall p50 ${e.wall_p50_min.toFixed(1)} min`);
    const overlap = m.detail.flatMap((c) => c.links).map((l) => l.overlap_min);
    const c = m.cascade;
    return [head, ...(depth.length ? depth : ["  chain wall p50: n/a"]),
      `  link overlap p50: ${overlap.length ? `${p50(overlap).toFixed(1)} min` : "n/a"}`,
      `  cascade rework: ${c.rework_rate == null ? "n/a" : `${Math.round(c.rework_rate * 100)}% of ${c.stacked} stacked dependent${c.stacked === 1 ? "" : "s"}, ${c.per_stacked} cascades each, ${c.minutes.toFixed(1)} min, $${c.cost_usd}`}`];
  });
}
