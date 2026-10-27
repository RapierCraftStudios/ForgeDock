// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #4696: compounding metrics for `forgedock stats --compounding`: does a repo get safer the longer ForgeDock works on it.
 * Deterministic (0 LLM calls): guards (#4692 FORGE:GUARD comments), `reopened` issue events, git blame, and gate events
 * from the FORGE:TELEMETRY records. The report core is pure; `gatherCompounding` supplies the GitHub and git inputs.
 *   reintroduction: a guarded fix whose issue was reopened after the lane closed it (a), or whose merge commit is the blame
 *     of the old-side lines of a later guarded fix within 90 days (b; squash and rebase merges, where merge_sha is the commit)
 *   reopen_after_close: lane-closed (merged) issues that were reopened afterwards
 *   guard / decision counts: gate events guard_run, guard_broken, supersedes_accepted, decision_superseded,
 *     decision_violation (#4693, #4695); null (n/a) until a repo has recorded any of that kind
 * Grouped as a rolling window, per release and per lane-age bucket (lane rank = merge order of the repo's lanes).
 */
import { execFileSync } from "node:child_process";
import { collectGuards } from "../lean/guards.mjs";
import { parsePages } from "./github-source.mjs";

export const REINTRO_DAYS = 90;
export const DEFAULT_BUCKETS = [100, 500];
export const DEFAULT_WINDOW_MS = 30 * 86400000;
export const COUNTED_EVENTS = ["guard_run", "guard_broken", "supersedes_accepted", "decision_superseded", "decision_violation"];
const DAY = 86400000;
const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
const ms = (ts) => { const t = Date.parse(ts ?? ""); return Number.isFinite(t) ? t : null; };

export const bucketLabel = (rank, edges) => {
  if (rank == null) return "unranked";
  let lo = 1;
  for (const e of edges) { if (rank <= e) return `${lo}-${e}`; lo = e + 1; }
  return `${lo}+`;
};

/** Guards whose fixed lines a later guarded fix changed within 90 days: [{fix, by}] (fix = earlier guard's issue). Git probes may return null (unresolved). */
export function blameLineage(guards, git) {
  const t = new Map(), hits = [];
  const time = (g) => { if (!t.has(g.merge_sha)) t.set(g.merge_sha, git.time(g.merge_sha)); return t.get(g.merge_sha); };
  const byCommit = new Map(guards.filter((g) => g.merge_sha).map((g) => [g.merge_sha, g]));
  let unresolved = 0;
  for (const g2 of guards) {
    if (!g2.merge_sha) { unresolved++; continue; }
    const ranges = git.oldRanges(g2.merge_sha);
    if (!ranges) { unresolved++; continue; }
    const seen = new Set();
    for (const r of ranges) for (const sha of git.blame(`${g2.merge_sha}^`, r.file, r.start, r.end) ?? []) {
      const g1 = byCommit.get(sha);
      if (!g1 || g1.issue === g2.issue || seen.has(g1.issue)) continue;
      const a = time(g1), b = time(g2);
      if (a == null || b == null || b < a || b - a > REINTRO_DAYS * 86400) continue;
      seen.add(g1.issue); hits.push({ fix: g1.issue, by: g2.issue });
    }
  }
  return { hits, unresolved };
}

/** Metrics of one group of lane entries and the gate events falling in it. */
function summarize(entries, events, have, minN) {
  const guarded = entries.filter((e) => e.guarded), lanes = entries.filter((e) => e.merged);
  const count = (k) => (have[k] ? events.filter((e) => e.event === k).length : null);
  return {
    lanes: lanes.length,
    reopen_after_close: { reopened: lanes.filter((e) => e.reopened).length, rate: ratio(lanes.filter((e) => e.reopened).length, lanes.length) },
    reintroduction: { guarded: guarded.length, reintroduced: guarded.filter((e) => e.reintroduced).length, rate: ratio(guarded.filter((e) => e.reintroduced).length, guarded.length) },
    guard: { tests_run: count("guard_run"), broken_caught: count("guard_broken"), supersedes_accepted: count("supersedes_accepted") },
    decisions: { superseded: count("decision_superseded"), violations: count("decision_violation") },
    low_n: Math.max(lanes.length, guarded.length) < minN,
  };
}

/**
 * Pure report. guards: parsed FORGE:GUARD objects; reopens: [{issue, ts}]; runs: toModel runs; events: toModel gate events;
 * git: {time(sha)->epoch s|null, oldRanges(sha)->[{file,start,end}]|null, blame(rev,file,start,end)->[sha]|null}.
 */
export function compoundingReport({ guards = [], reopens = [], runs = [], events = [], git, windowMs = DEFAULT_WINDOW_MS, buckets = DEFAULT_BUCKETS, now = Date.now(), minN = 10 }) {
  const merged = runs.filter((r) => r.reason === "merged").sort((a, b) => (ms(a.endTs) ?? 0) - (ms(b.endTs) ?? 0) || a.issue - b.issue);
  const byIssue = new Map(merged.map((r, i) => [r.issue, { issue: r.issue, merged: true, rank: i + 1, version: r.version ?? null, at: ms(r.endTs), guarded: false, reopened: false, reintroduced: false }]));
  const gset = new Map();
  for (const g of guards) if (!gset.has(g.issue)) gset.set(g.issue, g);
  const uniq = [...gset.values()];
  for (const g of uniq) {
    const e = byIssue.get(g.issue) ?? { issue: g.issue, merged: false, rank: null, version: null, at: null, guarded: false, reopened: false, reintroduced: false };
    e.guarded = true;
    const secs = git?.time && g.merge_sha ? git.time(g.merge_sha) : null;
    if (e.at == null && secs != null) e.at = secs * 1000;
    byIssue.set(g.issue, e);
  }
  for (const e of byIssue.values()) { // (a) and reopen-after-close: a reopen after the lane closed the issue
    e.reopened = reopens.some((r) => r.issue === e.issue && (e.at == null || (ms(r.ts) ?? 0) > e.at));
    if (e.guarded && e.reopened) e.reintroduced = true;
  }
  const lineage = git && uniq.length ? blameLineage(uniq, git) : { hits: [], unresolved: uniq.length };
  for (const h of lineage.hits) if (byIssue.has(h.fix)) byIssue.get(h.fix).reintroduced = true;
  const entries = [...byIssue.values()];
  const have = Object.fromEntries(COUNTED_EVENTS.map((k) => [k, events.some((e) => e.event === k)]));
  const evMs = (e) => ms(e.ts);
  const out = { rolling: null, by_release: {}, by_lane_age: {}, sources: { guards: uniq.length, reopens: reopens.length, blame_hits: lineage.hits.length, blame_unresolved: lineage.unresolved }, buckets };
  out.rolling = { window_days: Math.round(windowMs / DAY), ...summarize(entries.filter((e) => e.at != null && now - e.at <= windowMs && e.at <= now),
    events.filter((e) => evMs(e) != null && now - evMs(e) <= windowMs && evMs(e) <= now), have, minN) };
  const versions = [...new Set([...entries.map((e) => e.version), ...events.map((e) => e.version)].filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const v of versions) out.by_release[v] = summarize(entries.filter((e) => e.version === v), events.filter((e) => e.version === v), have, minN);
  const labels = [...new Set(entries.map((e) => bucketLabel(e.rank, buckets)))];
  const order = (l) => (l === "unranked" ? Infinity : Number.parseInt(l, 10));
  for (const l of labels.sort((a, b) => order(a) - order(b))) {
    const inB = entries.filter((e) => bucketLabel(e.rank, buckets) === l);
    const evs = events.filter((e) => { const r = byIssue.get(e.issue); return r && bucketLabel(r.rank, buckets) === l; });
    out.by_lane_age[l] = summarize(inB, evs, have, minN);
  }
  return out;
}

const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const n = (x) => (x == null ? "n/a" : String(x));
function line(label, s) {
  return `  ${label}: ${s.lanes} lanes, reintroduction ${pct(s.reintroduction.rate)} (${s.reintroduction.reintroduced}/${s.reintroduction.guarded}), reopen-after-close ${pct(s.reopen_after_close.rate)}, `
    + `guard runs ${n(s.guard.tests_run)} broken ${n(s.guard.broken_caught)} supersedes ${n(s.guard.supersedes_accepted)}, decisions superseded ${n(s.decisions.superseded)} violations ${n(s.decisions.violations)}${s.low_n ? " (low n)" : ""}`;
}

export function renderCompounding(r) {
  const rows = [`compounding: ${r.sources.guards} guards, ${r.sources.reopens} reopen events, ${r.sources.blame_hits} blame hits (${r.sources.blame_unresolved} guards unresolved)`,
    line(`rolling ${r.rolling.window_days}d`, r.rolling), "by lane age:", ...Object.entries(r.by_lane_age).map(([k, s]) => line(k, s))];
  const rel = Object.entries(r.by_release);
  return [...rows, "by release:", ...(rel.length ? rel.map(([k, s]) => line(k, s)) : ["  n/a"])].join("\n");
}

const tryGit = (cwd, args) => { try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; } };

/** git probes over a local clone; every miss (unknown sha, shallow clone) is null, never a thrown error. */
export function gitProbes(cwd) {
  return {
    time: (sha) => { const t = Number(tryGit(cwd, ["show", "-s", "--format=%ct", sha])?.trim()); return Number.isFinite(t) && t > 0 ? t : null; },
    oldRanges: (sha) => {
      const d = tryGit(cwd, ["diff", "-U0", "--no-renames", `${sha}^`, sha]);
      if (d == null) return null;
      const out = []; let file = null;
      for (const l of d.split("\n")) {
        if (l.startsWith("--- ")) { file = l === "--- /dev/null" ? null : l.replace(/^--- a\//, ""); continue; }
        const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(l);
        if (m && file && m[2] !== "0") out.push({ file, start: Number(m[1]), end: Number(m[1]) + (m[2] === undefined ? 1 : Number(m[2])) - 1 });
      }
      return out;
    },
    blame: (rev, file, start, end) => {
      const o = tryGit(cwd, ["blame", "--porcelain", "-L", `${start},${end}`, rev, "--", file]);
      return o == null ? null : [...new Set(o.split("\n").filter((l) => /^[0-9a-f]{40} \d+ \d+/.test(l)).map((l) => l.slice(0, 40)))];
    },
  };
}

/** GitHub + git inputs for compoundingReport: guards from FORGE:GUARD comments, reopen events from one paginated events call. */
export async function gatherCompounding({ repo, gh, cwd = process.cwd() }) {
  const guards = await collectGuards({ gh, repo });
  let reopens = [];
  try {
    reopens = parsePages(await gh(["api", "--paginate", `repos/${repo}/issues/events?per_page=100`]))
      .filter((e) => e?.event === "reopened" && Number.isSafeInteger(e.issue?.number)).map((e) => ({ issue: e.issue.number, ts: e.created_at }));
  } catch { /* events unreadable: reopen metrics read 0 reopens, shown with the count in sources */ }
  return { guards, reopens, git: gitProbes(cwd) };
}
