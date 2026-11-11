// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#5209: adaptive lane depth. `forgedock stats --depth` joins each lane's LIGHT_ELIGIBILITY verdict, reasons and
 * signals (bin/lean/light.mjs) with its outcome: merged / needs-human, first pass, cost, wall and model time, review
 * findings and conformance failures, and post-merge defect signals within 7 days: the conformance-outcomes set (#5364),
 * reverted, reopened, cited, and same_hunks (a later fix PR's old-side lines blame to the lane's merge commit). It answers whether, for lanes the light gate would have taken, the plan and review steps
 * caught anything or only added cost, and whether the #5052 light-lane promotion criterion is met:
 *   light-shaped lanes (light or upgraded) cost <= 1.2x eligible full lanes of the same size, wall <= 1.3x model time, and
 *   a defect rate no worse than those full lanes; any cell under min-n is "insufficient data".
 * Flipping lean.light.mode stays a config decision. No model, no clock (`now` is injected), no network except the injected gh.
 *
 * Sources: the run logs (~/.forge/runs/<issue>.jsonl, every RUN_START..RUN_TERMINAL slice); GitHub only for defect signals.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstPassOf } from "../lean/fixround.mjs";
import { DEFAULT_MIN_N } from "./aggregate.mjs";
import { cacheDir } from "./cache.mjs";
import { cites, isFix, reverts, sameHunks } from "./conformance-outcomes.mjs";
import { sameRepo, WEEK_MS } from "./efficiency.mjs";

export const VERDICTS = Object.freeze(["eligible", "ambiguous", "ineligible"]);
export const PROMOTION = Object.freeze({ costRatio: 1.2, wallOverModel: 1.3 });
export const INSUFFICIENT = "insufficient data";

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const costOf = (e) => num(e.cost_usd_delta) ?? num(e.cost_usd);
const r = (x, p = 1e4) => (num(x) == null ? null : Math.round(x * p) / p);
const per = (a, b) => (b > 0 ? a / b : null);
const ms = (ts) => { const t = Date.parse(ts ?? ""); return Number.isNaN(t) ? null : t; };
const median = (xs) => {
  const v = xs.filter((x) => num(x) != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const h = Math.floor(v.length / 2);
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
};
const codesOf = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map((x) => String(x?.code ?? x ?? "").trim()).filter(Boolean))].sort();

function parseLog(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === "object") out.push(e); } catch { /* torn line */ }
  }
  return out;
}

/**
 * One row per RUN_START..RUN_TERMINAL slice of one run log that logged LIGHT_ELIGIBILITY. A slice whose repo is unknown is
 * kept; `sinceMs` bounds the slice start (a slice without a start time is kept).
 */
export function depthRows(events, { repo = null, sinceMs = null, issue = null } = {}) {
  const out = [];
  let cur = null;
  const close = () => { if (cur?.elig && cur.term) out.push(finish(cur)); cur = null; };
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") continue;
    if (e.event === "RUN_START") { close(); cur = { start: e, elig: null, term: null, shape: "full", attempts: [], findings: 0, conf: 0, pr: null }; continue; }
    if (!cur) continue;
    if (e.event === "LIGHT_ELIGIBILITY") cur.elig = e;
    else if (e.event === "FASTFORWARD_ELIGIBILITY") cur.ff = e; // #5426
    else if (e.event === "LIGHT_DONE") cur.shape = "light";
    else if (e.event === "LIGHT_UPGRADE") cur.shape = "upgraded";
    else if (e.event === "PHASE_ATTEMPT_USAGE") cur.attempts.push(e);
    else if (e.event === "CONFORMANCE") {
      cur.findings += Array.isArray(e.failures) ? e.failures.length : 0;
      if (typeof e.state === "string" && e.state !== "conforms") cur.conf++;
    } else if (e.event === "VERIFIER") cur.findings += num(e.findings) ?? 0;
    else if (e.event === "PR_OPENED" && Number.isSafeInteger(e.pr)) cur.pr = e.pr;
    else if (e.event === "RUN_TERMINAL") { cur.term = e; close(); }
  }
  close();
  function finish(s) {
    const impl = s.attempts.filter((a) => a.phase === "implement");
    const t = s.term;
    return { issue: Number.isSafeInteger(s.start.issue) ? s.start.issue : issue, repo: s.start.repo ?? null, startTs: s.start.ts ?? null, endTs: t.ts ?? null,
      verdict: String(s.elig.verdict ?? "unknown"), mode: s.elig.mode ?? null, reasons: codesOf(s.elig.reasons), signals: codesOf(s.elig.signals),
      ff: s.ff ? { verdict: String(s.ff.verdict ?? "unknown"), eligible: s.ff.eligible === true, shadow: s.ff.shadow === true } : null,
      shape: s.shape, outcome: t.reason ?? null, merged: t.reason === "merged", needsHuman: t.reason === "needs-human",
      firstPass: firstPassOf(impl.map((a) => ({ trigger: a.trigger ?? null, restart_of: a.restart_of ?? null }))),
      cost: s.attempts.reduce((n, a) => n + (costOf(a) ?? 0), 0), wallMs: num(t.wall_ms), modelMs: num(t.model_ms),
      size: ["S", "M", "L"].includes(t.turns?.size) ? t.turns.size : null, pr: Number.isSafeInteger(t.pr) ? t.pr : s.pr,
      findings: s.findings, conformanceFailures: s.conf };
  }
  return out.filter((x) => (!repo || !x.repo || sameRepo(x.repo, repo)) && (sinceMs == null || ms(x.startTs) == null || ms(x.startTs) >= sinceMs));
}

const lines = (raw) => String(raw ?? "").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const DEFECT_CACHE_V = 2;
const CONCURRENCY = 4;
const defectCachePath = (repo, env) => join(cacheDir(repo, env), "depth-defects.json");
function loadDefectCache(repo, env) {
  try { const c = JSON.parse(readFileSync(defectCachePath(repo, env), "utf8")); if (c?.v === DEFECT_CACHE_V) return { v: DEFECT_CACHE_V, defects: c.defects ?? {}, shas: c.shas ?? {} }; } catch { /* refetch */ }
  return { v: DEFECT_CACHE_V, defects: {}, shas: {} };
}
function saveDefectCache(repo, env, c) {
  try { mkdirSync(cacheDir(repo, env), { recursive: true }); writeFileSync(defectCachePath(repo, env), JSON.stringify(c)); } catch { /* a cache never fails the report */ }
}
/** Run `fn` over `items` with at most `n` in flight. */
async function mapLimit(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

/**
 * Post-merge defect signals of merged rows with a PR, over the injected gh: Map issue -> {reopen, revert, cited, same_hunks, defect}.
 * The signals are those of conformance-outcomes.mjs (reverts, cites, sameHunks over the injected local `git` probes). same_hunks is
 * null when git cannot resolve (no local clone); defect is then null (n/a) unless another signal is true.
 * A gh failure gives the rows it could not read null fields (rendered n/a), never false.
 * Bounded crawl (#5318): reopens are read per issue (not repo-wide), the PR search is limited to the rows' merge window,
 * per-PR merge shas are fetched with bounded concurrency, and a row whose window has closed (`now` past its end + window)
 * is cached under cacheDir(repo) with the PR merge shas, so a warm run makes no gh calls for it. `useCache` false skips
 * the cache; `refresh` ignores what is stored. `onProgress({phase, done, total})` is called as rows are resolved.
 */
export async function gatherDefects({ repo, gh, rows = [], windowMs = WEEK_MS, now = null, env = process.env, useCache = false, refresh = false, onProgress = null, git = null } = {}) {
  const out = new Map();
  const merged = rows.filter((x) => x.merged && Number.isSafeInteger(x.pr) && ms(x.endTs) != null);
  if (!gh || !repo || !merged.length) return out;
  const cache = useCache && !refresh ? loadDefectCache(repo, env) : { v: DEFECT_CACHE_V, defects: {}, shas: {} };
  const settled = (x) => now != null && ms(x.endTs) + windowMs < now;
  const hit = (x) => { const c = cache.defects[`${x.issue}:${x.pr}`]; return c && c.endTs === x.endTs ? c.value : null; };
  const todo = [];
  for (const x of merged) { const v = settled(x) ? hit(x) : null; if (v) out.set(x.issue, v); else todo.push(x); }
  const total = merged.length;
  let done = total - todo.length;
  onProgress?.({ phase: "defect signals (cached)", done, total });
  if (!todo.length) return out;
  try {
    const from = new Date(Math.min(...todo.map((x) => ms(x.endTs)))).toISOString().slice(0, 10);
    const to = new Date(Math.max(...todo.map((x) => ms(x.endTs))) + windowMs).toISOString().slice(0, 10);
    const prs = lines(await gh(["api", "--paginate", `search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged merged:${from}..${to}`)}&per_page=100`,
      "--jq", ".items[] | {number, title, body, labels: [.labels[].name], merged_at: .pull_request.merged_at}"]));
    const shas = new Map(Object.entries(cache.shas).map(([k, v]) => [Number(k), v]));
    const shaOf = async (n) => {
      if (!shas.has(n)) shas.set(n, String(await gh(["api", `repos/${repo}/pulls/${n}`, "--jq", ".merge_commit_sha"])).trim() || null);
      return shas.get(n);
    };
    await mapLimit(todo, CONCURRENCY, async (x) => {
      const t0 = ms(x.endTs), inWin = (p) => p.number !== x.pr && ms(p.merged_at) != null && ms(p.merged_at) > t0 && ms(p.merged_at) <= t0 + windowMs;
      const reopens = lines(await gh(["api", "--paginate", `repos/${repo}/issues/${x.issue}/events?per_page=100`, "--jq", '.[] | select(.event == "reopened") | {issue: .issue.number, ts: .created_at}']));
      const reopen = reopens.some((e) => (e.issue ?? x.issue) === x.issue && (ms(e.ts) ?? 0) > t0);
      const own = prs.find((p) => p.number === x.pr);
      const lane = { repo, number: x.pr, title: own?.title ?? "", body: own?.body ?? "", closingIssues: [{ number: x.issue }] };
      const later = prs.filter(inWin);
      const revert = later.some((q) => reverts(q, lane, repo));
      const cited = later.some((q) => cites(q, lane));
      const fixes = later.filter(isFix);
      let same_hunks = false;
      if (fixes.length) {
        lane.mergeSha = git ? await shaOf(x.pr) : null;
        const withSha = lane.mergeSha ? await Promise.all(fixes.map(async (q) => ({ ...q, mergeSha: await shaOf(q.number) }))) : fixes;
        same_hunks = sameHunks(lane, withSha, git);
      }
      const hit = reopen || revert || cited || same_hunks === true;
      const value = { reopen, revert, cited, same_hunks, defect: hit ? true : same_hunks === null ? null : false };
      out.set(x.issue, value);
      if (settled(x)) cache.defects[`${x.issue}:${x.pr}`] = { endTs: x.endTs, value };
      onProgress?.({ phase: "defect signals", done: ++done, total });
    });
    if (useCache) { cache.shas = Object.fromEntries(shas); saveDefectCache(repo, env, cache); }
  } catch { // gh unavailable: the unread rows get null defect fields (n/a), never false
    for (const x of merged) if (!out.has(x.issue)) out.set(x.issue, { reopen: null, revert: null, cited: null, same_hunks: null, defect: null });
  }
  return out;
}

/** The metrics of one group of rows; `defects` maps issue -> {defect}. */
export function depthCell(rows, defects = new Map()) {
  const n = rows.length;
  const fp = rows.filter((x) => typeof x.firstPass === "boolean");
  const known = rows.filter((x) => x.merged && typeof defects.get(x.issue)?.defect === "boolean");
  const ratios = rows.filter((x) => x.wallMs != null && x.modelMs > 0).map((x) => x.wallMs / x.modelMs);
  return { n, merge_rate: r(per(rows.filter((x) => x.merged).length, n)), needs_human_rate: r(per(rows.filter((x) => x.needsHuman).length, n)),
    first_pass_rate: r(per(fp.filter((x) => x.firstPass).length, fp.length)), median_cost_usd: r(median(rows.map((x) => x.cost)), 1e4),
    median_wall_min: r(median(rows.map((x) => (x.wallMs == null ? null : x.wallMs / 60000))), 100), median_wall_over_model: r(median(ratios), 100),
    findings_per_lane: r(per(rows.reduce((a, x) => a + x.findings, 0), n), 100), share_with_findings: r(per(rows.filter((x) => x.findings > 0).length, n)),
    conformance_failure_rate: r(per(rows.filter((x) => x.conformanceFailures > 0).length, n)),
    defects_n: known.length, defect_rate: known.length ? r(per(known.filter((x) => defects.get(x.issue).defect).length, known.length)) : null };
}

const check = (value, limit, nT, nC, minN, cmp) => {
  if (nT < minN || (nC != null && nC < minN) || value == null) return { value: r(value, 100), limit, n_treatment: nT, ...(nC != null ? { n_control: nC } : {}), met: null, verdict: INSUFFICIENT };
  const met = cmp(value, limit);
  return { value: r(value, 100), limit, n_treatment: nT, ...(nC != null ? { n_control: nC } : {}), met, verdict: met ? "met" : "not met" };
};

/**
 * The #5052 promotion verdict: treatment = light-shaped lanes (light or upgraded: the true cost of trying light);
 * control = full-shape lanes the gate rated eligible, in the size buckets both cohorts have (#4491 matched sizes).
 */
export function promotion(rows, defects = new Map(), minN = DEFAULT_MIN_N) {
  const sz = (x) => x.size ?? "unknown";
  const t0 = rows.filter((x) => x.shape === "light" || x.shape === "upgraded"), c0 = rows.filter((x) => x.shape === "full" && x.verdict === "eligible");
  const sizes = [...new Set(t0.map(sz))].filter((s) => c0.some((x) => sz(x) === s)).sort();
  const t = t0.filter((x) => sizes.includes(sz(x))), c = c0.filter((x) => sizes.includes(sz(x)));
  const tc = depthCell(t, defects), cc = depthCell(c, defects);
  const cost = check(tc.median_cost_usd != null && cc.median_cost_usd > 0 ? tc.median_cost_usd / cc.median_cost_usd : null, PROMOTION.costRatio, t.length, c.length, minN, (v, l) => v <= l);
  const wallRows = t0.filter((x) => x.wallMs != null && x.modelMs > 0);
  const wall = check(median(wallRows.map((x) => x.wallMs / x.modelMs)), PROMOTION.wallOverModel, wallRows.length, null, minN, (v, l) => v <= l);
  const defect = tc.defect_rate != null && cc.defect_rate != null && tc.defects_n >= minN && cc.defects_n >= minN
    ? { value: tc.defect_rate, limit: cc.defect_rate, n_treatment: tc.defects_n, n_control: cc.defects_n, met: tc.defect_rate <= cc.defect_rate, verdict: tc.defect_rate <= cc.defect_rate ? "met" : "not met" }
    : { value: tc.defect_rate, limit: cc.defect_rate, n_treatment: tc.defects_n, n_control: cc.defects_n, met: null, verdict: INSUFFICIENT };
  const checks = { cost, wall, defects: defect };
  const vs = Object.values(checks).map((x) => x.met);
  const met = vs.includes(false) ? false : vs.every((x) => x === true) ? true : INSUFFICIENT;
  return { met, sizes, n_treatment: t.length, n_control: c.length, min_n: minN, checks, note: "flipping lean.light.mode: on stays a config decision" };
}

/**
 * The promotion recommendation from shadow data (#5318): eligible share of lanes, would-be saving (eligible full lanes x
 * the median cost gap to light-shaped lanes) and the defect rate on eligible lanes. The decision follows promotion().met.
 */
export function recommendation(rows, defects, prom) {
  const elig = rows.filter((x) => x.verdict === "eligible"), full = elig.filter((x) => x.shape === "full");
  const light = rows.filter((x) => x.shape === "light" || x.shape === "upgraded");
  const fullMed = median(full.map((x) => x.cost)), lightMed = median(light.map((x) => x.cost));
  const saving = fullMed != null && lightMed != null ? r(full.length * (fullMed - lightMed), 100) : null;
  const decision = prom.met === true ? "promote" : prom.met === false ? "do not promote" : INSUFFICIENT;
  return { decision, eligible_share: r(per(elig.length, rows.length)), eligible_n: elig.length, would_be_saving_usd: saving, eligible_defect_rate: depthCell(elig, defects).defect_rate };
}

/**
 * #5426: fast-forward eligibility (the investigation decided the depth) and the outcomes of fast-forwarded lanes. Lanes with a
 * FASTFORWARD_ELIGIBILITY event are the base; `fast_forwarded` = a non-shadow eligible lane that ended light (LIGHT_DONE),
 * `upgraded` = one that fell back to the full lane. Merged lanes carry their post-merge defect and revert signals.
 */
export function fastForwardReport(rows, defects = new Map()) {
  const withFf = rows.filter((x) => x.ff);
  const elig = withFf.filter((x) => x.ff.eligible), live = elig.filter((x) => !x.ff.shadow);
  const cell = (xs) => {
    const known = xs.filter((x) => x.merged && typeof defects.get(x.issue)?.revert === "boolean");
    return { ...depthCell(xs, defects), reverts_n: known.length, revert_rate: known.length ? r(per(known.filter((x) => defects.get(x.issue).revert).length, known.length)) : null };
  };
  return { lanes: withFf.length, eligible_n: elig.length, eligibility_rate: r(per(elig.length, withFf.length)), shadow_n: withFf.filter((x) => x.ff.shadow).length,
    fast_forwarded: cell(live.filter((x) => x.shape === "light")), upgraded: cell(live.filter((x) => x.shape === "upgraded")), full_lane: cell(withFf.filter((x) => !x.ff.eligible || x.ff.shadow)) };
}

/** Pure report: per verdict, per reason/signal code, and the promotion verdict. */
export function depthReport({ rows = [], defects = new Map(), minN = DEFAULT_MIN_N, defectsSource = "github" } = {}) {
  const byVerdict = {};
  for (const v of [...VERDICTS, ...new Set(rows.map((x) => x.verdict).filter((v) => !VERDICTS.includes(v)))]) {
    const xs = rows.filter((x) => x.verdict === v);
    if (xs.length || VERDICTS.includes(v)) byVerdict[v] = depthCell(xs, defects);
  }
  const byCode = {};
  for (const code of [...new Set(rows.flatMap((x) => [...x.reasons, ...x.signals]))].sort()) byCode[code] = depthCell(rows.filter((x) => x.reasons.includes(code) || x.signals.includes(code)), defects);
  const prom = promotion(rows, defects, minN);
  const unresolved = rows.filter((x) => x.merged && defects.get(x.issue)?.defect === null).length;
  return { lanes: rows.length, min_n: minN, defects_source: defectsSource, defects_unresolved: unresolved, by_verdict: byVerdict, by_code: byCode, promotion: prom, recommendation: recommendation(rows, defects, prom), fast_forward: fastForwardReport(rows, defects) };
}

const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const val = (x, unit = "") => (x == null ? "n/a" : `${x}${unit}`);
const cellLine = (label, c) => `  ${label}: n=${c.n}, merge ${pct(c.merge_rate)}, first-pass ${pct(c.first_pass_rate)}, needs-human ${pct(c.needs_human_rate)}, `
  + `median cost ${c.median_cost_usd == null ? "n/a" : `$${c.median_cost_usd.toFixed(4)}`}, wall ${val(c.median_wall_min, " min")}, findings/lane ${val(c.findings_per_lane)} `
  + `(${pct(c.share_with_findings)} with any), conformance failures ${pct(c.conformance_failure_rate)}, post-merge defects ${pct(c.defect_rate)} (n=${c.defects_n})`;

/** Text lines of depthReport. */
export function renderDepth(rep, { repo = null, since = null } = {}) {
  const out = [`lane depth${repo ? ` ${repo}` : ""}${since ? ` since ${since}` : ""}: ${rep.lanes} lane(s) with a light-eligibility verdict; defect signals: ${rep.defects_source}${rep.defects_unresolved ? `, ${rep.defects_unresolved} unresolved (n/a: same-hunks needs a local clone of the repo)` : ""}`];
  out.push("by verdict:");
  for (const [v, c] of Object.entries(rep.by_verdict)) out.push(cellLine(v, c));
  out.push("by reason/signal:");
  const codes = Object.entries(rep.by_code);
  if (!codes.length) out.push("  n/a");
  for (const [k, c] of codes) out.push(cellLine(k, c));
  const p = rep.promotion, ck = p.checks;
  const fmt = (name, x, unit) => `  ${name}: ${x.verdict}${x.value == null ? "" : ` (${x.value}${unit} vs ${x.limit}${unit})`}, n treatment=${x.n_treatment}${x.n_control != null ? `, n control=${x.n_control}` : ""}`;
  out.push(`light-lane promotion (#5052, min n ${p.min_n} per cell): ${p.met === true ? "met" : p.met === false ? "not met" : INSUFFICIENT}`
    + ` (treatment light|upgraded n=${p.n_treatment}, control eligible full n=${p.n_control}, sizes ${p.sizes.length ? p.sizes.join(",") : "none"})`);
  out.push(fmt("cost ratio", ck.cost, "x"), fmt("wall/model", ck.wall, "x"), fmt("defect rate", ck.defects, ""));
  out.push(`  ${p.note}`);
  const ff = rep.fast_forward;
  if (ff?.lanes) {
    out.push(`fast-forward (#5426, investigation decides depth): ${ff.lanes} lane(s) with an investigation verdict, eligible ${pct(ff.eligibility_rate)} (n=${ff.eligible_n}, ${ff.shadow_n} shadow)`);
    for (const [k, c] of [["fast-forwarded", ff.fast_forwarded], ["upgraded to full", ff.upgraded], ["full lane", ff.full_lane]]) out.push(`${cellLine(k, c)}, reverts ${pct(c.revert_rate)} (n=${c.reverts_n})`);
  }
  const rc = rep.recommendation;
  if (rc) out.push(`recommendation: ${rc.decision}; eligible share ${pct(rc.eligible_share)} (n=${rc.eligible_n}), would-be saving ${rc.would_be_saving_usd == null ? "n/a" : `$${rc.would_be_saving_usd.toFixed(2)}`} over the window, defect rate on eligible lanes ${pct(rc.eligible_defect_rate)}`);
  return out.join("\n");
}

/** Every run log under `runsDir` -> rows -> defects (gh, unless null) -> report. */
export async function buildDepth({ runsDir, repo = null, sinceMs = null, gh = null, minN = DEFAULT_MIN_N, now = null, env = process.env, useCache = false, refresh = false, onProgress = null, git = null } = {}) {
  const rows = [];
  if (runsDir && existsSync(runsDir)) {
    for (const f of readdirSync(runsDir).filter((x) => x.endsWith(".jsonl")).sort()) {
      let text = "";
      try { text = readFileSync(join(runsDir, f), "utf8"); } catch { continue; }
      const n = /^(\d+)\.jsonl$/.exec(f);
      rows.push(...depthRows(parseLog(text), { repo, sinceMs, issue: n ? Number(n[1]) : null }));
    }
  }
  const defects = gh ? await gatherDefects({ repo, gh, rows, now, env, useCache, refresh, onProgress, git }) : new Map();
  return depthReport({ rows, defects, minN, defectsSource: gh ? "github" : "offline" });
}
