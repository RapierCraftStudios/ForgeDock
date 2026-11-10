// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forgedock stats --first-review (#5345): the clean-first-review rate. Each finished lane's `run_terminal` record carries
 * `first_review` ({state, kinds, rounds, clean, incomplete, type, surfaces}, bin/lean/selfreview.mjs firstReviewRecord).
 * Reports the rate and the review.incomplete share overall and per repo, change type and risk surface, the first-round
 * finding kinds with the contract section each traces to, and the cells with a long clean record as light-lane
 * candidates. Candidacy is report-only; a lane touching a risk surface (domain:*, risk:*) is never a candidate (#5283).
 */
import { sectionOfKind } from "../lean/selfreview.mjs";

export const DEFAULT_FIRST_REVIEW_MIN_N = 20;
export const DEFAULT_CLEAN_STREAK = 20;
export const TARGET_CLEAN_RATE = 0.85;
export const TARGET_INCOMPLETE_RATE = 0.02;

const rate = (k, n) => (n ? Math.round((k / n) * 1000) / 1000 : null);
const isRisk = (surfaces) => surfaces.length > 0;

/** The first-round record of a run_terminal: the nested object, or the scalar `fr_*` fields the telemetry seam writes. */
function frOf(r) {
  if (r?.first_review && typeof r.first_review === "object") return r.first_review;
  if (r?.fr_state == null && r?.fr_clean == null) return null;
  const list = (v) => (typeof v === "string" && v !== "none" ? v.split(",").filter(Boolean) : []);
  return { state: r.fr_state, kinds: list(r.fr_kinds), rounds: r.fr_rounds, clean: Number(r.fr_clean) === 1, incomplete: Number(r.fr_incomplete) === 1, type: r.fr_type, surfaces: list(r.fr_surfaces) };
}

/** The latest first_review per issue (later run_terminal wins), oldest first. */
export function firstReviewLanes(records = [], repo = null) {
  const byIssue = new Map();
  for (const r of records) {
    const f = r?.event === "run_terminal" ? frOf(r) : null;
    if (!f || typeof f !== "object" || r.issue == null) continue;
    const cur = byIssue.get(r.issue);
    if (!cur || String(r.ts ?? "") >= String(cur.ts ?? "")) byIssue.set(r.issue, { issue: r.issue, ts: String(r.ts ?? ""), repo: r.repo ?? repo, merged: r.reason === "merged", state: f.state, kinds: Array.isArray(f.kinds) ? f.kinds : [], rounds: Number(f.rounds) || 1, clean: f.clean === true, incomplete: f.incomplete === true, type: f.type ?? "other", surfaces: Array.isArray(f.surfaces) ? f.surfaces : [] });
  }
  return [...byIssue.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.issue - b.issue);
}

function cellOf(lanes, { streak, minN }) {
  const n = lanes.length, clean = lanes.filter((l) => l.clean).length, incomplete = lanes.filter((l) => l.incomplete).length;
  const tail = lanes.slice(-streak);
  const safe = lanes.filter((l) => !isRisk(l.surfaces));
  const run = safe.slice(-streak);
  return { n, clean, clean_rate: rate(clean, n), incomplete, incomplete_rate: rate(incomplete, n), enough: n >= minN,
    light_candidate: safe.length === n && n >= minN && tail.length >= streak && tail.every((l) => l.clean) && run.length >= streak };
}

export function firstReviewReport({ records = [], repo = null, minN = DEFAULT_FIRST_REVIEW_MIN_N, streak = DEFAULT_CLEAN_STREAK } = {}) {
  const lanes = firstReviewLanes(records, repo);
  const opt = { streak, minN };
  const group = (keys) => {
    const m = new Map();
    for (const l of lanes) for (const k of keys(l)) { if (!m.has(k)) m.set(k, []); m.get(k).push(l); }
    return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, cellOf(v, opt)]));
  };
  const kinds = {}, sections = {};
  for (const l of lanes) for (const k of l.kinds) { kinds[k] = (kinds[k] ?? 0) + 1; const s = sectionOfKind(k); sections[s] = (sections[s] ?? 0) + 1; }
  const overall = cellOf(lanes, opt);
  const norm = (c) => ({ ...c, light_candidate: false }); // risk surfaces always keep the full independent review
  const bySurface = Object.fromEntries(Object.entries(group((l) => (l.surfaces.length ? l.surfaces : ["none"]))).map(([k, c]) => [k, k === "none" ? c : norm(c)]));
  return { repo, lanes: lanes.length, overall: { ...overall, light_candidate: false }, targets: { clean_rate: TARGET_CLEAN_RATE, incomplete_rate: TARGET_INCOMPLETE_RATE },
    met: overall.n ? overall.clean_rate >= TARGET_CLEAN_RATE && overall.incomplete_rate <= TARGET_INCOMPLETE_RATE : null,
    by_repo: group((l) => [l.repo ?? "unknown"]), by_type: group((l) => [l.type]), by_surface: bySurface,
    first_round_kinds: kinds, finding_sections: sections, rounds: { one: lanes.filter((l) => l.rounds <= 1).length, two: lanes.filter((l) => l.rounds === 2).length, more: lanes.filter((l) => l.rounds > 2).length } };
}

const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
export function renderFirstReview(r) {
  if (!r.lanes) return `clean-first-review, ${r.repo ?? "?"}: no lanes with a first_review record yet (recorded by lanes on a release that carries #5345)`;
  const o = r.overall, line = (k, c) => `  ${k.padEnd(28)} n=${String(c.n).padStart(4)}  clean ${pct(c.clean_rate).padStart(6)}  incomplete ${pct(c.incomplete_rate).padStart(6)}${c.light_candidate ? "  light-lane candidate" : ""}`;
  const out = [`clean-first-review, ${r.repo ?? "?"}: ${pct(o.clean_rate)} of ${o.n} lanes (target >= ${pct(r.targets.clean_rate)}), review.incomplete ${pct(o.incomplete_rate)} (target <= ${pct(r.targets.incomplete_rate)}): ${r.met ? "met" : "not met"}`,
    `rounds: one ${r.rounds.one}, two ${r.rounds.two}, three or more ${r.rounds.more}`];
  for (const [title, cells] of [["by repo", r.by_repo], ["by change type", r.by_type], ["by risk surface (always full review)", r.by_surface]]) out.push(title, ...Object.entries(cells).map(([k, c]) => line(k, c)));
  out.push("first-round finding kinds", ...Object.entries(r.first_round_kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k.padEnd(34)} ${n}  (contract section: ${sectionOfKind(k)})`));
  return out.join("\n");
}
