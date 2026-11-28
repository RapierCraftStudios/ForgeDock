// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock stats escapes [--days 14] [--repo R] [--json]` (#6203): the escape linker. For lane PRs merged in the window, find
 * later fix or revert PRs and bug issues that cite the lane PR number or its issue (within WINDOW_DAYS of the merge), plus
 * reopen events on the lane's issue. Deterministic, gh reads only, no model. A citation count is a lower bound on the true
 * escape rate. Results merge into ~/.forge/stats-cache/escapes-<owner>__<repo>.json, which the weekly scorecard reads.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultGh, isValidRepo } from "./github-source.mjs";
import { resolveRepo } from "./index.mjs";
import { forgeHome } from "./weekly.mjs";

export const WINDOW_DAYS = 14;
const DAY = 86400000;
const labelsOf = (x) => (x.labels ?? []).map((l) => String(l?.name ?? l).toLowerCase());
const cites = (text, n) => new RegExp(`(^|[^\\w/])#${n}(?!\\d)`).test(String(text ?? ""));

/** The lane's issue number: from the lane branch, else a `Closes #N` in the body. */
export function laneIssueOf(pr) {
  const b = /^feat\/issue-(\d+)(-|$)/.exec(pr.headRefName ?? "")?.[1];
  if (b) return Number(b);
  const c = /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(pr.body ?? "")?.[1];
  return c ? Number(c) : null;
}
export const isFixPr = (p) => /^(revert|fix|hotfix)\b/i.test(p.title ?? "") || /^(fix|revert|hotfix)\//i.test(p.headRefName ?? "");
export const isBugIssue = (i) => labelsOf(i).some((l) => /^(bug|regression|revert|type:bug)$/.test(l) || l.includes("regression"));
const CAUSAL = /regress|introduc|broke|breaks|caused|revert|follow.?up|fallout|missed|incomplete|hotfix|left behind|undid/i;
/** A citation of #n that blames it: the number sits within 100 chars of a causal word (a bare mention in a tracker does not count). */
export const blames = (text, n) => {
  const t = String(text ?? ""), re = new RegExp(`(^|[^\\w/])#${n}(?!\\d)`, "g");
  for (let m; (m = re.exec(t));) if (CAUSAL.test(t.slice(Math.max(0, m.index - 100), m.index + 100))) return true;
  return false;
};

/** Pure link step: lane PRs, candidate PRs and issues, reopen counts -> per-PR escape records. */
export function linkEscapes({ lanePrs, candPrs, candIssues, reopens = new Map(), windowDays = WINDOW_DAYS }) {
  return lanePrs.map((p) => {
    const issue = laneIssueOf(p), t0 = Date.parse(p.mergedAt), t1 = t0 + windowDays * DAY, links = [];
    const hit = (x, kind) => {
      if (x.number === p.number || x.number === issue) return;
      const created = Date.parse(x.createdAt);
      if (!(created > t0 && created <= t1)) return;
      // fix/revert PRs may cite the lane PR directly; every other citation (the lane's issue, or a bug issue) must blame it
      const direct = kind !== "bug_issue" && (cites(x.title, p.number) || cites(x.body, p.number));
      const blamed = blames(x.title, p.number) || blames(x.body, p.number) || (issue && (blames(x.title, issue) || blames(x.body, issue)));
      if (direct || blamed) links.push({ kind, number: x.number });
    };
    for (const x of candPrs) if (isFixPr(x)) hit(x, /^revert/i.test(x.title ?? "") ? "revert_pr" : "fix_pr");
    for (const x of candIssues) if (isBugIssue(x)) hit(x, "bug_issue");
    const reopened = issue ? (reopens.get(issue) ?? 0) : 0;
    return { pr: p.number, issue, mergedAt: p.mergedAt, links, reopened, escaped: links.length > 0 || reopened > 0 };
  });
}

const readdirSyncSafe = (d) => { try { return readdirSync(d); } catch { return []; } };
const cachePath = (home, repo) => join(home, "stats-cache", `escapes-${String(repo).replace("/", "__")}.json`);
/** Map "PR number" -> escaped boolean for the weekly scorecard; null without a cache. */
export function readEscapeCache({ home = forgeHome(), repo = null } = {}) {
  const repos = repo ? [repo] : [];
  const m = new Map();
  for (const r of repos.length ? repos : []) { try { for (const [pr, v] of Object.entries(JSON.parse(readFileSync(cachePath(home, r), "utf8")).prs ?? {})) m.set(Number(pr), Boolean(v.escaped)); } catch { /* none */ } }
  if (!repo) { // no repo given: every cached repo
    try { for (const f of readdirSyncSafe(join(home, "stats-cache"))) if (f.startsWith("escapes-")) for (const [pr, v] of Object.entries(JSON.parse(readFileSync(join(home, "stats-cache", f), "utf8")).prs ?? {})) m.set(Number(pr), Boolean(v.escaped)); } catch { /* none */ }
  }
  return m.size ? m : null;
}

export async function gatherEscapes({ repo, days = WINDOW_DAYS, gh = defaultGh, now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const from = day(now - days * DAY), upto = day(now - 0);
  const j = async (args) => JSON.parse(await gh(args) || "[]");
  const merged = await j(["pr", "list", "-R", repo, "--state", "merged", "--search", `merged:>=${from}`, "--limit", "1000", "--json", "number,title,body,headRefName,mergedAt"]);
  const lanePrs = merged.filter((p) => laneIssueOf(p) != null && /^feat\/issue-\d+/.test(p.headRefName ?? ""));
  const candFrom = from;
  const candPrs = await j(["pr", "list", "-R", repo, "--state", "all", "--search", `created:>=${candFrom}`, "--limit", "1000", "--json", "number,title,body,headRefName,createdAt"]);
  const candIssues = await j(["issue", "list", "-R", repo, "--state", "all", "--search", `created:>=${candFrom}`, "--limit", "1000", "--json", "number,title,body,labels,createdAt"]);
  const reopens = new Map(), issues = [...new Set(lanePrs.map(laneIssueOf))];
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (;;) {
      const n = issues[i++]; if (n === undefined) return;
      const pr = lanePrs.find((p) => laneIssueOf(p) === n), t0 = Date.parse(pr.mergedAt);
      try {
        const ev = JSON.parse(await gh(["api", `repos/${repo}/issues/${n}/events`, "--paginate", "--jq", "[.[] | select(.event==\"reopened\") | .created_at]"]).then((s) => `[${String(s).replace(/\]\s*\[/g, ",").replace(/^\[|\]$/g, "")}]`) || "[]");
        reopens.set(n, ev.filter((t) => Date.parse(t) > t0 && Date.parse(t) <= t0 + windowDays * DAY).length);
      } catch { /* a missing events read is not a reopen */ }
    }
  }));
  return { upto, records: linkEscapes({ lanePrs, candPrs, candIssues, reopens, windowDays }) };
}

export function summarise(records) {
  const done = records.filter((r) => Date.parse(r.mergedAt) <= Date.now() - WINDOW_DAYS * DAY), esc = (rs) => rs.filter((r) => r.escaped).length;
  return { lane_prs: records.length, escaped: esc(records), escape_pct: records.length ? esc(records) / records.length : null,
    matured_prs: done.length, matured_escaped: esc(done), matured_escape_pct: done.length ? esc(done) / done.length : null,
    by_kind: records.flatMap((r) => r.links.map((l) => l.kind)).reduce((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {}), reopened: records.filter((r) => r.reopened > 0).length };
}

export function renderEscapes(records, repo, days) {
  const s = summarise(records), p = (v) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const lines = [`Escapes for ${repo}: lane PRs merged in the last ${days}d, linked to fix/revert PRs and bug issues citing the PR or its issue within ${WINDOW_DAYS}d, plus reopens.`,
    `lane PRs ${s.lane_prs}  escaped ${s.escaped}  escape ${p(s.escape_pct)}  (matured ${WINDOW_DAYS}d+: ${s.matured_escaped}/${s.matured_prs} = ${p(s.matured_escape_pct)})  reopened ${s.reopened}`,
    `links by kind: ${Object.entries(s.by_kind).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}. Citation-based, so a lower bound.`];
  for (const r of records.filter((x) => x.escaped)) lines.push(`  PR #${r.pr} (issue ${r.issue ?? "?"}): ${r.links.map((l) => `${l.kind} #${l.number}`).join(", ")}${r.reopened ? ` reopened x${r.reopened}` : ""}`);
  return `${lines.join("\n")}\n`;
}

export async function runEscapes(argv, deps = {}) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const days = Number(val("--days") ?? WINDOW_DAYS), repo = resolveRepo(val("--repo"));
  if (!isValidRepo(repo) || !(days > 0)) { process.stderr.write("forgedock stats escapes [--days N] [--repo owner/repo] [--json]\n"); return 2; }
  const { records } = await gatherEscapes({ repo, days, gh: deps.gh ?? defaultGh, now: deps.now?.() ?? Date.now() });
  if (!deps.noCache) { // merge into the cache: a re-run replaces the PRs it covers (the linker is deterministic) and keeps older ones
    const home = deps.home ?? forgeHome(), file = cachePath(home, repo);
    let prs = {}; try { prs = JSON.parse(readFileSync(file, "utf8")).prs ?? {}; } catch { /* new cache */ }
    for (const r of records) prs[r.pr] = r;
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ repo, updated: new Date().toISOString(), prs }));
  }
  (deps.out ?? ((s) => process.stdout.write(s)))(argv.includes("--json") ? `${JSON.stringify({ repo, days, ...summarise(records), records }, null, 2)}\n` : renderEscapes(records, repo, days));
  return 0;
}
