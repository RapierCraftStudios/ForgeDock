// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4165: deterministic audit queries over FORGE:TELEMETRY records, so `/audit` answers "which PRs added A→B?" and
 * "what is the conformance verdict mix for milestone M?" from structured events instead of comment archaeology.
 * Inputs are the records and issue metadata `fetchGithubRecords` already returns; no extra API call, no model.
 *   structure_delta (lean, merge-time): deps_added / new_edges / removed_edges as "from:to" comma lists, pr, milestone
 *   run_terminal: reason, pr, milestone, conformance_mode, shadow_would
 */

const list = (v) => (typeof v === "string" && v !== "none" ? v.split(",").filter(Boolean) : []);
const day = (ts) => (typeof ts === "string" ? ts.slice(0, 10) : "unknown");

/** "from:to" -> {from, to}; package names hold no ":" so the last ":" splits (a scoped name keeps its "/"). */
export function parseEdge(s) {
  const i = String(s ?? "").lastIndexOf(":");
  if (i <= 0 || i === String(s).length - 1) return null;
  return { from: String(s).slice(0, i), to: String(s).slice(i + 1) };
}

/**
 * Milestone of a record: its issue's milestone from the crawled metadata (the exact title), else the record's own field
 * (the emitter replaces characters outside [A-Za-z0-9 _.:/#@+=,-] with "_", so it may differ from the title).
 */
function milestoneOf(r, byIssue) {
  return byIssue.get(r.issue)?.milestone ?? (typeof r.milestone === "string" && r.milestone ? r.milestone : null);
}

/**
 * PRs (and issues) whose merged change added the edge from→to: `kind` "package" (a package.json dependency) or
 * "import" (value imports). Oldest first; one row per issue and kind (the latest record wins).
 */
export function edgeQuery(records, from, to) {
  const key = `${from}:${to}`;
  const rows = new Map();
  for (const r of records) {
    if (r?.event !== "structure_delta") continue;
    for (const [field, kind] of [["deps_added", "package"], ["new_edges", "import"]]) {
      if (!list(r[field]).includes(key)) continue;
      const k = `${r.issue}\u0000${kind}`;
      const prev = rows.get(k);
      if (!prev || String(r.ts ?? "") >= String(prev.ts ?? "")) rows.set(k, { issue: r.issue ?? null, pr: r.pr ?? null, ts: r.ts ?? null, kind, milestone: r.milestone ?? null });
    }
  }
  return [...rows.values()].sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")) || (a.issue ?? 0) - (b.issue ?? 0));
}

/**
 * Conformance verdict mix of finished runs (run_terminal) and the per-day structure series (structure_delta), for one
 * milestone or, with `milestone` null, for the whole repo. `items` is the crawled issue metadata ({number, milestone}).
 */
export function verdictMix(records, items = [], milestone = null) {
  const byIssue = new Map(items.map((i) => [i.number, i]));
  const sel = (r) => milestone == null || milestoneOf(r, byIssue) === milestone;
  const terms = records.filter((r) => r?.event === "run_terminal" && sel(r));
  const count = (xs, f) => xs.reduce((m, x) => { const k = f(x); if (k != null) m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const series = new Map();
  for (const r of records) {
    if (r?.event !== "structure_delta" || r.phase !== "merge" || !sel(r)) continue;
    const d = day(r.ts);
    const s = series.get(d) ?? { date: d, merged: 0, deps_added: 0, new_edges: 0, removed_edges: 0 };
    s.merged++; s.deps_added += list(r.deps_added).length; s.new_edges += list(r.new_edges).length; s.removed_edges += list(r.removed_edges).length;
    series.set(d, s);
  }
  return {
    milestone, runs: terms.length,
    verdicts: count(terms, (r) => (typeof r.shadow_would === "string" ? r.shadow_would : null)),
    modes: count(terms, (r) => (typeof r.conformance_mode === "string" ? r.conformance_mode : null)),
    reasons: count(terms, (r) => (typeof r.reason === "string" ? r.reason : null)),
    series: [...series.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * forge#4275: the context-pack A/B over local run summaries (local-source.mjs summariseLog), per lane type (rerun,
 * child, first) and mode (on, off, shadow), never one blended average. First-pass yield: merged with one plan + one
 * implement builder call and at most one review. Runs without a recorded lane type (older logs) are left out.
 */
export const CONTEXT_LANE_TYPES = Object.freeze(["rerun", "child", "first"]);
export function contextPackAb(runs) {
  const out = {};
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e4) / 1e4 : null);
  for (const lt of CONTEXT_LANE_TYPES) {
    out[lt] = {};
    for (const mode of ["on", "off", "shadow"]) {
      const rs = runs.filter((r) => r?.finished && r.contextPack?.laneType === lt && r.contextPack?.mode === mode);
      out[lt][mode] = { n: rs.length, first_pass_yield: mean(rs.map((r) => (r.firstPass ? 1 : 0))), builder_turns: mean(rs.map((r) => r.builderTurns ?? 0)),
        cache_tokens: mean(rs.map((r) => r.cacheTokens ?? 0)), cost_usd: mean(rs.map((r) => r.costUsd ?? 0)) };
    }
  }
  return out;
}

/** Markdown table for contextPackAb. */
export function renderContextAb(ab) {
  const f = (v) => (v == null ? "n/a" : String(v));
  const rows = CONTEXT_LANE_TYPES.flatMap((lt) => ["on", "off", "shadow"].map((m) => { const g = ab[lt][m]; return `| ${lt} | ${m} | ${g.n} | ${f(g.first_pass_yield)} | ${f(g.builder_turns)} | ${f(g.cache_tokens)} | ${f(g.cost_usd)} |`; }));
  return `| Lane type | Mode | n | First-pass yield | Builder turns | Cache tokens | Cost USD |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}`;
}
