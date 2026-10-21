// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure, source-agnostic aggregation for `forgedock stats` (forge#3835). No I/O, no clock, no model.
 *
 * Input record model (every source maps onto it; a missing field is null and degrades to "n/a"):
 *   run   { source, repo, version, issue, run, finished, hydrated, usageEvents, reason, code, remediated,
 *           startTs, endTs, wallMs, phases: { <id>: { cr, out, usd, ms, attempts } } }
 *   event { repo, version, issue, pr, ts, event, ...payload }          (FORGE:TELEMETRY gate/review events)
 *   issue { repo, number, isPr, createdAt, closedAt, labels: [name], authorType }
 *
 * Counting rules reproduce scripts/cost-report.sh so both reports agree on the same logs: only finished runs
 * count, hydrated runs and runs with no usage events are excluded, tokens are cache-read tokens, and the
 * per-phase mean divides by n (a run that skipped a phase counts 0).
 */

export const DEFAULT_MIN_N = 10;
export const UNKNOWN = "unknown";

const PHASES = ["investigate", "build", "review", "remediate", "close"];
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);

/** p=50 is the median (average of the middle pair, as cost-report.sh); any other p is nearest-rank. */
export function percentile(values, p) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  if (p === 50) return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return v[Math.max(0, Math.ceil((v.length * p) / 100) - 1)];
}

/** Sort key for "1.16.1" / "1.16.1~": numeric parts, unparseable parts count as 0. */
export function versionKey(v) {
  return String(v).replace(/~$/, "").split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
}
export function compareVersions(a, b) {
  const x = versionKey(a); const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** releaseTimes: [{ v, t }] with t in epoch seconds. Latest release at or before `ms`, marked "~" (estimated). */
export function estimateVersion(ms, releaseTimes) {
  if (!isNum(ms)) return UNKNOWN;
  let best = null;
  for (const r of releaseTimes ?? []) if (r.t * 1000 <= ms && (!best || r.t > best.t)) best = r;
  return best ? `${best.v}~` : UNKNOWN;
}

const toMs = (ts) => { const t = Date.parse(ts ?? ""); return Number.isNaN(t) ? null : t; };
const ratio = (num, den) => (den > 0 ? num / den : null);
const sub = (a, b) => (isNum(a) && isNum(b) ? a - b : null);

function issueSource(i) {
  if (i.labels.includes("review-finding")) return "review-finding";
  return i.authorType === "Bot" ? "pipeline" : "human";
}
function closedKind(i) {
  if (i.labels.includes("workflow:merged")) return "merged";
  if (i.labels.includes("workflow:invalid") || i.labels.includes("invalid")) return "invalid";
  if (i.labels.includes("duplicate")) return "duplicate";
  return "other";
}

function costSection(runs) {
  const n = runs.length;
  const cr = runs.map((r) => sum(Object.values(r.phases).map((p) => p.cr ?? 0)));
  const merged = runs.filter((r) => r.reason === "merged").length;
  const usd = runs.map((r) => {
    const v = Object.values(r.phases).map((p) => p.usd).filter(isNum);
    return v.length ? sum(v) : null;
  }).filter(isNum);
  const perPhase = {};
  for (const id of [...PHASES, ...new Set(runs.flatMap((r) => Object.keys(r.phases)).filter((p) => !PHASES.includes(p)))]) {
    perPhase[id] = n ? sum(runs.map((r) => r.phases[id]?.cr ?? 0)) / n : null;
  }
  return {
    n, cacheReadMean: mean(cr), cacheReadMedian: percentile(cr, 50), perPhase,
    outputMean: n ? sum(runs.map((r) => sum(Object.values(r.phases).map((p) => p.out ?? 0)))) / n : null,
    perMergedIssue: merged ? sum(cr) / merged : null,
    usdN: usd.length, usdMean: mean(usd), usdTotal: usd.length ? sum(usd) : null,
  };
}

function timeSection(runs) {
  const phases = {};
  const ids = new Set(runs.flatMap((r) => Object.keys(r.phases)));
  for (const id of ids) {
    const ms = runs.map((r) => r.phases[id]?.ms).filter((x) => isNum(x) && x > 0);
    if (ms.length) phases[id] = { n: ms.length, p50: percentile(ms, 50), p90: percentile(ms, 90) };
  }
  const wall = runs.map((r) => r.wallMs).filter((x) => isNum(x) && x >= 0);
  return { phases, wall: { n: wall.length, p50: percentile(wall, 50), p90: percentile(wall, 90) } };
}

function flowSection(runs) {
  const n = runs.length;
  const codes = {};
  let coded = 0;
  for (const r of runs) if (r.code) { codes[r.code] = (codes[r.code] ?? 0) + 1; coded++; }
  const top = Object.entries(codes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => ({ code, count, pct: count / coded }));
  return {
    n,
    mergedPct: ratio(runs.filter((r) => r.reason === "merged").length, n),
    needsHumanPct: ratio(runs.filter((r) => r.reason === "needs-human").length, n),
    remediationPct: ratio(runs.filter((r) => r.remediated).length, n),
    codesN: coded, codes: top,
  };
}

function funnelSection(events, issues) {
  const findings = events.filter((e) => e.event === "finding_disposition");
  const reviews = new Set([...events.filter((e) => e.event === "review_panel"), ...findings]
    .map((e) => `${e.repo}#${e.pr ?? e.issue}`));
  const bySeverity = {};
  for (const f of findings) {
    const s = String(f.severity ?? "unknown").toUpperCase();
    const d = (bySeverity[s] ??= { total: 0, ISSUE: 0, NOTE: 0, INPR_FIX: 0, other: 0 });
    d.total++;
    if (f.disposition in d) d[f.disposition]++; else d.other++;
  }
  for (const d of Object.values(bySeverity)) d.perReview = reviews.size ? d.total / reviews.size : null;
  const dispositions = { ISSUE: 0, NOTE: 0, INPR_FIX: 0 };
  for (const f of findings) if (f.disposition in dispositions) dispositions[f.disposition]++;
  // Events written before the scope field existed carry none and are not counted.
  const introduced = findings.filter((f) => f.scope === "introduced").length;
  return {
    reviews: reviews.size, findings: findings.length, introduced, perReview: ratio(findings.length, reviews.size),
    bySeverity, dispositions,
    validated: issues.filter((i) => i.labels.includes("validated")).length,
    falsePositive: issues.filter((i) => i.labels.includes("false-positive")).length,
  };
}

function gatesSection(events) {
  const of = (name) => events.filter((e) => e.event === name);
  const acc = of("acceptance_gate"); const size = of("diff_size"); const ci = of("ci_gate"); const live = of("liveness");
  const blocked = (list, fn) => ({ n: list.length, blocked: list.filter(fn).length, rate: ratio(list.filter(fn).length, list.length) });
  const malformed = acc.filter((e) => Number(e.malformed) > 0);
  const count = (list, key, val) => list.filter((e) => e[key] === val).length;
  return {
    acceptance: blocked(acc, (e) => Number(e.failed) > 0),
    malformedRate: ratio(malformed.length, acc.length),
    diffSize: { ...blocked(size, (e) => e.result === "OVER"), over: count(size, "result", "OVER"), cohesive: count(size, "result", "COHESIVE") },
    ci: blocked(ci, (e) => e.result !== "PASS"),
    liveness: blocked(live, (e) => e.decision === "DEFER" || e.decision === "EXHAUSTED"),
  };
}

function issueFlowSection(issues, introduced = 0) {
  const real = issues.filter((i) => !i.isPr);
  const created = {};
  for (const i of real) { const s = issueSource(i); created[s] = (created[s] ?? 0) + 1; }
  const closedIssues = real.filter((i) => i.closedAt);
  const closed = {};
  for (const i of closedIssues) { const k = closedKind(i); closed[k] = (closed[k] ?? 0) + 1; }
  const merged = closed.merged ?? 0;
  return {
    n: real.length, created, createdTotal: real.length, closed, closedTotal: closedIssues.length,
    net: real.length ? real.length - closedIssues.length : null,
    findingsPerMerge: ratio(created["review-finding"] ?? 0, merged),
    introducedPerMerge: ratio(introduced, merged),
  };
}

function deltaOf(cur, prev) {
  if (!prev) return null;
  return {
    against: prev.version,
    cacheReadMean: sub(cur.cost.cacheReadMean, prev.cost.cacheReadMean),
    mergedPct: sub(cur.flow.mergedPct, prev.flow.mergedPct),
    needsHumanPct: sub(cur.flow.needsHumanPct, prev.flow.needsHumanPct),
    remediationPct: sub(cur.flow.remediationPct, prev.flow.remediationPct),
    wallP50: sub(cur.time.wall.p50, prev.time.wall.p50),
  };
}

/**
 * Join runs, gate events and issues into per-(version, repo) groups with a delta against the previous version of
 * the same repo and a low-n flag. opts: { minN, releaseTimes, sinceMs, sinceVersion }.
 */
export function aggregate({ runs = [], events = [], issues = [] } = {}, opts = {}) {
  const minN = isNum(opts.minN) ? opts.minN : DEFAULT_MIN_N;
  const rel = opts.releaseTimes ?? [];
  const sinceMs = opts.sinceMs ?? null;
  const inWindow = (...ts) => sinceMs == null || ts.some((t) => (toMs(t) ?? -Infinity) >= sinceMs);

  const excluded = { unfinished: 0, noUsage: 0 };
  const counted = [];
  for (const r of runs) {
    if (!r.finished) { excluded.unfinished++; continue; }
    if (r.hydrated || !(r.usageEvents > 0)) { excluded.noUsage++; continue; }
    if (!inWindow(r.endTs, r.startTs)) continue;
    counted.push({ ...r, version: r.version ?? estimateVersion(toMs(r.endTs ?? r.startTs ?? r.mtimeTs), rel), repo: r.repo ?? UNKNOWN });
  }

  const versionOfIssue = new Map();
  for (const r of counted) if (r.issue != null && r.version !== UNKNOWN) versionOfIssue.set(`${r.repo}#${r.issue}`, r.version);
  const evs = events.filter((e) => inWindow(e.ts)).map((e) => ({
    ...e, repo: e.repo ?? UNKNOWN,
    version: e.version ?? e.forge_version ?? estimateVersion(toMs(e.ts), rel),
  }));
  for (const e of evs) if (e.issue != null && e.version !== UNKNOWN && !versionOfIssue.has(`${e.repo}#${e.issue}`)) versionOfIssue.set(`${e.repo}#${e.issue}`, e.version);
  const iss = issues.filter((i) => inWindow(i.createdAt, i.closedAt)).map((i) => ({
    ...i, repo: i.repo ?? UNKNOWN, labels: i.labels ?? [],
    version: versionOfIssue.get(`${i.repo}#${i.number}`) ?? estimateVersion(toMs(i.createdAt), rel),
  }));

  const keys = new Map();
  for (const x of [...counted, ...evs, ...iss]) keys.set(`${x.version}\u0000${x.repo}`, { version: x.version, repo: x.repo });

  let groups = [...keys.values()].map(({ version, repo }) => {
    const sel = (list) => list.filter((x) => x.version === version && x.repo === repo);
    const g = { version, repo, cost: costSection(sel(counted)), time: timeSection(sel(counted)), flow: flowSection(sel(counted)),
      funnel: funnelSection(sel(evs), sel(iss)), gates: gatesSection(sel(evs)), issueFlow: null };
    g.issueFlow = issueFlowSection(sel(iss), g.funnel.introduced);
    g.n = g.flow.n;
    g.lowN = g.n < minN;
    g.minN = minN;
    return g;
  });
  groups.sort((a, b) => a.repo.localeCompare(b.repo) || (a.version === UNKNOWN) - (b.version === UNKNOWN)
    || compareVersions(a.version, b.version));
  for (let i = 0; i < groups.length; i++) {
    const prev = [...groups.slice(0, i)].reverse().find((p) => p.repo === groups[i].repo && p.version !== UNKNOWN);
    groups[i].delta = groups[i].version === UNKNOWN ? null : deltaOf(groups[i], prev);
  }
  if (opts.sinceVersion) groups = groups.filter((g) => g.version !== UNKNOWN && compareVersions(g.version, opts.sinceVersion) >= 0);
  return { groups, excluded, minN };
}

/** forge#4354: fail-soft alert thresholds (forge.yaml `stats.alerts.*`). Percentages are 0..100. */
export const DEFAULT_ALERTS = { window: 50, minLanes: 10, depsFailedPct: 20, deferredPct: 30, toolchainWarningPct: 50, outcomeShareFactor: 2 };

/**
 * Rates of fail-soft events over the last `window` lanes of `repo` (lanes from local-source `readLanes`), ordered by start
 * time. Nothing below `minLanes`. Rules: DEPS_PREPARED failed per ecosystem, deferred-to-ci, each TOOLCHAIN_WARNING text,
 * and outcome codes (except `completed`) whose share doubled against the previous window. Pure: no I/O, no clock.
 */
export function computeAlerts(lanes = [], opts = {}) {
  const c = { ...DEFAULT_ALERTS };
  for (const k of Object.keys(DEFAULT_ALERTS)) if (isNum(opts[k]) && opts[k] > 0) c[k] = opts[k];
  const all = (lanes ?? []).filter((l) => l && (opts.repo == null || l.repo === opts.repo))
    .map((l, i) => ({ l, i, t: toMs(l.startTs) ?? -Infinity }))
    .sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.l);
  const win = all.slice(-c.window);
  if (win.length < c.minLanes) return [];
  const prev = all.slice(Math.max(0, all.length - 2 * c.window), all.length - win.length);
  const out = [];
  const add = (event, count, sample, threshold, example, extra = {}) => out.push({ event, rate: count / sample, count, sample, threshold, example, ...extra });
  const ecos = [...new Set(win.flatMap((l) => l.deps.map((d) => d.eco ?? "unknown")))].sort();
  for (const eco of ecos) {
    const used = win.filter((l) => l.deps.some((d) => (d.eco ?? "unknown") === eco));
    const failed = used.filter((l) => l.deps.some((d) => (d.eco ?? "unknown") === eco && d.status === "failed"));
    if (failed.length / used.length > c.depsFailedPct / 100) {
      const ex = failed.flatMap((l) => l.deps).find((d) => (d.eco ?? "unknown") === eco && d.status === "failed");
      add(`DEPS_PREPARED failed (${eco})`, failed.length, used.length, c.depsFailedPct / 100, ex?.reason ?? null);
    }
  }
  const deferred = win.filter((l) => l.deferred.length);
  if (deferred.length / win.length > c.deferredPct / 100) add("deferred-to-ci", deferred.length, win.length, c.deferredPct / 100, deferred[deferred.length - 1].deferred[0]);
  const warnings = [...new Set(win.flatMap((l) => l.toolchainWarnings))].sort();
  for (const w of warnings) {
    const hit = win.filter((l) => l.toolchainWarnings.includes(w)).length;
    if (hit / win.length > c.toolchainWarningPct / 100) add("TOOLCHAIN_WARNING", hit, win.length, c.toolchainWarningPct / 100, w);
  }
  const coded = (list) => list.filter((l) => l.code != null);
  const cw = coded(win), cp = coded(prev);
  if (cw.length && prev.length >= c.minLanes && cp.length) {
    const share = (list, code) => list.filter((l) => l.code === code).length / list.length;
    for (const code of [...new Set(cw.map((l) => l.code))].filter((x) => x !== "completed").sort()) {
      const hits = cw.filter((l) => l.code === code);
      const now = share(cw, code), before = share(cp, code);
      if (hits.length >= 2 && now >= c.outcomeShareFactor * before) {
        const ex = hits[hits.length - 1];
        add(`outcome ${code}`, hits.length, cw.length, c.outcomeShareFactor, `#${ex.issue} ${ex.reason ?? code}`, { prevRate: before });
      }
    }
  }
  return out;
}
