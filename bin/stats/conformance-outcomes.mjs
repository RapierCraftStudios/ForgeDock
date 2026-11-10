// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5210: `forgedock stats --conformance-outcomes`: do conformance blocks predict post-merge defects?
 * Each merged lane PR (a merged PR with a conformance verdict, query.mjs conformanceVerdicts) is joined to four post-merge
 * defect signals inside `windowDays` of its merge:
 *   reverted    a later merged PR titled `Revert ...` that names the PR (`Reverts o/r#N`, `#N`) or its title
 *   reopened    a closing issue of the PR reopened after the merge
 *   cited       a later merged PR whose title or body cites the PR or its issue as the cause ("fix ... #N", "review-finding ... #N")
 *   same_hunks  a later fix PR whose old-side lines git-blame to this PR's merge commit (local git, compounding.mjs gitProbes;
 *               null when git cannot resolve, e.g. the cwd is not a clone of the repo)
 * It prints, per repo and per failure kind, the defect rate of nonconforming-merged versus conforming-merged lane PRs with n
 * and a Wilson 95% interval; a cell under min n prints n/a. Read only: GitHub reads are one GraphQL search per page of 100
 * merged PRs, no writes. The report core is pure; `gatherConformanceOutcomes` supplies the GitHub and git inputs.
 */
import { pathDomains, riskClassOf, riskPathHits, parseEnforceDomains, parseRiskPaths } from "../lean/review-trigger.mjs";

export const DEFAULT_OUTCOME_MIN_N = 20;
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_LOOKBACK_DAYS = 30;
export const PAGE_SIZE = 100;
export const SIGNALS = ["reverted", "reopened", "cited", "same_hunks"];
export const OUTCOME_INSUFFICIENT = "insufficient data";
export const HIGHER = "nonconforming merges show a higher defect rate";
export const NOT_HIGHER = "no higher defect rate shown for nonconforming merges";
const DAY = 86400000;
const ms = (ts) => { const t = Date.parse(ts ?? ""); return Number.isFinite(t) ? t : null; };
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wilson score interval [low, high] for k successes of n (z = 1.96, 95%); null when n is 0. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [r4(Math.max(0, c - h)), r4(Math.min(1, c + h))];
}

/** One 2x2 cell: n, defects, rate and interval; rate and interval are null (insufficient) under minN. */
export function cell(rows, minN) {
  const n = rows.length, defects = rows.filter((r) => r.defect).length;
  const insufficient = n < minN;
  return { n, defects, rate: insufficient || !n ? null : r4(defects / n), interval: insufficient ? null : wilson(defects, n), insufficient };
}

/** "higher" when the nonconforming interval lies wholly above the conforming one; "insufficient data" when a cell is under min n. */
export function conclude(nonconforming, conforming) {
  if (nonconforming.insufficient || conforming.insufficient || !nonconforming.interval || !conforming.interval) return OUTCOME_INSUFFICIENT;
  return nonconforming.interval[0] > conforming.interval[1] ? HIGHER : NOT_HIGHER;
}

function twoByTwo(rows, minN) {
  const nonconforming = cell(rows.filter((r) => r.state === "nonconforming"), minN), conforming = cell(rows.filter((r) => r.state === "conforms"), minN);
  return { nonconforming, conforming, conclusion: conclude(nonconforming, conforming) };
}

/** Numbers that identify `p` as a cause: the PR and its closing issues. */
const refsOf = (p) => [p.number, ...(p.closingIssues ?? []).map((i) => i.number)].filter((x) => Number.isSafeInteger(x));
const text = (q) => `${q.title ?? ""}\n${q.body ?? ""}`;
const isRevert = (q) => /^revert\b/i.test(q.title ?? "");
export const isFix = (q) => /^(fix|hotfix|bugfix)\b/i.test(q.title ?? "") || /^revert\b/i.test(q.title ?? "");

/** True when a later PR `q` reverts `p`. */
export function reverts(q, p, repo) {
  if (!isRevert(q)) return false;
  const t = text(q);
  if (repo && new RegExp(`Reverts\\s+${esc(repo)}#${p.number}\\b`, "i").test(t)) return true;
  if (new RegExp(`(^|[^\\w/])#${p.number}\\b`).test(t)) return true;
  return Boolean(p.title) && (q.title ?? "").includes(`"${p.title}"`);
}

/** True when a later PR `q` cites `p` (or its issue) as the cause: "fix ... #N" or "review-finding ... #N" on one line. */
export function cites(q, p) {
  if (isRevert(q)) return false;
  for (const n of refsOf(p)) {
    const re = new RegExp(`(\\bfix(e[sd])?\\b|review[- ]finding)[^\\n]*?(^|[^\\w/])#${n}\\b`, "im");
    if (re.test(text(q))) return true;
  }
  return false;
}

const blameMemo = new WeakMap();

/** Merge shas that a fix PR's old-side lines blame to, computed once per fix sha per git probe object (#5372); null when unresolved. */
function blamedBy(q, git) {
  let memo = blameMemo.get(git);
  if (!memo) blameMemo.set(git, (memo = new Map()));
  if (memo.has(q.mergeSha)) return memo.get(q.mergeSha);
  const ranges = q.mergeSha ? git.oldRanges(q.mergeSha) : null;
  let set = ranges ? new Set() : null;
  for (const r of ranges ?? []) {
    const shas = git.blame(`${q.mergeSha}^`, r.file, r.start, r.end);
    if (shas == null) { set = null; break; }
    for (const s of shas) set.add(s);
  }
  memo.set(q.mergeSha, set);
  return set;
}

/** Blame each fix PR once up front, reporting {phase: "same-hunks", done, total, etaMs} so a long run is not silent. */
export function warmSameHunks(fixes, git, onProgress, now = Date.now) {
  const todo = fixes.filter((q) => q.mergeSha);
  const t0 = now();
  todo.forEach((q, i) => {
    blamedBy(q, git);
    const done = i + 1;
    onProgress?.({ phase: "same-hunks", done, total: todo.length, etaMs: done < todo.length ? ((now() - t0) / done) * (todo.length - done) : 0 });
  });
}

/**
 * Same-hunks: a later fix PR whose old-side lines blame to `p`'s merge commit. true on a hit, false when every later fix PR
 * resolved without one (or there is none), null when git is missing or a needed probe could not resolve. Each fix PR is
 * blamed once per git probe object, not once per lane PR.
 */
export function sameHunks(p, laterFixes, git) {
  if (!laterFixes.length) return false;
  if (!git || !p.mergeSha) return null;
  let unresolved = false;
  for (const q of laterFixes) {
    const set = blamedBy(q, git);
    if (!set) { unresolved = true; continue; }
    if (set.has(p.mergeSha)) return true;
  }
  return unresolved ? null : false;
}

/**
 * The report core (pure). prs: merged PRs [{repo, number, title, body, mergedAt, mergeSha, closingIssues: [{number, reopenedAt: [ts]}]}];
 * verdicts: Map from conformanceVerdicts (keys pr:N, issue:N). A PR whose window has not elapsed by `now` is pending and left
 * out of the cells. A PR with no verdict is not a lane PR.
 */
export function conformanceOutcomes({ prs = [], verdicts = new Map(), minN = DEFAULT_OUTCOME_MIN_N, windowDays = DEFAULT_WINDOW_DAYS, now = Date.now(), git = null, graphqlCalls = null, since = null, surfacesOf = surfacesOfFiles, onProgress = null }) {
  const win = windowDays * DAY;
  const merged = prs.filter((p) => ms(p.mergedAt) != null).sort((a, b) => ms(a.mergedAt) - ms(b.mergedAt));
  const sinceMs = ms(since);
  if (git) warmSameHunks(merged.filter((q) => isFix(q) && (sinceMs == null || ms(q.mergedAt) >= sinceMs)), git, onProgress);
  const rows = [];
  let unjoined = 0, pending = 0, unresolved = 0;
  for (const p of merged) {
    const t = ms(p.mergedAt);
    if (sinceMs != null && t < sinceMs) continue;
    const v = verdicts.get(`pr:${p.number}`) ?? refsOf(p).slice(1).map((i) => verdicts.get(`issue:${i}`)).find(Boolean) ?? null;
    if (!v) { unjoined++; continue; }
    if (t + win > now) { pending++; continue; }
    const later = merged.filter((q) => q !== p && q.number !== p.number && (p.repo == null || q.repo == null || q.repo === p.repo) && ms(q.mergedAt) > t && ms(q.mergedAt) <= t + win);
    const signals = {
      reverted: later.some((q) => reverts(q, p, p.repo)),
      reopened: (p.closingIssues ?? []).some((i) => (i.reopenedAt ?? []).some((ts) => ms(ts) > t && ms(ts) <= t + win)),
      cited: later.some((q) => cites(q, p)),
      same_hunks: sameHunks(p, later.filter(isFix), git),
    };
    if (signals.same_hunks === null) unresolved++;
    rows.push({ repo: p.repo ?? null, pr: p.number, issue: v.issue ?? null, merged_at: p.mergedAt, mode: v.mode ?? null, state: v.state, kinds: v.kinds ?? [],
      source: v.source ?? null, signals, defect: SIGNALS.some((s) => signals[s] === true), ...(p.files?.length ? { surfaces: surfacesOf(p.files) } : {}) });
  }
  const repos = {};
  for (const repo of [...new Set(rows.map((r) => r.repo ?? "unknown"))].sort()) {
    const rs = rows.filter((r) => (r.repo ?? "unknown") === repo);
    const kinds = [...new Set(rs.flatMap((r) => (r.state === "nonconforming" ? r.kinds : [])))].sort();
    const confRows = rs.filter((r) => r.state === "conforms");
    const by_kind = {};
    for (const k of kinds) {
      const nonconforming = cell(rs.filter((r) => r.state === "nonconforming" && r.kinds.includes(k)), minN), conforming = cell(confRows, minN);
      by_kind[k] = { nonconforming, conforming, conclusion: conclude(nonconforming, conforming) };
    }
    const by_mode = {};
    for (const m of [...new Set(rs.map((r) => r.mode ?? "unknown"))].sort()) by_mode[m] = twoByTwo(rs.filter((r) => (r.mode ?? "unknown") === m), minN);
    const by_surface = {};
    for (const sf of [...new Set(rs.flatMap((r) => r.surfaces ?? []))].sort()) by_surface[sf] = twoByTwo(rs.filter((r) => r.surfaces?.includes(sf)), minN);
    repos[repo] = { overall: twoByTwo(rs, minN), by_kind, by_mode, by_surface };
  }
  const overall = twoByTwo(rows, minN);
  return {
    window_days: windowDays, min_n: minN, since: since ?? null,
    sources: { merged_prs: merged.length, lane_prs: rows.length, pending, unjoined, same_hunks_unresolved: unresolved, git: Boolean(git), graphql_calls: graphqlCalls },
    repos, overall, conclusion: overall.conclusion, prs: rows,
  };
}

/** #5283: the risk surfaces a PR's files touch: `domain:<d>` (review-roster path rules) and `risk:<class>` (built-in risk words). */
export function surfacesOfFiles(files = []) {
  const domains = pathDomains(files) ?? [];
  const classes = files.map(riskClassOf).filter(Boolean);
  return [...new Set([...domains.map((d) => `domain:${d}`), ...classes.map((c) => `risk:${c}`)])].sort();
}

/**
 * #5283: replay named PRs against a would-be enforcement config (review.enforce_domains / review.risk_paths), window-free.
 * Per PR: `enforced` = a configured surface was hit and the shadow verdict is nonconforming (the lane would block);
 * `flagged` = a configured surface was hit but the verdict would pass (enforce cannot block a passing review);
 * `none` = no configured surface hit. `missing` lists numbers not among `prs`.
 */
export function replayPrs({ prs = [], verdicts = new Map(), numbers = [], enforceDomains = [], riskPaths = [], surfacesOf = surfacesOfFiles }) {
  const doms = parseEnforceDomains(enforceDomains), globs = parseRiskPaths(riskPaths);
  const rows = [], missing = [];
  for (const n of numbers) {
    const p = prs.find((x) => x.number === n);
    if (!p) { missing.push(n); continue; }
    const v = verdicts.get(`pr:${n}`) ?? (p.closingIssues ?? []).map((i) => verdicts.get(`issue:${i.number}`)).find(Boolean) ?? null;
    const surfaces = surfacesOf(p.files ?? []);
    const hits = [...surfaces.filter((s) => s.startsWith("domain:") && doms.includes(s.slice(7))), ...riskPathHits(p.files ?? [], globs).map((f) => `path:${f}`)];
    const state = v?.state ?? null;
    rows.push({ repo: p.repo ?? null, pr: n, mode: v?.mode ?? null, state, surfaces, hits, outcome: !hits.length ? "none" : state === "nonconforming" ? "enforced" : "flagged" });
  }
  return { enforce_domains: doms, risk_paths: globs, prs: rows, missing };
}

export function renderReplay(r) {
  const out = [`replay (enforce_domains: ${r.enforce_domains.join(",") || "-"}; risk_paths: ${r.risk_paths.join(",") || "-"})`, "", "| PR | mode | shadow verdict | surfaces | outcome |", "|---|---|---|---|---|",
    ...r.prs.map((x) => `| #${x.pr} | ${x.mode ?? "n/a"} | ${x.state ?? "no verdict"} | ${x.surfaces.join(", ") || "-"} | ${x.outcome} |`)];
  if (r.missing.length) out.push("", `not found in the fetched PRs (widen --since): ${r.missing.map((n) => `#${n}`).join(", ")}`);
  return out.join("\n");
}

const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const fmtCell = (c) => `${c.defects}/${c.n} ${pct(c.rate)}${c.interval ? ` [${pct(c.interval[0])}, ${pct(c.interval[1])}]` : ""}`;
const row = (label, x) => `| ${label} | ${fmtCell(x.nonconforming)} | ${fmtCell(x.conforming)} | ${x.conclusion} |`;
const HEAD = ["| group | nonconforming-merged defects/n rate [95% CI] | conforming-merged defects/n rate [95% CI] | verdict |", "|---|---|---|---|"];

export function renderConformanceOutcomes(r) {
  const s = r.sources;
  const out = [`conformance outcomes: ${s.lane_prs} lane PRs of ${s.merged_prs} merged (${s.unjoined} without a verdict, ${s.pending} with an open ${r.window_days}d window), min n ${r.min_n}`
    + `, same-hunks ${s.git ? `${s.same_hunks_unresolved} unresolved` : "n/a (no local clone of the repo)"}${s.graphql_calls != null ? `, ${s.graphql_calls} GraphQL call(s)` : ""}`];
  for (const [repo, x] of Object.entries(r.repos)) {
    out.push("", `## ${repo}`, "", ...HEAD, row("all", x.overall), ...Object.entries(x.by_mode).map(([m, y]) => row(`mode ${m}`, y)),
      ...Object.entries(x.by_kind).map(([k, y]) => row(`kind ${k}`, y)), ...Object.entries(x.by_surface ?? {}).map(([k, y]) => row(`surface ${k}`, y)));
  }
  if (!Object.keys(r.repos).length) out.push("", "no merged lane PR with an elapsed window");
  out.push("", `conclusion: ${r.conclusion}`);
  return out.join("\n");
}

const QUERY = `query($q: String!, $first: Int!, $after: String) {
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title body mergedAt mergeCommit { oid } repository { nameWithOwner } files(first: 100) { nodes { path } }
      closingIssuesReferences(first: 10) { nodes { number timelineItems(itemTypes: [REOPENED_EVENT], first: 10) { nodes { ... on ReopenedEvent { createdAt } } } } } } }
  }
}`;

/** Sorted unique PR and closing-issue numbers of `prs`: the only items whose telemetry the report needs (#5363). */
export const joinedNumbers = (prs = []) => [...new Set(prs.flatMap(refsOf))].sort((a, b) => a - b);

/** One GraphQL search page -> normalized PRs. */
export function prsOfPage(data, repo) {
  return (data?.data?.search?.nodes ?? []).filter((n) => Number.isSafeInteger(n?.number) && n.mergedAt).map((n) => ({
    repo: n.repository?.nameWithOwner ?? repo, number: n.number, title: n.title ?? "", body: n.body ?? "", mergedAt: n.mergedAt, mergeSha: n.mergeCommit?.oid ?? null,
    files: (n.files?.nodes ?? []).map((f) => f?.path).filter(Boolean),
    closingIssues: (n.closingIssuesReferences?.nodes ?? []).filter((i) => Number.isSafeInteger(i?.number))
      .map((i) => ({ number: i.number, reopenedAt: (i.timelineItems?.nodes ?? []).map((e) => e?.createdAt).filter(Boolean) })),
  }));
}

/**
 * Read-only GitHub input: merged PRs of `repo` since `since` (ISO; default DEFAULT_LOOKBACK_DAYS before now) up to now, so later
 * reverts and fixes inside the window are in the candidate set. Exactly one `gh api graphql` search call per page of 100 PRs.
 * GitHub search returns at most 1000 results: `capped` reports when that bound was hit.
 */
const MIN_PAGE_SIZE = 25;
export async function gatherConformanceOutcomes({ repo, gh, since = null, now = Date.now() }) {
  const from = (since ? new Date(ms(since) ?? now - DEFAULT_LOOKBACK_DAYS * DAY) : new Date(now - DEFAULT_LOOKBACK_DAYS * DAY)).toISOString().slice(0, 10);
  const q = `repo:${repo} is:pr is:merged merged:>=${from}`;
  const prs = [];
  let after = null, calls = 0, capped = false, size = PAGE_SIZE;
  for (;;) {
    let data;
    for (;;) { // #5363: a 502/timeout retries the same cursor with half the page (100 -> 50 -> 25), then fails
      const args = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `q=${q}`, "-F", `first=${size}`, ...(after ? ["-f", `after=${after}`] : [])];
      calls++;
      try { data = JSON.parse(String(await gh(args) ?? "").trim() || "{}"); break; } catch (err) {
        if (!/\b50[234]\b|bad gateway|timed? ?out|timeout|ETIMEDOUT/i.test(String(err?.message ?? err))) throw err;
        if (size <= MIN_PAGE_SIZE) throw new Error(`GitHub keeps failing the PR search at first=${size} (${String(err?.message ?? err).split("\n")[0]}); retry with a narrower --since`);
        size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
      }
    }
    if (Array.isArray(data.errors) && data.errors.length && !data.data) throw new Error(`GraphQL: ${data.errors.map((e) => e?.message).join("; ")}`);
    prs.push(...prsOfPage(data, repo));
    const pi = data?.data?.search?.pageInfo;
    if (!pi?.hasNextPage || !pi.endCursor) break;
    if (prs.length >= 1000) { capped = true; break; }
    after = pi.endCursor;
  }
  return { prs, graphqlCalls: calls, since: `${from}T00:00:00Z`, capped };
}
