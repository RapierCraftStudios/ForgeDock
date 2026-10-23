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
        cache_tokens: mean(rs.map((r) => r.cacheTokens ?? 0)), cost_usd: mean(rs.map((r) => r.costUsd ?? 0)), ...perMerge(rs, lt) };
    }
  }
  out.recovery = recoveryVsFirst(runs);
  return out;
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;
/**
 * #4444: per-merge A/B metrics of one cell: builder turns and cache-read over the cell's runs divided by its merges (null
 * without a merge), and rework rate: runs that were remediated, followed an earlier merge, or are a rerun lane, over n.
 */
function perMerge(rs, lt) {
  const merged = rs.filter((r) => r.reason === "merged").length;
  const sum = (f) => rs.reduce((x, r) => x + (Number.isFinite(f(r)) ? f(r) : 0), 0);
  const reworked = rs.filter((r) => r.remediated || (r.reworkedMerges?.length ?? 0) > 0 || lt === "rerun").length;
  return { merged, turns_per_merge: merged ? round4(sum((r) => r.builderTurns) / merged) : null,
    cache_read_per_merge: merged ? round4(sum((r) => r.cacheReadTokens) / merged) : null, rework_rate: rs.length ? round4(reworked / rs.length) : null };
}

/**
 * #4444 (R8): a rerun lane's implement attempt against the first run on the same issue. The baseline is the earlier
 * first/child slice of the rerun's own log (firstRunAttempt), else the earliest finished first/child run of the same
 * repo+issue in `runs`. Ratios are rerun / first per pair (a zero baseline is skipped); null without a pair.
 */
export function recoveryVsFirst(runs) {
  const key = (r) => `${String(r?.repo ?? "").toLowerCase()}#${r?.issue}`;
  const firsts = new Map();
  for (const r of [...runs].filter((x) => x?.finished && ["first", "child"].includes(x.contextPack?.laneType) && x.implementAttempt)
    .sort((a, b) => String(a.startTs ?? "").localeCompare(String(b.startTs ?? "")))) if (!firsts.has(key(r))) firsts.set(key(r), r.implementAttempt);
  const turnR = [], outR = [];
  for (const r of runs) {
    if (!r?.finished || r.contextPack?.laneType !== "rerun" || !r.implementAttempt) continue;
    const base = r.firstRunAttempt ?? firsts.get(key(r));
    if (!base) continue;
    if (base.turns > 0) turnR.push(r.implementAttempt.turns / base.turns);
    if (base.output_tokens > 0) outR.push(r.implementAttempt.output_tokens / base.output_tokens);
  }
  const mean = (xs) => (xs.length ? round4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return { pairs: Math.max(turnR.length, outR.length), mean_turn_ratio: mean(turnR), mean_output_ratio: mean(outR) };
}

/** Markdown table for contextPackAb. */
export function renderContextAb(ab) {
  const f = (v) => (v == null ? "n/a" : String(v));
  const rows = CONTEXT_LANE_TYPES.flatMap((lt) => ["on", "off", "shadow"].map((m) => { const g = ab[lt][m]; return `| ${lt} | ${m} | ${g.n} | ${f(g.first_pass_yield)} | ${f(g.builder_turns)} | ${f(g.cache_tokens)} | ${f(g.cost_usd)} | ${f(g.merged)} | ${f(g.turns_per_merge)} | ${f(g.cache_read_per_merge)} | ${f(g.rework_rate)} |`; }));
  const rc = ab.recovery; // #4444: R8, rerun implement attempt vs the first run on the same issue
  const rec = rc ? `\n\nRecovery vs first run (same issue): ${rc.pairs} pair(s), implement turns ratio ${f(rc.mean_turn_ratio)}, output tokens ratio ${f(rc.mean_output_ratio)}` : "";
  return `| Lane type | Mode | n | First-pass yield | Builder turns | Cache tokens | Cost USD | Merged | Turns/merge | Cache-read/merge | Rework rate |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}${rec}`;
}

/**
 * forge#4394: builder model tiers over local run summaries (local-source.mjs summariseLog): tier mid, mid->top
 * (escalated) or top, each with its routing class. merge_rate: merged / finished. conformance_rate: of the lanes that
 * reached review, those with no conformance/review fix round and no shadow would-block. post_merge_rework_rate: merges
 * reworked later (a later run of the same issue, or a remediate phase) / merges, where a log's earlier merged runs count
 * as merges too. Runs without a route (older logs, refactor:split) are counted under `unrouted` only.
 */
export const BUILDER_TIERS = Object.freeze(["mid", "mid->top", "top"]);
export function builderTierReport(runs) {
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e4) / 1e4 : null);
  const rate = (k, n) => (n ? Math.round((k / n) * 1e4) / 1e4 : null);
  const tierOf = (rt) => (rt?.tier === "mid" ? (rt.escalated ? "mid->top" : "mid") : rt?.tier === "top" ? "top" : null);
  const groups = new Map();
  const group = (tier, cls) => {
    const k = `${tier}\u0000${cls}`;
    if (!groups.has(k)) groups.set(k, { tier, class: cls, n: 0, merged: 0, reviewed: 0, conforming: 0, merges: 0, reworked: 0, firstPass: 0, cost: [] });
    return groups.get(k);
  };
  let unrouted = 0;
  for (const r of runs ?? []) {
    for (const m of Array.isArray(r?.reworkedMerges) ? r.reworkedMerges : []) {
      const t = tierOf(m);
      if (t) { const g = group(t, m.class ?? "unknown"); g.merges++; g.reworked++; }
    }
    if (!r?.finished) continue;
    const t = tierOf(r.builderRoute);
    if (!t) { unrouted++; continue; }
    const g = group(t, r.builderRoute.class ?? "unknown");
    g.n++;
    g.cost.push(Number.isFinite(r.costUsd) ? r.costUsd : 0);
    if (r.firstPass) g.firstPass++;
    if (r.reason === "merged") { g.merged++; g.merges++; if (r.remediated) g.reworked++; }
    if (r.reachedReview) { g.reviewed++; if (!r.conformanceRound && (r.shadowWould == null || r.shadowWould === "conforms")) g.conforming++; }
  }
  const rows = [...groups.values()]
    .sort((a, b) => BUILDER_TIERS.indexOf(a.tier) - BUILDER_TIERS.indexOf(b.tier) || a.class.localeCompare(b.class))
    .map((g) => ({ tier: g.tier, class: g.class, n: g.n, merge_rate: rate(g.merged, g.n), conformance_rate: rate(g.conforming, g.reviewed), reviewed: g.reviewed,
      post_merge_rework_rate: rate(g.reworked, g.merges), merges: g.merges, first_pass_yield: rate(g.firstPass, g.n), cost_usd: mean(g.cost) }));
  return { rows, unrouted };
}

/** Markdown table for builderTierReport. */
export function renderTiers(rep) {
  const f = (v) => (v == null ? "n/a" : String(v));
  const rows = (rep?.rows ?? []).map((g) => `| ${g.tier} | ${g.class} | ${g.n} | ${f(g.merge_rate)} | ${f(g.conformance_rate)} (${g.reviewed}) | ${f(g.post_merge_rework_rate)} (${g.merges}) | ${f(g.first_pass_yield)} | ${f(g.cost_usd)} |`);
  return `| Tier | Class | n | Merge rate | Conformance rate (reviewed) | Post-merge rework (merges) | First-pass yield | Cost USD |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.length ? rows.join("\n") : "| none | | 0 | | | | | |"}\n\n${rep?.unrouted ?? 0} finished run(s) without a builder route (before #4394) left out.`;
}

/**
 * forge#4418: the explorer A/B (#4391) over per-slice run summaries (local-source.mjs readLocalLaneRuns), per size bucket
 * (RUN_TERMINAL turns.size, set before the build) and RUN_TERMINAL `explore` mode. builder_turns / builder_cache_read:
 * means over the plan + build calls. merge_rate: merged / n. conformance_rate: as builderTierReport. `paired` keeps only
 * issues with a finished run in both modes. Untagged runs (before #4391) are counted, never folded into `off`.
 */
export const EXPLORE_SIZES = Object.freeze(["S", "M", "L", "unsized"]);
const EXPLORE_MODES = ["on", "off"];
export function exploreAb(runs) {
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e4) / 1e4 : null);
  const rate = (k, n) => (n ? Math.round((k / n) * 1e4) / 1e4 : null);
  const finished = (runs ?? []).filter((r) => r?.finished);
  const tagged = finished.filter((r) => EXPLORE_MODES.includes(r.explore));
  const stats = (rs) => {
    const reviewed = rs.filter((r) => r.reachedReview);
    const conforming = reviewed.filter((r) => !r.conformanceRound && (r.shadowWould == null || r.shadowWould === "conforms"));
    return { n: rs.length, builder_turns: mean(rs.map((r) => r.builderTurns ?? 0)), builder_cache_read: mean(rs.map((r) => r.builderCacheRead ?? 0)),
      merge_rate: rate(rs.filter((r) => r.reason === "merged").length, rs.length), conformance_rate: rate(conforming.length, reviewed.length), reviewed: reviewed.length };
  };
  const bySize = {};
  for (const size of EXPLORE_SIZES) {
    bySize[size] = {};
    for (const mode of EXPLORE_MODES) bySize[size][mode] = stats(tagged.filter((r) => (EXPLORE_SIZES.includes(r.size) ? r.size : "unsized") === size && r.explore === mode));
  }
  const key = (r) => `${r.repo ?? ""}#${r.issue}`;
  const both = new Set(tagged.filter((r) => r.explore === "on").map(key).filter((k) => tagged.some((r) => r.explore === "off" && key(r) === k)));
  const pairedRuns = tagged.filter((r) => both.has(key(r)));
  const paired = { issues: both.size };
  for (const mode of EXPLORE_MODES) paired[mode] = stats(pairedRuns.filter((r) => r.explore === mode));
  return { by_size: bySize, paired, untagged: finished.length - tagged.length };
}

/** Markdown tables for exploreAb. */
export function renderExploreAb(ab) {
  const f = (v) => (v == null ? "n/a" : String(v));
  const row = (label, mode, g) => `| ${label} | ${mode} | ${g.n} | ${f(g.builder_turns)} | ${f(g.builder_cache_read)} | ${f(g.merge_rate)} | ${f(g.conformance_rate)} (${g.reviewed}) |`;
  const head = "| Size | Explore | n | Builder turns | Builder cache-read | Merge rate | Conformance rate (reviewed) |\n| --- | --- | --- | --- | --- | --- | --- |";
  const sizes = EXPLORE_SIZES.flatMap((s) => EXPLORE_MODES.map((m) => row(s, m, ab.by_size[s][m])));
  const paired = EXPLORE_MODES.map((m) => row("paired", m, ab.paired[m]));
  return `${head}\n${sizes.join("\n")}\n\nSame issues in both modes: ${ab.paired.issues}\n\n${head}\n${paired.join("\n")}\n\n${ab.untagged} finished run(s) without an explore tag (before #4391) left out.`;
}

/**
 * forge#4436: the #4395 lane baseline before/after, over local run summaries (every RUN_START slice). Finished runs,
 * optionally pinned to an issue set, grouped by lane profile (null → unknown). Per profile and phase: fresh-session
 * first-turn baseline_tokens (sessions, median, mean). Per profile: conformance_rate (the builderTierReport rule) and
 * shadow_blocks (reviewed runs with a would-block verdict). issues_in_all: issues with a finished run under every profile.
 */
export const LANE_PROFILES = Object.freeze(["full", "memory-off", "lane", "mixed", "unknown"]);
export function laneProfileReport(runs, { issues = null } = {}) {
  const pin = Array.isArray(issues) && issues.length ? new Set(issues) : null;
  const rate = (k, n) => (n ? Math.round((k / n) * 1e4) / 1e4 : null);
  const groups = new Map();
  for (const r of runs ?? []) {
    if (!r?.finished || (pin && !pin.has(r.issue))) continue;
    const name = typeof r.laneProfile === "string" && r.laneProfile ? r.laneProfile : "unknown";
    const g = groups.get(name) ?? { profile: name, n: 0, issues: new Set(), reviewed: 0, conforming: 0, shadow_blocks: 0, phases: {} };
    groups.set(name, g);
    g.n++;
    if (r.issue != null) g.issues.add(r.issue);
    if (r.reachedReview) {
      g.reviewed++;
      if (!r.conformanceRound && (r.shadowWould == null || r.shadowWould === "conforms")) g.conforming++;
      if (typeof r.shadowWould === "string" && r.shadowWould !== "conforms") g.shadow_blocks++;
    }
    for (const [phase, xs] of Object.entries(r.baselines ?? {})) (g.phases[phase] ??= []).push(...xs.filter(Number.isFinite));
  }
  const stat = (xs) => {
    if (!xs.length) return { median: null, mean: null };
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return { median: Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2), mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
  };
  const rank = (p) => { const i = LANE_PROFILES.indexOf(p); return i < 0 ? LANE_PROFILES.length : i; };
  const profiles = [...groups.values()].sort((a, b) => rank(a.profile) - rank(b.profile) || a.profile.localeCompare(b.profile))
    .map((g) => ({ profile: g.profile, n: g.n, issues: [...g.issues].sort((a, b) => a - b), reviewed: g.reviewed, conformance_rate: rate(g.conforming, g.reviewed),
      shadow_blocks: g.shadow_blocks, phases: Object.keys(g.phases).sort().map((phase) => ({ phase, sessions: g.phases[phase].length, ...stat(g.phases[phase]) })) }));
  const issuesInAll = profiles.length ? profiles[0].issues.filter((i) => profiles.every((p) => p.issues.includes(i))) : [];
  return { profiles, issues_in_all: issuesInAll };
}

/** Markdown tables for laneProfileReport. */
export function renderLaneProfiles(rep) {
  const f = (v) => (v == null ? "n/a" : String(v));
  const ps = rep?.profiles ?? [];
  const base = ps.flatMap((p) => (p.phases.length ? p.phases : [{ phase: "n/a", sessions: 0, median: null, mean: null }])
    .map((x) => `| ${p.profile} | ${x.phase} | ${x.sessions} | ${f(x.median)} | ${f(x.mean)} |`));
  const conf = ps.map((p) => `| ${p.profile} | ${p.n} | ${f(p.conformance_rate)} (${p.reviewed}) | ${p.shadow_blocks} |`);
  return `| Profile | Phase | Sessions | Median baseline | Mean baseline |\n| --- | --- | --- | --- | --- |\n${base.length ? base.join("\n") : "| none | | 0 | | |"}\n\n`
    + `| Profile | Runs | Conformance rate (reviewed) | Shadow would-block |\n| --- | --- | --- | --- |\n${conf.length ? conf.join("\n") : "| none | 0 | | |"}\n\n`
    + `Issues with a finished run under every profile: ${rep?.issues_in_all?.length ? rep.issues_in_all.map((i) => `#${i}`).join(", ") : "none"}`;
}
