// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4402: batch efficiency and accuracy metrics, per batch and over trailing windows. No model, no clock (`now` is
 * passed in), no network except the injected `gh` for merged issues' bodies, labels and FORGE:PROBE comments.
 *
 * Sources: the batch dirs (`~/.forge/batches/<id>/`: plan.json, report.json rows, log.jsonl settle times) and the run
 * logs (`~/.forge/runs/<issue>.jsonl`). Batch membership exists only locally, and GitHub `phase_attempt` records keep one
 * run per issue, so lane reruns would be lost there.
 *
 * Cohort: a batch's rows. A merged issue's metrics cover every RUN_START..RUN_TERMINAL slice of its run log that started
 * at or before its settle time (the latest log.jsonl row for it), including earlier batches and ad-hoc runs: the cost to
 * merge. Attempt cost is `cost_usd_delta`, else `cost_usd` (#4407; logs before the delta overstate resumed sessions).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { citesFileLine } from "../lean/fixround.mjs";
import { laneSize, SIZES } from "../lean/budget.mjs";
import { probeResultOf } from "../lean/probe.mjs";
import { listBatches } from "../lean/batch.mjs";
import { isTrustedComment } from "../engine/phases.mjs";
import { noComments } from "../lean/render.mjs";
import { readLog, runLogPath } from "../engine/runlog.mjs";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const RETRY_CAUSES = Object.freeze(["env", "engine", "code", "review", "unknown"]);

/** Builder (implement) attempt trigger -> retry cause; null = not a retry. Every fixround.mjs TRIGGERS entry is listed. */
export const TRIGGER_CAUSE = Object.freeze({
  plan: null, build: null, verifier: null,
  ci_unavailable: "env",
  timeout_restart: "engine", context_restart: "engine", budget_wrapup: "engine", recovery: "engine",
  precheck: "code", structure: "code", docs: "code", enumerating: "code", sequence: "code", post_merge: "code", duplicate: "code", ci_red: "code", conformance: "code",
  merge_ci: "code", block_correction: "code", contract_correction: "code",
  review: "review",
});

const CODE_CAUSE = [[/^env\./, "env"], [/^(engine|run|followup|base|dependency)\./, "engine"],
  [/^(ci|conformance|precheck|budget|builder|contract)\./, "code"], [/^review\./, "review"]];
/** A lane rerun's cause from the RUN_TERMINAL code of the slice it replaced. */
export function codeCause(code) {
  const c = String(code ?? "");
  for (const [re, cause] of CODE_CAUSE) if (re.test(c)) return cause;
  return "unknown";
}

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const costOf = (e) => num(e.cost_usd_delta) ?? num(e.cost_usd);
const sum = (xs) => xs.reduce((a, b) => a + (num(b) ?? 0), 0);
const r = (x, p = 1e4) => (num(x) == null ? null : Math.round(x * p) / p);
const per = (a, b) => (b > 0 ? a / b : null);
/** #4491: GitHub slugs are case-insensitive (`--repo o/forgedock` matches a plan's `O/ForgeDock`). */
export const sameRepo = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

function parseLog(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === "object") out.push(e); } catch { /* torn line */ }
  }
  return out;
}

export const LANE_SHAPES = Object.freeze(["light", "upgraded", "full"]);

/** Every RUN_START..RUN_TERMINAL slice of one run log (all of them, not only the last). `shape` (#4452): light (LIGHT_DONE), upgraded (LIGHT_UPGRADE) or full. */
export function issueSlices(events) {
  const out = [];
  let cur = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") continue;
    if (e.event === "RUN_START") { cur = { startTs: e.ts ?? null, repo: e.repo ?? null, terminal: null, shape: "full", conformance: null, attempts: [] }; out.push(cur); continue; }
    if (!cur) continue;
    if (e.event === "LIGHT_DONE") cur.shape = "light";
    else if (e.event === "CONFORMANCE" && typeof e.state === "string") cur.conformance = e.state; // #4491: the slice's last verdict
    else if (e.event === "LIGHT_UPGRADE") cur.shape = "upgraded";
    if (e.event === "PHASE_ATTEMPT_USAGE") {
      cur.attempts.push({ phase: e.phase ?? "other", trigger: e.trigger ?? null, restart_of: e.restart_of ?? null, model: e.model ?? null,
        turns: num(e.turns), cacheRead: num(e.usage?.cache_read_input_tokens), cost: costOf(e), durationMs: num(e.duration_ms), // #4491
        ...(e.tools && typeof e.tools === "object" ? { calls: num(e.tools.calls), toolTurns: num(e.tools.turns), rereads: num(e.tools.rereads) } : {}) }); // #4410
    } else if (e.event === "RUN_TERMINAL") {
      cur.terminal = { reason: e.reason ?? null, code: e.code ?? null, ts: e.ts ?? null, size: SIZES.includes(e.turns?.size) ? e.turns.size : null };
    }
  }
  return out;
}

/** Retries of one slice's builder attempts by cause. Legacy (no trigger anywhere): implement attempts beyond plan + build are unknown. */
export function sliceRetries(slice) {
  const out = Object.fromEntries(RETRY_CAUSES.map((c) => [c, 0]));
  const impl = (slice?.attempts ?? []).filter((a) => a.phase === "implement");
  if (impl.length && impl.every((a) => !a.trigger)) { out.unknown += Math.max(0, impl.length - 2); return out; }
  for (const a of impl) {
    if (!a.trigger) { out.unknown++; continue; }
    const c = Object.hasOwn(TRIGGER_CAUSE, a.trigger) ? TRIGGER_CAUSE[a.trigger] : "unknown";
    if (c) out[c]++;
  }
  return out;
}

const HEAD_RE = /^[ \t]{0,3}(?:#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$|\*\*([^*\n]+)\*\*)/gm;
/** Issue-quality tag from the body: root cause, file:line and fix design present (full), some (partial) or none. */
export function issueQuality(body) {
  const t = noComments(body);
  const heads = [...t.matchAll(HEAD_RE)].map((m) => m[1] ?? m[2] ?? "");
  const rootCause = heads.some((h) => /root cause/i.test(h));
  const fileLine = citesFileLine([t]);
  const fixDesign = heads.some((h) => /fix|design|approach|proposal/i.test(h));
  const k = [rootCause, fileLine, fixDesign].filter(Boolean).length;
  return { rootCause, fileLine, fixDesign, tag: k === 3 ? "full" : k ? "partial" : "none" };
}

/** pass | fail | pending | unprobed: trusted FORGE:PROBE records within 7 days of the first one (promotion, #4399). */
export function acceptanceOf(comments, now) {
  const recs = (Array.isArray(comments) ? comments : []).filter((c) => isTrustedComment(c))
    .map((c) => ({ t: Date.parse(c.created_at ?? ""), res: probeResultOf(c.body) })).filter((x) => x.res && Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  if (!recs.length) return "unprobed";
  const t0 = recs[0].t;
  if (now - t0 < WEEK_MS) return "pending";
  return recs.filter((x) => x.t <= t0 + WEEK_MS).every((x) => x.res.result === "pass") ? "pass" : "fail";
}

/** Issue body, labels and comments over the injected gh (the calls of bin/lean/probe.mjs readIssue). */
export async function fetchIssue(gh, repo, n) {
  const iss = JSON.parse(String(await gh(["api", `repos/${repo}/issues/${n}`])));
  const raw = String(await gh(["api", `repos/${repo}/issues/${n}/comments`, "--paginate", "--jq", ".[]"]));
  const comments = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return { body: iss?.body ?? "", labels: (Array.isArray(iss?.labels) ? iss.labels : []).map((l) => l?.name ?? l), comments };
}

/** #4410: a lane's implement tool calls per turn and re-reads, over the attempts that carry tool data; null when none. */
function laneTools(impl) {
  const xs = impl.filter((a) => a.calls != null && a.toolTurns > 0);
  if (!xs.length) return null;
  return { per_turn: r(sum(xs.map((a) => a.calls)) / sum(xs.map((a) => a.toolTurns)), 100), rereads: sum(xs.map((a) => a.rereads ?? 0)) };
}
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : r((s[h - 1] + s[h]) / 2, 100);
};

/** #4491: a lane's implement wall in minutes, the sum of its implement attempts' duration_ms; null when none carries it. */
function laneWall(impl) {
  const xs = impl.filter((a) => a.durationMs != null);
  return xs.length ? r(sum(xs.map((a) => a.durationMs)) / 60000, 100) : null;
}
const wallP50 = (xs) => median(xs.map((x) => x.implWall).filter((w) => w != null));

const group = (xs) => {
  const turns = sum(xs.map((x) => x.implTurns)), cache = sum(xs.map((x) => x.implCache));
  return { n: xs.length, cost_usd: r(sum(xs.map((x) => x.cost)), 1e6), usd_per_merge: r(per(sum(xs.map((x) => x.cost)), xs.length)),
    turns_per_merge: r(per(turns, xs.length), 10), context_per_turn: r(per(cache, turns), 1), implement_wall_p50_min: wallP50(xs) };
};

/**
 * The metrics of one cohort. `entries`: [{row, settleAt}] (a batch row and its settle time, ISO or null = unbounded);
 * `logs`: issue -> run-log events; `issues`: issue -> {body, labels, comments} or null when gh was not available.
 */
export function efficiencyMetrics({ entries = [], logs = new Map(), issues = null, repo = null, now = 0, notes = [] } = {}) {
  const merged = [];
  const inScope = (row, settleAt) => issueSlices(logs.get(row.issue) ?? []).filter((s) => (!repo || !s.repo || sameRepo(s.repo, repo)) && (!settleAt || !s.startTs || s.startTs <= settleAt));
  // #4452: light/full split and upgrade rate over every lane of every row (all outcomes); cost is the #4407 delta sum
  const shapes = Object.fromEntries(LANE_SHAPES.map((k) => [k, { n: 0, cost_usd: 0 }]));
  for (const { row, settleAt } of entries) {
    if (!Number.isSafeInteger(row?.issue)) continue;
    for (const s of inScope(row, settleAt)) { const g = shapes[s.shape] ?? shapes.full; g.n++; g.cost_usd += sum(s.attempts.map((a) => a.cost)); }
  }
  for (const g of Object.values(shapes)) g.cost_usd = r(g.cost_usd, 1e6);
  const lanes = { ...shapes, upgrade_rate: r(per(shapes.upgraded.n, shapes.light.n + shapes.upgraded.n)) };
  for (const { row, settleAt } of entries) {
    if (row?.outcome !== "merged") continue;
    const slices = inScope(row, settleAt);
    const atts = slices.flatMap((s) => s.attempts), impl = atts.filter((a) => a.phase === "implement");
    const retries = Object.fromEntries(RETRY_CAUSES.map((c) => [c, 0]));
    for (const s of slices) for (const [c, k] of Object.entries(sliceRetries(s))) retries[c] += k;
    for (const s of slices.slice(0, -1)) retries[codeCause(s.terminal?.code)]++; // lane reruns
    const info = issues?.get(row.issue) ?? null;
    const term = [...slices].reverse().find((s) => s.terminal?.reason === "merged")?.terminal;
    merged.push({ issue: row.issue, slices: slices.length, cost: sum(atts.map((a) => a.cost)), implCost: sum(impl.map((a) => a.cost)),
      reviewCost: sum(atts.filter((a) => a.phase === "review").map((a) => a.cost)), implTurns: sum(impl.map((a) => a.turns)), implCache: sum(impl.map((a) => a.cacheRead)),
      size: term?.size ?? laneSize({ labels: info?.labels ?? [] }) ?? "unknown", impl, retries, info, tools: laneTools(impl), shape: slices.at(-1)?.shape ?? null, implWall: laneWall(impl) });
  }
  const all = group(merged);
  const bySize = {};
  for (const s of [...SIZES, "unknown"]) { const xs = merged.filter((m) => m.size === s); if (xs.length) bySize[s] = group(xs); }
  const byModel = {};
  for (const m of merged) {
    for (const a of m.impl) {
      const k = a.model ?? "unknown", g = (byModel[k] ??= { merges: new Set(), attempts: 0, turns: 0, cache: 0, cost: 0 });
      g.merges.add(m.issue); g.attempts++; g.turns += a.turns ?? 0; g.cache += a.cacheRead ?? 0; g.cost += a.cost ?? 0;
    }
  }
  const retries = Object.fromEntries(RETRY_CAUSES.map((c) => [c, sum(merged.map((m) => m.retries[c]))]));
  // #4491: merge rate over the rows, conformance pass rate over rows whose lanes logged a verdict (each row's last one)
  const rows = entries.filter(({ row }) => Number.isSafeInteger(row?.issue));
  const verdicts = rows.map(({ row, settleAt }) => inScope(row, settleAt).map((s) => s.conformance).filter(Boolean).at(-1)).filter(Boolean);
  const withTools = merged.filter((m) => m.tools);
  const total = sum(Object.values(retries));
  // no possible action: parked post-deploy follow-ups and promotion-blocked lanes (#4389), over all rows
  const noAction = {};
  for (const { row } of entries) {
    const kind = row?.prefilter?.parked ? String(row.prefilter.kind ?? "parked")
      : row?.code === "builder.blocked" && /^Builder is blocked \(promotion\)/.test(String(row.detail ?? "")) ? "blocked-promotion" : null;
    if (!kind) continue;
    const g = (noAction[kind] ??= { n: 0, cost_usd: 0, issues: [] });
    g.n++; g.cost_usd += num(row.cost_usd) ?? 0; g.issues.push(row.issue);
  }
  let quality = null, acceptance = null;
  if (issues) {
    quality = {};
    for (const t of ["full", "partial", "none"]) {
      const xs = merged.filter((m) => m.info && issueQuality(m.info.body).tag === t);
      quality[t] = group(xs);
    }
    acceptance = { pass: 0, fail: 0, pending: 0, unprobed: 0 };
    acceptance.unprobed_issues = []; // #4908: which merged issues declare no outcome probe
    for (const m of merged) if (m.info) { const k = acceptanceOf(m.info.comments, now); acceptance[k]++; if (k === "unprobed") acceptance.unprobed_issues.push(m.issue); }
    acceptance.probed = acceptance.pass + acceptance.fail + acceptance.pending;
    acceptance.pass_rate = r(per(acceptance.pass, acceptance.pass + acceptance.fail));
  }
  return {
    merged: merged.length, cost_usd: all.cost_usd, implement_usd: r(sum(merged.map((m) => m.implCost)), 1e6), review_usd: r(sum(merged.map((m) => m.reviewCost)), 1e6),
    usd_per_merge: all.usd_per_merge, turns_per_merge: all.turns_per_merge, context_per_turn: all.context_per_turn,
    implement_turns: sum(merged.map((m) => m.implTurns)), implement_cache_read: sum(merged.map((m) => m.implCache)),
    implement_wall_p50_min: all.implement_wall_p50_min, merge_rate: r(per(merged.length, rows.length)),
    conformance_pass_rate: r(per(verdicts.filter((v) => v === "conforms").length, verdicts.length)),
    by_size: bySize,
    by_model: Object.fromEntries(Object.entries(byModel).map(([k, g]) => [k, { merges: g.merges.size, attempts: g.attempts, turns: g.turns, cost_usd: r(g.cost, 1e6),
      usd_per_merge: r(per(g.cost, g.merges.size)), turns_per_merge: r(per(g.turns, g.merges.size), 10), context_per_turn: r(per(g.cache, g.turns), 1) }])),
    retries: { total, per_merge: r(per(total, merged.length), 100), by_cause: retries, lane_reruns: sum(merged.map((m) => Math.max(0, m.slices - 1))) },
    no_action: { lanes: sum(Object.values(noAction).map((g) => g.n)), cost_usd: r(sum(Object.values(noAction).map((g) => g.cost_usd)), 1e6),
      by_kind: Object.fromEntries(Object.entries(noAction).map(([k, g]) => [k, { ...g, cost_usd: r(g.cost_usd, 1e6) }])) },
    quality, acceptance, lanes,
    tool_calls_per_turn_p50: median(withTools.map((m) => m.tools.per_turn)), rereads_per_merge: withTools.length ? r(per(sum(withTools.map((m) => m.tools.rereads)), withTools.length), 100) : null,
    per_issue: merged.map((m) => ({ issue: m.issue, slices: m.slices, cost_usd: r(m.cost, 1e6), implement_usd: r(m.implCost, 1e6), implement_turns: m.implTurns,
      implement_cache_read: m.implCache, size: m.size, retries: m.retries, ...(m.shape ? { shape: m.shape } : {}), ...(m.info ? { quality: issueQuality(m.info.body).tag } : {}),
      ...(m.tools ? { implement_tool_calls_per_turn: m.tools.per_turn, implement_rereads: m.tools.rereads } : {}),
      ...(m.implWall != null ? { implement_wall_min: m.implWall } : {}) })),
    notes,
  };
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
/** #4432: the repo's run log (legacy `<n>.jsonl` only through readLog's fallback); null repo = the legacy file. */
const readEvents = (runsDir, n, repo = null) => {
  try { return readLog(runsDir, n, { repo }); } catch { /* a corrupt line: parse the file leniently */ }
  try { return parseLog(readFileSync(runLogPath(runsDir, n, repo), "utf8")); } catch { return []; }
};
const readLogRows = (dir) => { try { return parseLog(readFileSync(join(dir, "log.jsonl"), "utf8")); } catch { return []; } };

/** report.json rows, else state.json results (object or entry list). */
function batchRows(dir) {
  const rep = readJson(join(dir, "report.json"));
  if (Array.isArray(rep?.rows)) return rep.rows;
  const res = readJson(join(dir, "state.json"))?.results;
  const vals = Array.isArray(res) ? res.map((x) => (Array.isArray(x) ? x[1] : x)) : res && typeof res === "object" ? Object.values(res) : [];
  return vals.filter((x) => x && Number.isSafeInteger(x.issue));
}

/** Latest log.jsonl `at` per issue. */
function settleTimes(logRows) {
  const at = new Map();
  for (const l of logRows) if (Number.isSafeInteger(l?.issue) && typeof l.at === "string" && l.at > (at.get(l.issue) ?? "")) at.set(l.issue, l.at);
  return at;
}

async function computeScope({ entries, runsDir, repo, gh, now }) {
  const logs = new Map(entries.map(({ row }) => [row.issue, readEvents(runsDir, row.issue, repo)]));
  const notes = [];
  let issues = null;
  const mergedIssues = [...new Set(entries.filter(({ row }) => row.outcome === "merged").map(({ row }) => row.issue))];
  if (!gh || !repo) notes.push("issue quality and acceptance: no gh/repo");
  else {
    issues = new Map();
    for (const n of mergedIssues) {
      try { issues.set(n, await fetchIssue(gh, repo, n)); } catch (e) {
        issues = null; notes.push(`issue quality and acceptance: gh failed (${String(e?.message ?? e).split("\n")[0].slice(0, 160)})`); break;
      }
    }
  }
  return efficiencyMetrics({ entries, logs, issues, repo, now, notes });
}

/** One batch. `rows`/`logRows` override the files (the batch report passes its in-memory rows). */
export async function batchEfficiency({ batchDir, runsDir, repo = null, gh = null, now = Date.now(), rows = null, logRows = null }) {
  const plan = readJson(join(batchDir, "plan.json")) ?? {};
  const rs = Array.isArray(rows) ? rows : batchRows(batchDir);
  const at = settleTimes(Array.isArray(logRows) ? logRows : readLogRows(batchDir));
  const entries = rs.filter((x) => Number.isSafeInteger(x?.issue)).map((row) => ({ row, settleAt: at.get(row.issue) ?? null }));
  return { batch: plan.id ?? null, ...(await computeScope({ entries, runsDir, repo: repo ?? plan.repo ?? null, gh, now })) };
}

/** The repo's batches by creation time, and the repo slug as the plans spell it (run-log file names are case-sensitive, #4491). */
function repoBatches(batchRoot, repo) {
  const batches = (existsSync(batchRoot) ? listBatches(batchRoot) : []).map((id) => {
    const dir = join(batchRoot, id), plan = readJson(join(dir, "plan.json")) ?? {};
    return { dir, plan, created: Date.parse(plan.created ?? "") };
  }).filter((b) => Number.isFinite(b.created) && (!repo || sameRepo(b.plan.repo, repo))).sort((a, b) => a.created - b.created);
  return { batches, repo: repo ? (batches.find((b) => typeof b.plan.repo === "string")?.plan.repo ?? repo) : repo };
}

/** Rows of the batches created in [from, to]; an issue in several batches counts once (latest row). */
function cohortEntries(batches, from, to, toInclusive = true) {
  const inside = batches.filter((b) => b.created >= from && (toInclusive ? b.created <= to : b.created < to));
  const latest = new Map();
  for (const b of inside) {
    const at = settleTimes(readLogRows(b.dir));
    for (const row of batchRows(b.dir)) if (Number.isSafeInteger(row?.issue)) latest.set(row.issue, { row, settleAt: at.get(row.issue) ?? null });
  }
  return { batches: inside.length, entries: [...latest.values()] };
}

/** Trailing windows: the union of the repo's batches created in each window; an issue in several batches counts once (latest row). */
export async function windowEfficiency({ batchRoot, runsDir, repo = null, gh = null, now = Date.now(), windows = [WEEK_MS] }) {
  const { batches, repo: slug } = repoBatches(batchRoot, repo);
  const out = {};
  for (const w of windows) {
    const c = cohortEntries(batches, now - w, now);
    out[windowLabel(w)] = { batches: c.batches, ...(await computeScope({ entries: c.entries, runsDir, repo: slug, gh, now })) };
  }
  return out;
}

export const COMPARE_KEYS = Object.freeze(["turns_per_merge", "implement_wall_p50_min", "tool_calls_per_turn_p50", "rereads_per_merge", "merge_rate", "conformance_pass_rate"]);
const delta = (a, b) => Object.fromEntries(COMPARE_KEYS.map((k) => [k, num(a?.[k]) == null || num(b?.[k]) == null ? null : r(b[k] - a[k], 100)]));

/**
 * #4491: full-shape merged lanes per size bucket present in both cohorts (light lanes, #4452, cut turns on their own).
 * A merged row with no in-scope run log carries no shape and drops out, so its zero turns do not pull a bucket down.
 */
function matchedCohorts(pre, post) {
  const full = (m) => (m.per_issue ?? []).filter((x) => x.shape === "full");
  const bySize = (xs) => xs.reduce((o, x) => ((o[x.size] ??= []).push(x), o), {});
  const a = bySize(full(pre)), b = bySize(full(post)), out = {};
  const g = (xs) => {
    const tools = xs.filter((x) => x.implement_tool_calls_per_turn != null);
    return { n: xs.length, turns_per_merge: r(per(sum(xs.map((x) => x.implement_turns)), xs.length), 10),
      implement_wall_p50_min: median(xs.map((x) => x.implement_wall_min).filter((w) => w != null)),
      tool_calls_per_turn_p50: median(tools.map((x) => x.implement_tool_calls_per_turn)),
      rereads_per_merge: tools.length ? r(per(sum(tools.map((x) => x.implement_rereads)), tools.length), 100) : null };
  };
  for (const size of Object.keys(a).sort()) {
    if (!b[size]) continue;
    const pa = g(a[size]), pb = g(b[size]);
    out[size] = { pre: pa, post: pb, delta: delta(pa, pb) };
  }
  return out;
}

/**
 * #4491: before/after A/B around a deploy `pivot` (ms): post = the repo's batches created in [pivot, min(now, pivot + span)],
 * pre = the same span ending just before the pivot. `span` defaults to the time since the pivot, so both cohorts are equally long.
 */
export async function compareEfficiency({ batchRoot, runsDir, repo = null, gh = null, pivot, now = Date.now(), span = null }) {
  if (!Number.isFinite(pivot) || pivot > now) throw new Error("compare: the pivot must be a time in the past");
  const s = Math.max(0, Math.min(Number.isFinite(span) ? span : Infinity, now - pivot));
  const { batches, repo: slug } = repoBatches(batchRoot, repo);
  const a = cohortEntries(batches, pivot - s, pivot, false), b = cohortEntries(batches, pivot, pivot + s);
  const pre = { batches: a.batches, ...(await computeScope({ entries: a.entries, runsDir, repo: slug, gh, now })) };
  const post = { batches: b.batches, ...(await computeScope({ entries: b.entries, runsDir, repo: slug, gh, now })) };
  return { pivot: new Date(pivot).toISOString(), span_days: r(s / 86400000, 100), pre, post, delta: delta(pre, post), matched: matchedCohorts(pre, post) };
}

export const windowLabel = (ms) => `${Math.round(ms / 86400000)}d`;
/** "7d,30d" -> [ms]; throws on anything else. */
export function parseWindows(s) {
  const out = String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^(\d+)d$/.exec(x);
    if (!m || Number(m[1]) < 1) throw new Error(`--window must be a comma list of Nd (e.g. 7d,30d): ${s}`);
    return Number(m[1]) * 86400000;
  });
  if (!out.length) throw new Error("--window needs at least one Nd");
  return out;
}

const f = (x, d = 2) => (num(x) == null ? "n/a" : x.toFixed(d));
const usd = (x) => (num(x) == null ? "n/a" : `$${x.toFixed(2)}`);
const int = (x) => (num(x) == null ? "n/a" : String(Math.round(x)));
const g1 = (g) => `n=${g.n} ${usd(g.usd_per_merge)}/merge turns/merge ${f(g.turns_per_merge, 1)} context/turn ${int(g.context_per_turn)}`;

/** The report lines of one scope (the batch report prints them unlabelled). */
export function formatEfficiencyLines(m, label = "") {
  const lines = [`efficiency${label ? ` (${label})` : ""}: merged ${m.merged}, ${usd(m.usd_per_merge)}/merge (implement ${usd(m.implement_usd)}, review ${usd(m.review_usd)}), turns/merge ${f(m.turns_per_merge, 1)}, context/turn ${int(m.context_per_turn)}`];
  const sizes = Object.entries(m.by_size ?? {});
  lines.push(`efficiency by size: ${sizes.length ? sizes.map(([s, g]) => `${s} ${g1(g)}`).join("; ") : "n/a"}`);
  const models = Object.entries(m.by_model ?? {});
  lines.push(`efficiency by model: ${models.length ? models.map(([k, g]) => `${k} n=${g.merges} ${usd(g.usd_per_merge)}/merge turns/merge ${f(g.turns_per_merge, 1)} context/turn ${int(g.context_per_turn)}`).join("; ") : "n/a"}`);
  const rc = m.retries?.by_cause ?? {};
  lines.push(`retries/merge ${f(m.retries?.per_merge)} (${RETRY_CAUSES.map((c) => `${c} ${rc[c] ?? 0}`).join(", ")}; lane reruns ${m.retries?.lane_reruns ?? 0})`);
  const kinds = Object.entries(m.no_action?.by_kind ?? {});
  lines.push(`no action: ${m.no_action?.lanes ?? 0} lanes, ${usd(m.no_action?.cost_usd ?? 0)}${kinds.length ? ` (${kinds.map(([k, g]) => `${k} ${g.n}`).join(", ")})` : ""}`);
  const note = (m.notes ?? []).find((x) => /^issue quality/.test(x));
  lines.push(m.quality ? `issue quality: ${["full", "partial", "none"].map((t) => `${t} ${g1(m.quality[t])}`).join("; ")}` : `issue quality: n/a${note ? ` (${note.replace(/^issue quality and acceptance: /, "")})` : ""}`);
  const a = m.acceptance;
  lines.push(a ? `acceptance (7d after promotion): pass ${a.pass}/${a.pass + a.fail}${a.pass_rate == null ? "" : ` (${Math.round(a.pass_rate * 100)}%)`}, pending ${a.pending}, unprobed ${a.unprobed}`
    : "acceptance (7d after promotion): n/a");
  if (a) lines.push(`unprobed merged issues (no acceptance probe declared): ${a.unprobed_issues?.length ? a.unprobed_issues.map((n) => `#${n}`).join(", ") : "none"}`); // #4908
  lines.push(`tools: calls/turn p50 ${f(m.tool_calls_per_turn_p50)}, re-reads (>=3x same path)/merge ${f(m.rereads_per_merge)}`); // #4410
  const ln = m.lanes; // #4452
  lines.push(ln ? `lanes: ${LANE_SHAPES.map((k) => `${k} ${ln[k]?.n ?? 0} (${usd(ln[k]?.cost_usd ?? 0)})`).join(", ")}; upgrade rate ${ln.upgrade_rate == null ? "n/a"
    : `${Math.round(ln.upgrade_rate * 100)}% (${ln.upgraded?.n ?? 0}/${(ln.light?.n ?? 0) + (ln.upgraded?.n ?? 0)})`}` : "lanes: n/a");
  lines.push(rates(m)); // #4491
  return lines;
}

const pct = (x) => (num(x) == null ? "n/a" : `${Math.round(x * 100)}%`);
const rates = (m) => `implement wall p50 ${m.implement_wall_p50_min == null ? "n/a" : `${f(m.implement_wall_p50_min, 1)} min`}, merge rate ${pct(m.merge_rate)}, conformance pass ${pct(m.conformance_pass_rate)}`;
const sign = (x, d, unit = "") => (num(x) == null ? "n/a" : `${x > 0 ? "+" : ""}${x.toFixed(d)}${unit}`);
const deltaLine = (d, withRates = true) => `turns/merge ${sign(d.turns_per_merge, 1)}, implement wall p50 ${sign(d.implement_wall_p50_min, 1, " min")}, calls/turn p50 ${sign(d.tool_calls_per_turn_p50, 2)}, `
  + `re-reads/merge ${sign(d.rereads_per_merge, 2)}${withRates ? `, merge rate ${sign(d.merge_rate == null ? null : d.merge_rate * 100, 0, " pts")}, conformance pass ${sign(d.conformance_pass_rate == null ? null : d.conformance_pass_rate * 100, 0, " pts")}` : ""}`;
const cohortLine = (k, m) => `compare ${k}: n=${m.n ?? m.merged} turns/merge ${f(m.turns_per_merge, 1)}, implement wall p50 ${m.implement_wall_p50_min == null ? "n/a" : `${f(m.implement_wall_p50_min, 1)} min`}, `
  + `calls/turn p50 ${f(m.tool_calls_per_turn_p50)}, re-reads/merge ${f(m.rereads_per_merge)}${"merge_rate" in m ? `, merge rate ${pct(m.merge_rate)}, conformance pass ${pct(m.conformance_pass_rate)}` : ""}`;

/** #4491: the `--compare` report: pre/post cohorts, their delta, then the full-shape per-size matched cohorts. */
export function formatCompareLines(c) {
  const lines = [`compare: pivot ${c.pivot}, ${f(c.span_days, 1)} days each side (pre ${c.pre.batches} batches, post ${c.post.batches} batches)`,
    cohortLine("pre", c.pre), cohortLine("post", c.post), `compare delta: ${deltaLine(c.delta)}`];
  const sizes = Object.entries(c.matched ?? {});
  if (!sizes.length) lines.push("compare matched (full lanes per size): n/a");
  for (const [size, g] of sizes) lines.push(`compare matched ${size}: pre n=${g.pre.n} post n=${g.post.n}; delta ${deltaLine(g.delta, false)}`);
  return lines;
}
