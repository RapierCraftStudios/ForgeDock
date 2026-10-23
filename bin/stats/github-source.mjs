// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Primary source for `forgedock stats` (forge#3835): the target repo's issues and PRs on GitHub.
 * Reads labels and ONLY trusted `<!-- FORGE:TELEMETRY v1 -->` comments (same predicate as
 * scripts/trusted-comments.sh: an author_association in FORGE_TRAIL_TRUSTED_ASSOCIATIONS, a Bot, or a login in
 * FORGE_TRAIL_TRUSTED_LOGINS). Every `gh` call is argv-based (no shell). The `gh` runner is injectable for tests.
 * Fetching is windowed and incremental: only items updated after the crawl start (the cached watermark minus a small
 * overlap, or the requested `--since` bound) are listed, and comments come from the repo-wide `issues/comments?since=`
 * endpoint (a few paginated calls) instead of one call per item.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emptyCache, loadCache, saveCache } from "./cache.mjs";

export const MARKER_RE = /^<!-- FORGE:TELEMETRY v1( part=(\d+))? -->/;
const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const isValidRepo = (r) => typeof r === "string" && OWNER_REPO_RE.test(r) && !r.split("/").some((p) => p === "." || p === "..");

const execFileAsync = promisify(execFile);

/** Async `gh` runner (concurrency needs it). A test stub may stay synchronous: every call site awaits the result. */
export async function defaultGh(args) {
  const { stdout } = await execFileAsync("gh", args, { encoding: "utf8", timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
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
      phases: {}, builderAttempts: [], _first: null };
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
    const usd = num(r.cost_usd_delta) ?? num(r.cost_usd); // #4407: cost_usd is a running total for a resumed session
    if (usd != null) p.usd = (p.usd ?? 0) + usd;
    if (id === "remediate") run.remediated = true;
    if (id === "implement") run.builderAttempts.push({ attempt: num(r.attempt), trigger: r.trigger ?? null, restart_of: r.restart_of ?? null, cost_usd: usd, _ts: r.ts ?? "" }); // #4362
  }
  const latest = new Map();
  for (const run of byRun.values()) {
    const k = `${run.repo}#${run.issue}`;
    const cur = latest.get(k);
    const a = run._first ?? "", b = cur?._first ?? "";
    if (!cur || a > b || (a === b && (run.run ?? "") > (cur.run ?? ""))) latest.set(k, run);
  }
  // #4362: attempt order (a timeout restart reuses its number: then record time); stable for equal keys
  const order = (a, b) => (a.attempt ?? 0) - (b.attempt ?? 0) || (a._ts < b._ts ? -1 : a._ts > b._ts ? 1 : 0);
  return [...latest.values()].map(({ _first, ...run }) => ({ ...run, startTs: _first,
    builderAttempts: [...run.builderAttempts].sort(order).map(({ _ts, ...a }) => a) }));
}

/** Gate/review records (everything that is not a run record) become aggregate events. */
export const gateEvents = (records) => records.filter((r) => r.event !== "phase_attempt" && r.event !== "run_terminal")
  .map((r) => ({ ...r, version: r.forge_version ?? null }));

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
async function* listIssuePages(gh, repo, startSince) {
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
    const get = async (extra = []) => parsePages(await gh(["api", `repos/${repo}/issues?${[...base, ...(cursor ? [`since=${sinceParam(cursor)}`] : []), ...extra].join("&")}`]));
    const page = await get();
    const fresh = take(page);
    if (fresh.length > 0) yield fresh;
    if (page.length < PAGE_SIZE) return;
    const next = maxTs(page);
    if (next && next !== cursor) { cursor = next; continue; }
    // No cursor progress on a full page: drain this timestamp by page number, then step past it.
    for (let p = 2; p < MAX_LIST_REQUESTS; p++) {
      const more = await get([`page=${p}`]);
      const freshMore = take(more);
      if (freshMore.length > 0) yield freshMore;
      if (more.length < PAGE_SIZE || freshMore.length === 0) break;
    }
    if (!cursor) return;
    cursor = shiftIso(cursor, 1000);
  }
}

const meta = (it) => ({ number: it.number, isPr: Boolean(it.pull_request), createdAt: it.created_at ?? null, closedAt: it.closed_at ?? null,
  updatedAt: it.updated_at ?? null, milestone: it.milestone?.title ?? null, labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean), authorType: it.user?.type ?? null });

const CHECKPOINT_EVERY = 1000;
const RATE_CHECK_EVERY = 50;
const RATE_LOW = 200;
const MAX_RATE_SLEEP_MS = 60 * 60 * 1000;
const DEFAULT_CONCURRENCY = 6;
const isoNow = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Run `fn` over `list` with at most `limit` in flight; the first failure stops new work and is rethrown. */
async function pool(list, limit, fn) {
  let next = 0, failed = null;
  const worker = async () => {
    while (!failed && next < list.length) {
      const item = list[next++];
      try { await fn(item); } catch (err) { failed ??= err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker));
  if (failed) throw failed;
}

/** Best effort: when the core rate limit is nearly spent, sleep until it resets. Never throws. */
async function waitForRate(gh, sleep, now) {
  try {
    const core = JSON.parse(await gh(["api", "rate_limit"]))?.resources?.core;
    if (core && Number.isFinite(core.remaining) && core.remaining < RATE_LOW && Number.isFinite(core.reset)) {
      await sleep(Math.min(Math.max(core.reset * 1000 - now() + 1000, 0), MAX_RATE_SLEEP_MS));
    }
  } catch { /* the limit check is advisory */ }
}

/**
 * Page the repo-wide comments endpoint (comments updated since `from`, id-ascending) and return the numbers of the issues
 * and PRs that carry at least one trusted FORGE:TELEMETRY comment in that window. Items without one cost nothing more.
 */
async function scanWindowComments(call, repo, from, env, onPage) {
  const base = ["per_page=100", ...(from ? [`since=${sinceParam(from)}`] : [])];
  const numbers = new Set();
  for (let p = 1; p < MAX_LIST_REQUESTS; p++) {
    const page = parsePages(await call(["api", `repos/${repo}/issues/comments?${[...base, `page=${p}`].join("&")}`]));
    for (const c of page) {
      if (!MARKER_RE.test(c?.body ?? "") || !isTrusted(c, env)) continue;
      const m = /\/issues\/(\d+)$/.exec(c.issue_url ?? "");
      if (m) numbers.add(Number(m[1]));
    }
    onPage(p);
    if (page.length < PAGE_SIZE) break;
  }
  return numbers;
}

/**
 * Fetch (or incrementally refresh) the repo's issues, PRs and trusted telemetry records. Async; `gh` may be sync or async.
 * `since` (ISO) bounds the crawl: only items and comments updated on/after it are read, plus whatever the cache already
 * holds. The cache records the lowest window start it covers (`coveredFrom`); a request that starts earlier re-crawls from
 * its own start and then lowers the floor, so a later wider window is never under-reported.
 * Returns { items, records, fetched, fromCache, apiCalls, coveredFrom }. `refresh` ignores the cache; `useCache:false`
 * never touches disk. `onProgress({phase, done, total})` is called as the crawl moves (total is null when unknown).
 */
export async function fetchGithubRecords({ repo, since = null, refresh = false, useCache = true, gh = defaultGh, env = process.env,
  onProgress = () => {}, concurrency = DEFAULT_CONCURRENCY, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
  rateCheck = gh === defaultGh } = {}) {
  if (!isValidRepo(repo)) throw new Error(`invalid repo: ${repo}`);
  const cache = useCache && !refresh ? loadCache(repo, env) : emptyCache();
  const start = since ?? null;
  const hasCover = cache.watermark != null;
  const floor = cache.coveredFrom;
  // Does the cache already hold everything from `start` on? An unknown floor (a cache from before coveredFrom) is only
  // trusted for a full-history request, never for a window.
  const covers = hasCover && (floor === null || (floor === undefined ? start == null : start != null && Date.parse(start) >= Date.parse(floor)));
  const crawlFrom = covers ? shiftIso(cache.watermark, -WATERMARK_OVERLAP_MS) : start;
  const newFloor = covers ? (floor === undefined ? null : floor) : start;
  const scanTs = isoNow(now());
  let apiCalls = 0, guard = Promise.resolve();
  const call = async (args) => {
    if (rateCheck && apiCalls > 0 && apiCalls % RATE_CHECK_EVERY === 0) guard = guard.then(() => waitForRate(gh, sleep, now));
    apiCalls++;
    await guard;
    return gh(args);
  };
  const items = { ...cache.items };
  let watermark = cache.watermark;
  let fetched = 0;
  let gapDone = false;
  // Never persist a watermark past the moment the comment scan started: a comment posted after it bumps its issue's
  // updated_at, and the next run must still start before that.
  const cap = (w) => (w && w > scanTs ? scanTs : w);
  // Telemetry issues whose records are not yet in `items` (the records are re-read in memory first). While any remain the
  // watermark must not move past where the comment scan began, or a resumed run would never re-scan their comments.
  const pending = new Set();
  const scanResume = () => (crawlFrom ? shiftIso(crawlFrom, WATERMARK_OVERLAP_MS) : null);
  // Checkpoint: while the crawl extends coverage forward (fresh cache, or the covered range's tail) the watermark is the
  // newest updated_at processed. A gap crawl (window starts before the floor) leaves watermark and floor untouched until
  // it finishes, so a failure never claims coverage it does not have.
  const checkpoint = () => {
    if (!useCache) return;
    const extend = !hasCover || covers || gapDone;
    saveCache(repo, { ...emptyCache(), watermark: extend ? (pending.size > 0 ? scanResume() : cap(watermark)) : cache.watermark, coveredFrom: extend ? newFloor : cache.coveredFrom, items }, env);
  };
  try {
    const telemetry = [...await scanWindowComments(call, repo, crawlFrom, env, (p) => onProgress({ phase: "comments", done: p, total: null }))];
    // A telemetry run spans several comment parts and the window holds only the touched ones, so each such issue's full
    // comment list is re-read once (bounded pool) and replaces its records.
    const recordsOf = new Map();
    for (const n of telemetry) pending.add(n);
    let done = 0;
    await pool(telemetry, concurrency, async (n) => {
      recordsOf.set(n, parseTelemetryComments(parsePages(await call(["api", "--paginate", `repos/${repo}/issues/${n}/comments`])), env));
      fetched++;
      onProgress({ phase: "telemetry", done: ++done, total: telemetry.length });
    });
    const listed = new Set();
    let processed = 0;
    for await (const page of listIssuePages(call, repo, crawlFrom)) for (const it of page) {
      const m = meta(it);
      items[it.number] = { ...m, records: recordsOf.get(it.number) ?? items[it.number]?.records ?? [] };
      listed.add(it.number);
      pending.delete(it.number);
      if (m.updatedAt && (!watermark || m.updatedAt > watermark)) watermark = m.updatedAt;
      if (++processed % CHECKPOINT_EVERY === 0) checkpoint();
      if (processed % PAGE_SIZE === 0) onProgress({ phase: "issues", done: processed, total: null });
    }
    onProgress({ phase: "issues", done: processed, total: null });
    // A telemetry comment edited in place does not bump its issue's updated_at, so such an issue can be missing from the
    // listing: update its cached records, and read its metadata once if the cache has never seen it.
    await pool(telemetry.filter((n) => !listed.has(n)), concurrency, async (n) => {
      if (items[n]) { items[n] = { ...items[n], records: recordsOf.get(n) }; pending.delete(n); return; }
      const [it] = parsePages(await call(["api", `repos/${repo}/issues/${n}`]));
      if (it && Number.isInteger(it.number)) items[n] = { ...meta(it), records: recordsOf.get(n) };
      pending.delete(n);
    });
    gapDone = true;
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
  return { items: Object.values(items), records, fetched, fromCache: hasCover, apiCalls, coveredFrom: newFloor };
}

/** Aggregate-model inputs for one repo from a fetch result. */
export function toModel(repo, result) {
  return {
    runs: runsFromRecords(result.records.map((r) => ({ ...r, repo: r.repo ?? repo }))),
    events: gateEvents(result.records.map((r) => ({ ...r, repo: r.repo ?? repo }))),
    issues: result.items.map((i) => ({ repo, number: i.number, isPr: i.isPr, createdAt: i.createdAt, closedAt: i.closedAt, labels: i.labels, authorType: i.authorType })),
  };
}
