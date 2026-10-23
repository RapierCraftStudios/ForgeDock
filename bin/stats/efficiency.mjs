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

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const RETRY_CAUSES = Object.freeze(["env", "engine", "code", "review", "unknown"]);

/** Builder (implement) attempt trigger -> retry cause; null = not a retry. Every fixround.mjs TRIGGERS entry is listed. */
export const TRIGGER_CAUSE = Object.freeze({
  plan: null, build: null, verifier: null,
  ci_unavailable: "env",
  timeout_restart: "engine", context_restart: "engine", budget_wrapup: "engine", recovery: "engine",
  precheck: "code", structure: "code", docs: "code", enumerating: "code", sequence: "code", ci_red: "code", conformance: "code",
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

function parseLog(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === "object") out.push(e); } catch { /* torn line */ }
  }
  return out;
}

/** Every RUN_START..RUN_TERMINAL slice of one run log (all of them, not only the last). */
export function issueSlices(events) {
  const out = [];
  let cur = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") continue;
    if (e.event === "RUN_START") { cur = { startTs: e.ts ?? null, repo: e.repo ?? null, terminal: null, attempts: [] }; out.push(cur); continue; }
    if (!cur) continue;
    if (e.event === "PHASE_ATTEMPT_USAGE") {
      cur.attempts.push({ phase: e.phase ?? "other", trigger: e.trigger ?? null, restart_of: e.restart_of ?? null, model: e.model ?? null,
        turns: num(e.turns), cacheRead: num(e.usage?.cache_read_input_tokens), cost: costOf(e) });
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
  const t = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "");
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

const group = (xs) => {
  const turns = sum(xs.map((x) => x.implTurns)), cache = sum(xs.map((x) => x.implCache));
  return { n: xs.length, cost_usd: r(sum(xs.map((x) => x.cost)), 1e6), usd_per_merge: r(per(sum(xs.map((x) => x.cost)), xs.length)),
    turns_per_merge: r(per(turns, xs.length), 10), context_per_turn: r(per(cache, turns), 1) };
};

/**
 * The metrics of one cohort. `entries`: [{row, settleAt}] (a batch row and its settle time, ISO or null = unbounded);
 * `logs`: issue -> run-log events; `issues`: issue -> {body, labels, comments} or null when gh was not available.
 */
export function efficiencyMetrics({ entries = [], logs = new Map(), issues = null, repo = null, now = 0, notes = [] } = {}) {
  const merged = [];
  for (const { row, settleAt } of entries) {
    if (row?.outcome !== "merged") continue;
    const slices = issueSlices(logs.get(row.issue) ?? []).filter((s) => (!repo || !s.repo || s.repo === repo) && (!settleAt || !s.startTs || s.startTs <= settleAt));
    const atts = slices.flatMap((s) => s.attempts), impl = atts.filter((a) => a.phase === "implement");
    const retries = Object.fromEntries(RETRY_CAUSES.map((c) => [c, 0]));
    for (const s of slices) for (const [c, k] of Object.entries(sliceRetries(s))) retries[c] += k;
    for (const s of slices.slice(0, -1)) retries[codeCause(s.terminal?.code)]++; // lane reruns
    const info = issues?.get(row.issue) ?? null;
    const term = [...slices].reverse().find((s) => s.terminal?.reason === "merged")?.terminal;
    merged.push({ issue: row.issue, slices: slices.length, cost: sum(atts.map((a) => a.cost)), implCost: sum(impl.map((a) => a.cost)),
      reviewCost: sum(atts.filter((a) => a.phase === "review").map((a) => a.cost)), implTurns: sum(impl.map((a) => a.turns)), implCache: sum(impl.map((a) => a.cacheRead)),
      size: term?.size ?? laneSize({ labels: info?.labels ?? [] }) ?? "unknown", impl, retries, info });
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
    for (const m of merged) if (m.info) acceptance[acceptanceOf(m.info.comments, now)]++;
    acceptance.probed = acceptance.pass + acceptance.fail + acceptance.pending;
    acceptance.pass_rate = r(per(acceptance.pass, acceptance.pass + acceptance.fail));
  }
  return {
    merged: merged.length, cost_usd: all.cost_usd, implement_usd: r(sum(merged.map((m) => m.implCost)), 1e6), review_usd: r(sum(merged.map((m) => m.reviewCost)), 1e6),
    usd_per_merge: all.usd_per_merge, turns_per_merge: all.turns_per_merge, context_per_turn: all.context_per_turn,
    implement_turns: sum(merged.map((m) => m.implTurns)), implement_cache_read: sum(merged.map((m) => m.implCache)),
    by_size: bySize,
    by_model: Object.fromEntries(Object.entries(byModel).map(([k, g]) => [k, { merges: g.merges.size, attempts: g.attempts, turns: g.turns, cost_usd: r(g.cost, 1e6),
      usd_per_merge: r(per(g.cost, g.merges.size)), turns_per_merge: r(per(g.turns, g.merges.size), 10), context_per_turn: r(per(g.cache, g.turns), 1) }])),
    retries: { total, per_merge: r(per(total, merged.length), 100), by_cause: retries, lane_reruns: sum(merged.map((m) => Math.max(0, m.slices - 1))) },
    no_action: { lanes: sum(Object.values(noAction).map((g) => g.n)), cost_usd: r(sum(Object.values(noAction).map((g) => g.cost_usd)), 1e6),
      by_kind: Object.fromEntries(Object.entries(noAction).map(([k, g]) => [k, { ...g, cost_usd: r(g.cost_usd, 1e6) }])) },
    quality, acceptance,
    per_issue: merged.map((m) => ({ issue: m.issue, slices: m.slices, cost_usd: r(m.cost, 1e6), implement_usd: r(m.implCost, 1e6), implement_turns: m.implTurns,
      implement_cache_read: m.implCache, size: m.size, retries: m.retries, ...(m.info ? { quality: issueQuality(m.info.body).tag } : {}) })),
    notes,
  };
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const readEvents = (runsDir, n) => { try { return parseLog(readFileSync(join(runsDir, `${n}.jsonl`), "utf8")); } catch { return []; } };
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
  const logs = new Map(entries.map(({ row }) => [row.issue, readEvents(runsDir, row.issue)]));
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

/** Trailing windows: the union of the repo's batches created in each window; an issue in several batches counts once (latest row). */
export async function windowEfficiency({ batchRoot, runsDir, repo = null, gh = null, now = Date.now(), windows = [WEEK_MS] }) {
  const batches = (existsSync(batchRoot) ? listBatches(batchRoot) : []).map((id) => {
    const dir = join(batchRoot, id), plan = readJson(join(dir, "plan.json")) ?? {};
    return { dir, plan, created: Date.parse(plan.created ?? "") };
  }).filter((b) => Number.isFinite(b.created) && (!repo || b.plan.repo === repo)).sort((a, b) => a.created - b.created);
  const out = {};
  for (const w of windows) {
    const latest = new Map();
    for (const b of batches) {
      if (b.created > now || now - b.created > w) continue;
      const at = settleTimes(readLogRows(b.dir));
      for (const row of batchRows(b.dir)) if (Number.isSafeInteger(row?.issue)) latest.set(row.issue, { row, settleAt: at.get(row.issue) ?? null });
    }
    out[windowLabel(w)] = { batches: batches.filter((b) => b.created <= now && now - b.created <= w).length,
      ...(await computeScope({ entries: [...latest.values()], runsDir, repo, gh, now })) };
  }
  return out;
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
  return lines;
}
