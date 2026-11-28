// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock stats scorecard --weekly [--repo R] [--json]` (#6203): merges, all-in $/merge, issue->merge median/p90, first-pass %,
 * escape %, human touches/merge, queue_wait by cause and non-merged spend %, by ISO week (UTC) and engine version.
 * Reads ~/.forge/batches/<id>/log.jsonl (+ plan.json, state.json), the MERGE_LEDGER records in ~/.forge/runs and the escape cache.
 * Deterministic, no network. A field a source lacks degrades to n/a; it is never invented.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { percentile } from "./aggregate.mjs";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const MIN = 60000;
export const QUEUE_CAUSES = ["hold", "pause", "capacity", "breaker", "dependency", "host_offline", "other"];
const parseJsonl = (file) => { try { return readFileSync(file, "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } }); } catch { return []; } };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
export const forgeHome = (env = process.env) => env.FORGE_HOME_DIR || join(homedir(), ".forge");

/** ISO week start (Monday, UTC) as YYYY-MM-DD. */
export function weekOf(ms) {
  const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

/** Batches read from disk: [{id, repo, created, engineVersion, rows}] (rows with a parsed `t`). */
export function readBatches({ home = forgeHome(), repo = null } = {}) {
  const root = join(home, "batches");
  if (!existsSync(root)) return [];
  const out = [];
  for (const id of readdirSync(root)) {
    if (!/^b\d{8}-/.test(id)) continue;
    const dir = join(root, id), plan = readJson(join(dir, "plan.json")), state = readJson(join(dir, "state.json"));
    if (repo && String(plan?.repo ?? "").toLowerCase() !== repo.toLowerCase()) continue;
    const m = /^b(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
    const created = Date.parse(plan?.created ?? "") || (m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN);
    const rows = parseJsonl(join(dir, "log.jsonl")).map((r) => ({ ...r, t: Date.parse(r.at ?? "") })).filter((r) => isNum(r.t));
    out.push({ id, repo: plan?.repo ?? null, created, engineVersion: state?.engineVersion ?? null, rows });
  }
  return out;
}

/** MERGE_LEDGER records from the run logs: Map "repo-ish#issue" -> last record. */
export function readMergeLedgers({ home = forgeHome(), env = process.env } = {}) {
  const dir = env.FORGE_RUNS_DIR || join(home, "runs"), out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    let text; try { text = readFileSync(join(dir, f), "utf8"); } catch { continue; }
    if (!text.includes("MERGE_LEDGER")) continue;
    const issue = Number(/(\d+)\.jsonl$/.exec(f)?.[1]);
    for (const l of text.split("\n")) { if (!l.includes("MERGE_LEDGER")) continue; try { const e = JSON.parse(l); if (e.event === "MERGE_LEDGER") out.set(issue, { ...e, ts: Date.parse(e.ts ?? "") }); } catch { /* skip */ } }
  }
  return out;
}

/**
 * Deduped spend of one issue's rows, in order. Rows of a recovery chain carry the cost so far, so a row that is >= the previous
 * row's cost adds only the difference; a lower one starts a new run and counts in full. Returns [{t, usd}] increments.
 */
export function spendIncrements(rows) {
  let prev = 0; const out = [];
  for (const r of rows) {
    if (!isNum(r.cost_usd) || r.cost_usd <= 0) continue;
    const inc = r.cost_usd >= prev ? r.cost_usd - prev : r.cost_usd;
    prev = r.cost_usd; if (inc > 0) out.push({ t: r.t, usd: inc });
  }
  return out;
}

const issueListed = (detail, n) => new RegExp(`#?\\b${n}\\b`).test(String(detail ?? "")) && /^[#\d,\s]+$/.test(String(detail ?? "").trim());

/**
 * The engine version a batch ran at time t. A batch outlives upgrades, so its state.json (the latest version) is wrong for older
 * rows: the "vA -> vB" rows (re-admission and upgrade interrupts) give the transitions; before the first one the version was A.
 */
export function versionAt(rows, finalVersion, t) {
  const tr = [];
  for (const r of rows) { const m = /v?(\d+\.\d+\.\d+)\s*(?:→|->)\s*v?(\d+\.\d+\.\d+)/.exec(r.detail ?? ""); if (m) tr.push({ t: r.t, from: m[1], to: m[2] }); }
  tr.sort((a, b) => a.t - b.t);
  // No transition recorded: state.json's version holds for a short batch; a batch that ran over a day may have straddled an unrecorded upgrade.
  if (!tr.length) return rows.length && rows[rows.length - 1].t - rows[0].t <= 24 * 3600000 ? finalVersion ?? null : null;
  let v = tr[0].from;
  for (const x of tr) if (x.t <= t) v = x.to;
  return v;
}

/** Global intervals from a batch's rows: pause and breaker. */
function globalSpans(rows) {
  const pause = [], breaker = []; let ps = null, bs = null;
  for (const r of rows) {
    if (r.outcome === "pause") { ps = ps ?? r.t; const u = Date.parse(/until (\d{4}-[\dT:.\-]+Z)/.exec(r.detail ?? "")?.[1] ?? ""); if (isNum(u)) { pause.push([r.t, u]); ps = null; } }
    else if (r.outcome === "unpause" || r.outcome === "pause-expired") { if (ps != null) pause.push([ps, r.t]); ps = null; pause.push([r.t, r.t]); }
    else if (r.outcome === "breaker") { if (/cleared/.test(r.detail ?? "")) { if (bs != null) breaker.push([bs, r.t]); bs = null; } else bs = bs ?? r.t; }
  }
  return { pause, breaker };
}
const overlap = (a0, a1, spans) => spans.reduce((s, [b0, b1]) => s + Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)), 0);
const gapCause = (prev) => {
  if (!prev) return "other";
  const o = prev.outcome, c = prev.code ?? "";
  if (c === "sandbox.capacity" || c === "host.busy" || c === "sandbox.disk_pressure" || o === "host-overloaded") return "capacity";
  if (c === "sandbox.unreachable" || c === "sandbox.transient") return "host_offline";
  if (o === "held" || /^dependency-/.test(o) || c === "dependency.open") return "dependency";
  if (o === "needs-human" || o === "requeued" || o === "hold" || o === "hold-expired" || o === "readmitted") return "hold";
  return "other";
};

/**
 * Queue wait of one merged issue by cause, from ready to merged, minus the lane's active time; never reset by a requeue.
 * ready = the first row naming the issue in a batch's `added` rows, else the batch's creation. Gaps between a lane's end and the
 * next lane's start take the cause of the row that ended the previous attempt; pause and breaker spans override within a gap.
 */
export function queueByCause(issueRows, mergedRow, ready, spans) {
  const causes = Object.fromEntries(QUEUE_CAUSES.map((c) => [c, 0]));
  let cursor = ready, prev = null;
  for (const r of issueRows) {
    if (r.t > mergedRow.t) break;
    if (["hold", "hold-expired", "readmitted", "requeued", "held"].includes(r.outcome) && !isNum(r.wall_ms) && !r.minutes) { if (r.outcome === "hold" || r.outcome === "held") prev = r; continue; }
    const active = isNum(r.wall_ms) ? r.wall_ms : isNum(r.minutes) ? r.minutes * MIN : 0;
    const start = Math.max(cursor, r.t - active);
    if (start > cursor) {
      const p = overlap(cursor, start, spans.pause), b = overlap(cursor, start, spans.breaker);
      const h = Math.min(overlap(cursor, start, spans.hold ?? []), start - cursor - p - b);
      causes.pause += p; causes.breaker += b; causes.hold += Math.max(0, h);
      causes[gapCause(prev)] += Math.max(0, start - cursor - p - b - Math.max(0, h));
    }
    cursor = Math.max(cursor, r.t); prev = r;
  }
  const total = Object.values(causes).reduce((a, b) => a + b, 0);
  return { total, causes };
}

/** One record per merged issue: the data every weekly metric reads. */
export function mergeRecords(batches, ledgers = new Map()) {
  const recs = [], byIssue = new Map();
  for (const b of batches) {
    const spans = globalSpans(b.rows);
    const added = new Map();
    for (const r of b.rows) if (r.outcome === "added" && r.issue == null) for (const m of String(r.detail ?? "").matchAll(/#(\d+)/g)) if (!added.has(+m[1])) added.set(+m[1], r.t);
    const per = new Map();
    for (const r of b.rows) if (Number.isInteger(r.issue)) { if (!per.has(r.issue)) per.set(r.issue, []); per.get(r.issue).push(r); }
    const holdSpan = new Map(); // issue -> [[placed, expired|Infinity]]: an operator hold row lists the issues; a hold-expired row ends it
    for (const r of b.rows) {
      if (r.outcome === "hold" && r.issue == null) for (const m of String(r.detail ?? "").matchAll(/\d+/g)) if (issueListed(r.detail, m[0])) { const a = holdSpan.get(+m[0]) ?? []; a.push([r.t, Infinity]); holdSpan.set(+m[0], a); }
      if (r.outcome === "hold-expired" && Number.isInteger(r.issue)) { const open = (holdSpan.get(r.issue) ?? []).filter((x) => x[1] === Infinity && x[0] <= r.t).pop(); if (open) open[1] = r.t; }
    }
    const holds = new Map(); // operator hold rows list the issues in detail
    for (const r of b.rows) if (r.outcome === "hold" && r.issue == null) for (const m of String(r.detail ?? "").matchAll(/\d+/g)) if (issueListed(r.detail, m[0])) holds.set(+m[0], (holds.get(+m[0]) ?? 0) + 1);
    for (const [issue, rows] of per) {
      const key = `${b.id}#${issue}`;
      const spend = spendIncrements(rows);
      const touches = rows.filter((r) => (r.outcome === "requeued" && r.trigger == null && !/^dependency \d+ requeued/.test(r.detail ?? "")) || (r.outcome === "readmitted" && /^needs-human label removed/.test(r.detail ?? ""))).length + (holds.get(issue) ?? 0);
      const merged = rows.find((r) => r.outcome === "merged");
      const ready = Math.min(added.get(issue) ?? Infinity, b.created ?? Infinity, ...rows.map((r) => r.t - (isNum(r.wall_ms) ? r.wall_ms : 0)));
      const q = merged ? queueByCause(rows, merged, ready, { ...spans, hold: holdSpan.get(issue) ?? [] }) : null;
      const mq = merged?.phases?.queue_wait?.causes;
      const led = merged ? ledgers.get(issue) : null;
      const rec = { key, batch: b.id, issue, repo: b.repo, version: led?.engine_version ?? merged?.engineVersion ?? versionAt(b.rows, b.engineVersion, (merged ?? rows[rows.length - 1]).t) ?? "unknown", spend, spendUsd: spend.reduce((s, x) => s + x.usd, 0), humanTouches: touches + (isNum(led?.human_touch) ? led.human_touch : 0), merged: Boolean(merged) };
      if (merged) {
        const firstPass = typeof led?.first_pass === "boolean" ? led.first_pass : typeof merged.first_pass === "boolean" ? merged.first_pass : null;
        Object.assign(rec, { mergedAt: merged.t, firstPass, ready, issueToMergeMs: Number.isFinite(ready) ? merged.t - ready : null, queue: mq ? { total: Object.values(mq).reduce((a, b2) => a + (isNum(b2) ? b2 : 0), 0), causes: { ...Object.fromEntries(QUEUE_CAUSES.map((c) => [c, 0])), ...mq }, measured: true } : { ...q, measured: false }, pr: merged.pr ?? null });
      }
      if (!byIssue.has(issue) && !merged) { /* kept: spend on a never-merged issue still counts */ }
      recs.push(rec); byIssue.set(key, rec);
    }
  }
  // An issue merged in one batch and spent in another: the other batch's spend is non-merged only when no batch merged it.
  const mergedAnywhere = new Set(recs.filter((r) => r.merged).map((r) => `${r.repo}#${r.issue}`));
  for (const r of recs) r.mergedElsewhere = !r.merged && mergedAnywhere.has(`${r.repo}#${r.issue}`);
  return recs;
}

const pct = (a, b) => (b > 0 ? a / b : null);
/** Aggregate merge records by (week, version). `escapes`: Map "issue-or-pr" -> boolean escaped (from `stats escapes`). */
export function weeklyScorecard(recs, { escapes = null } = {}) {
  const groups = new Map();
  const g = (week, version) => { const k = `${week}\u0000${version}`; if (!groups.has(k)) groups.set(k, { week, version, merges: 0, spend: 0, nonMergedSpend: 0, firstPass: [0, 0], touches: 0, i2m: [], queue: Object.fromEntries(QUEUE_CAUSES.map((c) => [c, 0])), queueN: 0, queueMeasured: 0, esc: [0, 0] }); return groups.get(k); };
  for (const r of recs) {
    for (const s of r.spend) { const x = g(weekOf(s.t), r.version); x.spend += s.usd; if (!r.merged && !r.mergedElsewhere) x.nonMergedSpend += s.usd; }
    if (!r.merged) continue;
    const x = g(weekOf(r.mergedAt), r.version);
    x.merges++; x.touches += r.humanTouches;
    if (r.firstPass != null) { x.firstPass[1]++; if (r.firstPass) x.firstPass[0]++; }
    if (isNum(r.issueToMergeMs)) x.i2m.push(r.issueToMergeMs);
    if (r.queue) { x.queueN++; if (r.queue.measured) x.queueMeasured++; for (const c of QUEUE_CAUSES) x.queue[c] += r.queue.causes[c] ?? 0; }
    const esc = escapes?.get?.(r.pr) ?? escapes?.get?.(`pr:${r.pr}`);
    if (typeof esc === "boolean") { x.esc[1]++; if (esc) x.esc[0]++; }
  }
  return [...groups.values()].sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : a.version.localeCompare(b.version, undefined, { numeric: true }))).map((x) => ({
    week: x.week, version: x.version, merges: x.merges, spend_usd: x.spend,
    usd_per_merge: x.merges ? x.spend / x.merges : null,
    issue_to_merge_median_min: x.i2m.length ? percentile(x.i2m, 50) / MIN : null, issue_to_merge_p90_min: x.i2m.length ? percentile(x.i2m, 90) / MIN : null,
    first_pass_pct: pct(x.firstPass[0], x.firstPass[1]), first_pass_n: x.firstPass[1],
    escape_pct: pct(x.esc[0], x.esc[1]), escape_n: x.esc[1],
    human_touches_per_merge: x.merges ? x.touches / x.merges : null,
    queue_wait_min_per_merge: x.queueN ? Object.fromEntries(QUEUE_CAUSES.map((c) => [c, x.queue[c] / x.queueN / MIN])) : null,
    non_merged_spend_pct: pct(x.nonMergedSpend, x.spend),
  }));
}

const f = (v, d = 1, suf = "") => (v == null ? "n/a" : `${v.toFixed(d)}${suf}`);
export function renderWeekly(rows, { repo = null } = {}) {
  if (!rows.length) return "No batch data found.\n";
  const lines = [`Weekly scorecard${repo ? ` (${repo})` : ""}: by ISO week (Monday, UTC) and engine version. n/a = the source has no such field.`, ""];
  const head = ["week", "engine", "merges", "$/merge", "i2m med", "i2m p90", "1st-pass", "escape", "touch/m", "nonmerged$"];
  const body = rows.map((r) => [r.week, r.version, String(r.merges), f(r.usd_per_merge, 2, ""), f(r.issue_to_merge_median_min, 0, "m"), f(r.issue_to_merge_p90_min, 0, "m"),
    r.first_pass_pct == null ? "n/a" : `${Math.round(r.first_pass_pct * 100)}% (${r.first_pass_n})`, r.escape_pct == null ? "n/a" : `${(r.escape_pct * 100).toFixed(1)}% (${r.escape_n})`, f(r.human_touches_per_merge, 2), f(r.non_merged_spend_pct == null ? null : r.non_merged_spend_pct * 100, 0, "%")]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join("  ").trimEnd();
  lines.push(line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line), "", "queue_wait per merged issue, minutes by cause (ready to start, not reset by requeue):");
  const qh = ["week", "engine", ...QUEUE_CAUSES], qb = rows.filter((r) => r.queue_wait_min_per_merge).map((r) => [r.week, r.version, ...QUEUE_CAUSES.map((c) => f(r.queue_wait_min_per_merge[c], 0))]);
  const qw = qh.map((h, i) => Math.max(h.length, ...qb.map((b) => b[i].length)));
  const ql = (c) => c.map((x, i) => x.padEnd(qw[i])).join("  ").trimEnd();
  lines.push(ql(qh), ql(qw.map((n) => "-".repeat(n))), ...qb.map(ql));
  return `${lines.join("\n")}\n`;
}

/** Entry used by `forgedock stats scorecard --weekly`. */
export async function runWeekly(argv, deps = {}) {
  const repoAt = argv.indexOf("--repo"), repo = repoAt >= 0 ? argv[repoAt + 1] : null, json = argv.includes("--json");
  const home = deps.home ?? forgeHome();
  const batches = deps.batches ?? readBatches({ home, repo });
  const recs = mergeRecords(batches, deps.ledgers ?? readMergeLedgers({ home }));
  const { readEscapeCache } = await import("./escapes.mjs");
  const rows = weeklyScorecard(recs, { escapes: deps.escapes ?? readEscapeCache({ home, repo }) });
  (deps.out ?? ((s) => process.stdout.write(s)))(json ? `${JSON.stringify(rows, null, 2)}\n` : renderWeekly(rows, { repo }));
  return 0;
}
