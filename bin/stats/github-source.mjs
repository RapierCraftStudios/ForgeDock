// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Primary source for `forgedock stats` (forge#3835): the target repo's issues and PRs on GitHub.
 * Reads labels and ONLY trusted `<!-- FORGE:TELEMETRY v1 -->` comments (same predicate as
 * scripts/trusted-comments.sh: an author_association in FORGE_TRAIL_TRUSTED_ASSOCIATIONS, a Bot, or a login in
 * FORGE_TRAIL_TRUSTED_LOGINS). Every `gh` call is argv-based (no shell). The `gh` runner is injectable for tests.
 * Fetching is incremental: only items updated after the cached watermark (minus a small overlap window) are re-read.
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

const CHECKPOINT_EVERY = 25;
const PAGE_SIZE = 100;
// The next incremental run re-reads this much before the persisted watermark (an overlap window), so a write that races a
// crawl or a small clock skew is re-listed. Re-reads are idempotent: items are keyed by issue number.
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;
const MAX_LIST_REQUESTS = 100000;

/** Shift an ISO-8601 timestamp by `ms`; an unparsable value is returned unchanged. */
export function shiftIso(ts, ms) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? ts : new Date(t + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const sinceParam = (ts) => encodeURIComponent(ts).replace(/%3A/g, ":");

/**
 * Keyset crawl of the issue listing. The listing is sorted by a MUTABLE key (updated_at), so page-number pagination
 * (`gh --paginate`) can skip an item updated mid-crawl: it moves to the end of the ordering and the items behind it shift
 * one page earlier. Instead every request is page 1 from `since=CURSOR`, the cursor moves to the newest `updated_at` read,
 * and already-seen (number, updated_at) pairs are dropped (the `since` boundary is inclusive). A full page that cannot move
 * the cursor (more than PAGE_SIZE items share one timestamp) is drained with `page=N` for that timestamp only.
 * Yields each page's unseen items sorted updated-asc.
 */
function* listIssuePages(gh, repo, startSince) {
  const base = ["state=all", "sort=updated", "direction=asc", `per_page=${PAGE_SIZE}`];
  const seen = new Set();
  const key = (it) => `${it.number}@${it.updated_at}`;
  const take = (page) => {
    const fresh = page.filter((it) => Number.isInteger(it?.number) && !seen.has(key(it)));
    for (const it of fresh) seen.add(key(it));
    return fresh.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
  };
  const maxTs = (page) => page.reduce((m, it) => (it?.updated_at && (!m || it.updated_at > m) ? it.updated_at : m), null);
  let cursor = startSince ?? null;
  for (let n = 0; n < MAX_LIST_REQUESTS; n++) {
    const get = (extra = []) => parsePages(gh(["api", `repos/${repo}/issues?${[...base, ...(cursor ? [`since=${sinceParam(cursor)}`] : []), ...extra].join("&")}`]));
    const page = get();
    const fresh = take(page);
    if (fresh.length > 0) yield fresh;
    if (page.length < PAGE_SIZE) return;
    const next = maxTs(page);
    if (next && next !== cursor) { cursor = next; continue; }
    // No cursor progress on a full page: drain this timestamp by page number, then step past it.
    for (let p = 2; p < MAX_LIST_REQUESTS; p++) {
      const more = get([`page=${p}`]);
      const freshMore = take(more);
      if (freshMore.length > 0) yield freshMore;
      if (more.length < PAGE_SIZE || freshMore.length === 0) break;
    }
    if (!cursor) return;
    cursor = shiftIso(cursor, 1000);
  }
}

const meta = (it) => ({ number: it.number, isPr: Boolean(it.pull_request), createdAt: it.created_at ?? null, closedAt: it.closed_at ?? null,
  updatedAt: it.updated_at ?? null, labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean), authorType: it.user?.type ?? null });

/**
 * Fetch (or incrementally refresh) the repo's issues, PRs and trusted telemetry records.
 * Returns { items, records, fetched, fromCache }. `refresh` ignores the cache; `useCache:false` never touches disk.
 */
export function fetchGithubRecords({ repo, refresh = false, useCache = true, gh = defaultGh, env = process.env } = {}) {
  if (!isValidRepo(repo)) throw new Error(`invalid repo: ${repo}`);
  const cache = useCache && !refresh ? loadCache(repo, env) : emptyCache();
  const startSince = cache.watermark ? shiftIso(cache.watermark, -WATERMARK_OVERLAP_MS) : null;
  const items = { ...cache.items };
  let watermark = cache.watermark;
  let fetched = 0;
  // Checkpoint: the watermark is the newest updated_at actually processed, and the next run starts WATERMARK_OVERLAP_MS
  // before it, so it is a safe resume point. A failure mid-crawl (rate limit, 5xx, a hook timeout) then keeps the
  // progress instead of restarting at zero.
  const checkpoint = () => { if (useCache) saveCache(repo, { ...emptyCache(), watermark, items }, env); };
  try {
    for (const page of listIssuePages(gh, repo, startSince)) for (const it of page) {
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
      if (fetched > 0 && fetched % CHECKPOINT_EVERY === 0 && (it.comments ?? 0) > 0) checkpoint();
    }
  } catch (err) {
    checkpoint();
    throw err;
  }
  checkpoint();
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
