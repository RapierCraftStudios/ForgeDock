// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5692: `forgedock stats --ci-awareness`. Per lane (one RUN_START slice of a run log): time from the failing step's
 * completion (CI_AWARE `event_ts`) to the lane's awareness (`aware_ts`), CI fix rounds per PR and wall time per round
 * (CI_FIX_ROUND to the next round, or to RUN_TERMINAL for the last). Grouped by engine version, so the lanes before and
 * after the event-driven wait are separate rows. Local run logs only; no network, no model.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "./local-source.mjs";

const ms = (t) => { const v = Date.parse(t ?? ""); return Number.isFinite(v) ? v : null; };
const quant = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const dist = (xs) => ({ n: xs.length, median: round1(quant(xs, 0.5)), p90: round1(quant(xs, 0.9)) });

/** Lanes of one parsed log: [{version, awareness_s: [], rounds: {pr: n}, round_wall_s: []}]. */
export function lanesOf(events) {
  const lanes = [];
  let cur = null;
  const closeRound = (endTs) => { if (cur?.openRound != null && endTs != null) cur.round_wall_s.push((endTs - cur.openRound) / 1000); if (cur) cur.openRound = null; };
  for (const e of events) {
    const t = ms(e.ts);
    if (e.event === "RUN_START") { closeRound(null); cur = { version: e.version ?? null, awareness_s: [], rounds: {}, round_wall_s: [], openRound: null }; lanes.push(cur); continue; }
    if (!cur) continue;
    if (e.event === "CI_AWARE") { const a = ms(e.aware_ts) ?? t, b = ms(e.event_ts); if (a != null && b != null && a >= b) cur.awareness_s.push((a - b) / 1000); }
    else if (e.event === "CI_FIX_ROUND") { closeRound(t); const k = String(e.pr ?? "?"); cur.rounds[k] = (cur.rounds[k] ?? 0) + 1; cur.openRound = t; }
    else if (e.event === "RUN_TERMINAL") closeRound(t);
  }
  return lanes.filter((l) => l.awareness_s.length || Object.keys(l.rounds).length || true);
}

/** Report over parsed logs `[{events}]`: per version, awareness latency (median/p90), rounds per PR and wall per round. */
export function ciAwarenessReport(logs) {
  const by = new Map();
  for (const lg of logs) for (const l of lanesOf(lg)) {
    const g = by.get(l.version ?? "unknown") ?? { version: l.version ?? "unknown", lanes: 0, awareness_s: [], rounds_per_pr: [], round_wall_s: [] };
    g.lanes++; g.awareness_s.push(...l.awareness_s); g.round_wall_s.push(...l.round_wall_s);
    g.rounds_per_pr.push(...Object.values(l.rounds));
    by.set(g.version, g);
  }
  const versions = [...by.values()].sort((a, b) => String(a.version).localeCompare(String(b.version), undefined, { numeric: true }))
    .map((g) => ({ version: g.version, lanes: g.lanes, awareness_s: dist(g.awareness_s), rounds_per_pr: { ...dist(g.rounds_per_pr), mean: g.rounds_per_pr.length ? round1(g.rounds_per_pr.reduce((a, b) => a + b, 0) / g.rounds_per_pr.length) : null }, round_wall_s: dist(g.round_wall_s), event_driven: g.awareness_s.length > 0 }));
  const all = [...by.values()], aw = all.flatMap((g) => g.awareness_s), rp = all.flatMap((g) => g.rounds_per_pr), rw = all.flatMap((g) => g.round_wall_s);
  return { total: { lanes: all.reduce((n, g) => n + g.lanes, 0), awareness_s: dist(aw), rounds_per_pr: { ...dist(rp), mean: rp.length ? round1(rp.reduce((a, b) => a + b, 0) / rp.length) : null }, round_wall_s: dist(rw) }, versions };
}

/** Parse the `*.jsonl` run logs of `dir` (optionally only this repo's `<owner>__<repo>__<issue>.jsonl`); unreadable files are skipped. */
export function readCiLogs(dir = runsDir(), repo = null) {
  if (!existsSync(dir)) return [];
  const slug = repo ? `${repo.replace("/", "__")}__` : null;
  return readdirSync(dir).sort().filter((f) => f.endsWith(".jsonl") && (!slug || f.startsWith(slug))).flatMap((f) => {
    try { return [readFileSync(join(dir, f), "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } })]; } catch { return []; }
  });
}

const fmt = (d, u = "s") => (d.n ? `median ${d.median}${u}, p90 ${d.p90}${u} (n=${d.n})` : "no data");
export function renderCiAwareness(r) {
  const row = (x, label) => [`${label}${x.lanes != null ? ` (${x.lanes} lanes)` : ""}`, `  awareness latency: ${fmt(x.awareness_s)}`, `  CI rounds per PR: ${x.rounds_per_pr.n ? `median ${x.rounds_per_pr.median}, mean ${x.rounds_per_pr.mean}, p90 ${x.rounds_per_pr.p90} (n=${x.rounds_per_pr.n})` : "no data"}`, `  wall per round: ${fmt(x.round_wall_s)}`].join("\n");
  return ["CI awareness (#5692)", row(r.total, "all"), ...r.versions.map((v) => row(v, `version ${v.version}${v.event_driven ? " [event-driven]" : ""}`))].join("\n");
}
