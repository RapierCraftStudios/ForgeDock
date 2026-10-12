// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Primary source for `forgedock stats` (forge#3835): the target repo's issues and PRs on GitHub.
 * Reads labels and ONLY trusted `<!-- FORGE:TELEMETRY v1 -->` comments (same predicate as
 * scripts/trusted-comments.sh: an author_association in FORGE_TRAIL_TRUSTED_ASSOCIATIONS, a Bot, or a login in
 * FORGE_TRAIL_TRUSTED_LOGINS). Every `gh` call is argv-based (no shell). The `gh` runner is injectable for tests.
 * Fetching is incremental: only items updated after the cached watermark are re-read.
 */
import { execFileSync } from "node:child_process";
import { emptyCache, loadCache, saveCache } from "./cache.mjs";

export const MARKER_RE = /^<!-- FORGE:TELEMETRY v1( part=(\d+))? -->/;
const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const isValidRepo = (r) => typeof r === "string" && OWNER_REPO_RE.test(r) && !r.split("/").some((p) => p === "." || p === "..");

export function defaultGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
}

/** `gh api --paginate` prints one JSON array per page; join them into one flat array. */
export function parsePages(raw) {
  const t = (raw ?? "").trim();
  if (!t) return [];
  return JSON.parse(`[${t.replace(/\]\s*\[/g, "],[")}]`).flat();
}

export function isTrusted(comment, env = process.env) {
  const assoc = (env.FORGE_TRAIL_TRUSTED_ASSOCIATIONS ?? "OWNER,MEMBER,COLLABORATOR").split(",").map((s) => s.trim()).filter(Boolean);
  const logins = (env.FORGE_TRAIL_TRUSTED_LOGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return assoc.includes(comment?.author_association ?? "") || (comment?.user?.type ?? "") === "Bot" || logins.includes(comment?.user?.login ?? "");
}

/**
 * Trusted FORGE:TELEMETRY comments -> record objects. Parts are all read (order is irrelevant), the fenced `jsonl`
 * block is parsed line by line (a torn or invalid line is skipped), and records are deduped on `eid` (never on the
 * line text: identical same-second events carry different ids).
 */
export function parseTelemetryComments(comments, env = process.env) {
  const seen = new Set();
  const out = [];
  for (const c of comments) {
    if (!MARKER_RE.test(c?.body ?? "") || !isTrusted(c, env)) continue;
    const block = /```jsonl\n([\s\S]*?)(?:\n```|$)/.exec(c.body);
    if (!block) continue;
    for (const line of block[1].split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec !== "object" || typeof rec.event !== "string" || typeof rec.eid !== "string" || seen.has(rec.eid)) continue;
      seen.add(rec.eid);
      out.push(rec);
    }
  }
  return out;
}

const num = (x) => { const v = Number(x); return x != null && x !== "" && Number.isFinite(v) ? v : null; };

/**
 * Turn `phase_attempt` / `run_terminal` records into run summaries, finished only when a `run_terminal` exists.
 * The run id is per engine process, so a `--retry` yields several; they collapse to ONE run per repo#issue, the latest
 * by start timestamp (tie: greater run id), matching scripts/cost-report.sh (last RUN_START slice). Finished/usage
 * filtering stays downstream, so an unfinished latest run still excludes the issue. Field names are the ones bin/engine/telemetry-seam.mjs writes (docs/TELEMETRY.md).
 */
export function runsFromRecords(records) {
  const byRun = new Map();
  for (const r of records) {
    if ((r.event !== "phase_attempt" && r.event !== "run_terminal") || r.issue == null) continue;
    const key = `${r.repo}#${r.issue}#${r.run ?? ""}`;
    const run = byRun.get(key) ?? { source: "github", repo: r.repo ?? null, version: r.forge_version ?? null, issue: r.issue, run: r.run ?? null,
      finished: false, hydrated: false, usageEvents: 0, reason: null, code: null, remediated: false, startTs: null, endTs: null, wallMs: null,
      phases: {}, _first: null };
    byRun.set(key, run);
    if (!run._first || r.ts < run._first) run._first = r.ts;
    if (r.event === "run_terminal") {
      run.finished = true; run.reason = r.reason ?? null; run.code = r.code ?? null; run.endTs = r.ts ?? null; run.wallMs = num(r.wall_ms);
      continue;
    }
    const id = r.phase ?? "other";
    const p = (run.phases[id] ??= { cr: 0, out: 0, usd: null, ms: null, attempts: 0 });
    const hasUsage = [r.input_tokens, r.output_tokens, r.cache_read_tokens].some((x) => num(x) != null);
    if (hasUsage) run.usageEvents++;
    p.cr += num(r.cache_read_tokens) ?? 0;
    p.out += num(r.output_tokens) ?? 0;
    p.attempts++;
    if (num(r.duration_ms) != null) p.ms = (p.ms ?? 0) + num(r.duration_ms);
    if (num(r.cost_usd) != null) p.usd = (p.usd ?? 0) + num(r.cost_usd);
    if (id === "remediate") run.remediated = true;
  }
  const latest = new Map();
  for (const run of byRun.values()) {
    const k = `${run.repo}#${run.issue}`;
    const cur = latest.get(k);
    const a = run._first ?? "", b = cur?._first ?? "";
    if (!cur || a > b || (a === b && (run.run ?? "") > (cur.run ?? ""))) latest.set(k, run);
  }
  return [...latest.values()].map(({ _first, ...run }) => ({ ...run, startTs: _first }));
}

/** Gate/review records (everything that is not a run record) become aggregate events. */
export const gateEvents = (records) => records.filter((r) => r.event !== "phase_attempt" && r.event !== "run_terminal")
  .map((r) => ({ ...r, version: r.forge_version ?? null }));

const meta = (it) => ({ number: it.number, isPr: Boolean(it.pull_request), createdAt: it.created_at ?? null, closedAt: it.closed_at ?? null,
  updatedAt: it.updated_at ?? null, labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean), authorType: it.user?.type ?? null });

/**
 * Fetch (or incrementally refresh) the repo's issues, PRs and trusted telemetry records.
 * Returns { items, records, fetched, fromCache }. `refresh` ignores the cache; `useCache:false` never touches disk.
 */
export function fetchGithubRecords({ repo, refresh = false, useCache = true, gh = defaultGh, env = process.env } = {}) {
  if (!isValidRepo(repo)) throw new Error(`invalid repo: ${repo}`);
  const cache = useCache && !refresh ? loadCache(repo, env) : emptyCache();
  const q = ["state=all", "sort=updated", "direction=asc", "per_page=100", ...(cache.watermark ? [`since=${cache.watermark}`] : [])];
  const listed = parsePages(gh(["api", "--paginate", `repos/${repo}/issues?${q.join("&")}`]));
  const items = { ...cache.items };
  let watermark = cache.watermark;
  let fetched = 0;
  for (const it of listed) {
    if (!Number.isInteger(it?.number)) continue;
    const m = meta(it);
    let records = items[it.number]?.records ?? [];
    // A telemetry comment is edited in place (which may not bump the issue's updated_at), so every listed item with
    // comments is re-read rather than trusting a cached copy.
    if ((it.comments ?? 0) > 0) {
      records = parseTelemetryComments(parsePages(gh(["api", "--paginate", `repos/${repo}/issues/${it.number}/comments`])), env);
      fetched++;
    }
    items[it.number] = { ...m, records };
    if (m.updatedAt && (!watermark || m.updatedAt > watermark)) watermark = m.updatedAt;
  }
  if (useCache) saveCache(repo, { ...emptyCache(), watermark, items }, env);
  const seen = new Set();
  const records = [];
  for (const it of Object.values(items)) for (const r of it.records ?? []) {
    if (!seen.has(r.eid)) { seen.add(r.eid); records.push(r); }
  }
  return { items: Object.values(items), records, fetched, fromCache: cache.watermark != null };
}

/** Aggregate-model inputs for one repo from a fetch result. */
export function toModel(repo, result) {
  return {
    runs: runsFromRecords(result.records.map((r) => ({ ...r, repo: r.repo ?? repo }))),
    events: gateEvents(result.records.map((r) => ({ ...r, repo: r.repo ?? repo }))),
    issues: result.items.map((i) => ({ repo, number: i.number, isPr: i.isPr, createdAt: i.createdAt, closedAt: i.closedAt, labels: i.labels, authorType: i.authorType })),
  };
}
