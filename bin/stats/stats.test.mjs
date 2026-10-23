// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { tmpDir } from "../tests/_tmp.mjs";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { aggregate, compareVersions, computeAlerts, DEFAULT_ALERTS, percentile } from "./aggregate.mjs";
import { cacheDir } from "./cache.mjs";
import { fetchGithubRecords, parseTelemetryComments, runsFromRecords, toModel } from "./github-source.mjs";
import { buildReport, makeProgressPrinter, parseArgs, parseSince, readAlertConfig, runStats, sinceToTimestamp } from "./index.mjs";
import { lanesOfLog, readLanes, readLocalRuns, summariseLog } from "./local-source.mjs";
import { renderAlerts, renderCompact, renderJson, renderMarkdown } from "./render.mjs";
import { edgeQuery, parseEdge, verdictMix, contextPackAb, renderContextAb, builderTierReport, renderTiers } from "./query.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, "fixtures", f);
const load = (f) => JSON.parse(readFileSync(fx(f), "utf8"));
const ENV = { FORGE_TRAIL_TRUSTED_ASSOCIATIONS: "OWNER,MEMBER,COLLABORATOR" };

// A fake `gh`: lists the fixture issues (honouring `since`), serves comments per number. Counts every call.
function fakeGh() {
  const comments = { 201: load("comments-201.json"), 301: load("comments-301.json") };
  const issues = load("issues.json");
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(" "));
    const path = args.find((a) => a.startsWith("repos/"));
    const m = /issues\/(\d+)\/comments$/.exec(path);
    if (m) return JSON.stringify(comments[m[1]] ?? []);
    if (/issues\/comments\?/.test(path)) { // repo-wide endpoint: every comment, tagged with its issue (fixtures carry no updated_at)
      const all = Object.entries(comments).flatMap(([n, list]) => list.map((c) => ({ ...c, issue_url: `https://api.github.com/repos/o/r/issues/${n}` })));
      return JSON.stringify(/page=1(&|$)/.test(path) ? all : []);
    }
    const since = /since=([^&]+)/.exec(path)?.[1];
    return JSON.stringify(issues.filter((i) => !since || i.updated_at >= since));
  };
  return { gh, calls };
}

let td;
beforeEach(() => { td = tmpDir("stats-"); });
afterEach(() => rmSync(td, { recursive: true, force: true }));

describe("telemetry comment parsing", () => {
  it("concatenates parts, dedupes on eid and ignores untrusted or unrelated comments", () => {
    const recs = parseTelemetryComments(load("comments-201.json"), ENV);
    assert.deepEqual(recs.map((r) => r.eid), ["e1", "e2", "e3", "e4", "e5"]);
    assert.ok(!recs.some((r) => r.eid === "e90"), "untrusted User comment must not be read");
  });
  it("skips torn lines and keeps identical-looking events that have different eids", () => {
    const body = "<!-- FORGE:TELEMETRY v1 -->\n```jsonl\n{\"event\":\"a\",\"eid\":\"1\"}\n{\"event\":\"a\",\"eid\":\"2\"}\n{torn\n";
    const recs = parseTelemetryComments([{ body, user: { type: "Bot" } }], ENV);
    assert.equal(recs.length, 2);
  });
  it("trusts OWNER/MEMBER/COLLABORATOR, not NONE users", () => {
    const body = "<!-- FORGE:TELEMETRY v1 -->\n```jsonl\n{\"event\":\"a\",\"eid\":\"1\"}\n```";
    assert.equal(parseTelemetryComments([{ body, author_association: "MEMBER", user: { type: "User" } }], ENV).length, 1);
    assert.equal(parseTelemetryComments([{ body, author_association: "NONE", user: { type: "User" } }], ENV).length, 0);
  });
});

describe("GitHub-only report (fresh machine)", () => {
  it("rebuilds cost, time, flow, funnel, gates and issue flow from GitHub alone", async () => {
    const { gh } = fakeGh();
    const report = await buildReport({ repo: "o/r", local: false, cache: false, minN: 10 }, { gh, env: ENV, releaseTimes: [] });
    const g = report.groups.find((x) => x.version === "1.17.0");
    assert.equal(g.n, 1);
    assert.equal(g.cost.cacheReadMean, 3000000);
    assert.equal(g.cost.usdMean, 1.2);
    assert.equal(g.time.wall.p50, 900000);
    assert.equal(g.time.phases.build.p50, 500000);
    assert.equal(g.flow.mergedPct, 1);
    assert.deepEqual(g.flow.codes.map((c) => c.code), ["completed"]);
    assert.equal(g.funnel.reviews, 1);
    assert.equal(g.funnel.findings, 3);
    assert.equal(g.funnel.bySeverity.HIGH.total, 2);
    assert.equal(g.funnel.bySeverity.HIGH.ISSUE, 1);
    assert.equal(g.funnel.bySeverity.HIGH.INPR_FIX, 1);
    assert.equal(g.gates.acceptance.rate, 1, "duplicate eid counted once");
    assert.equal(g.gates.malformedRate, 1);
    assert.equal(g.gates.ci.rate, 0.5);
    assert.deepEqual(g.issueFlow.created, { pipeline: 1 });
    assert.equal(g.issueFlow.net, 0);
    const u = report.groups.find((x) => x.version === "unknown");
    assert.deepEqual(u.issueFlow.created, { "review-finding": 2, human: 1 });
    assert.equal(u.funnel.validated, 1);
    assert.equal(u.funnel.falsePositive, 1);
    assert.equal(u.issueFlow.net, 2);
    assert.equal(u.issueFlow.findingsPerMerge, null);
    assert.equal(g.funnel.introduced, 2, "only events carrying scope=introduced are counted");
    assert.equal(g.issueFlow.introducedPerMerge, (g.issueFlow.closed.merged ?? 0) > 0 ? 2 / g.issueFlow.closed.merged : null);
    assert.ok(!JSON.stringify(report).includes("999999999"), "untrusted record leaked into the report");
  });
  it("matches the run-record field names written by the engine seam", () => {
    const runs = runsFromRecords(parseTelemetryComments(load("comments-201.json"), ENV));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].finished, true);
    assert.equal(runs[0].phases.review.cr, 500000);
  });
  const rec = (run, ts, event, x = {}) => ({ event, repo: "o/r", issue: 500, run, ts, eid: run + ts + event, ...x });
  it("collapses a retried issue (two run ids) to the latest run", () => {
    const runs = runsFromRecords([
      rec("r_500_1", "2026-01-01T00:00:00Z", "phase_attempt", { phase: "build", cache_read_tokens: 2000000 }),
      rec("r_500_1", "2026-01-01T00:01:00Z", "run_terminal", { reason: "engine-error" }),
      rec("r_500_2", "2026-01-02T00:00:00Z", "phase_attempt", { phase: "build", cache_read_tokens: 1000000 }),
      rec("r_500_2", "2026-01-02T00:01:00Z", "run_terminal", { reason: "merged" }),
    ]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].reason, "merged");
    assert.equal(runs[0].phases.build.cr, 1000000);
  });
  it("lets an unfinished latest run win over an earlier finished retried run", () => {
    const runs = runsFromRecords([
      rec("r_500_1", "2026-01-01T00:00:00Z", "phase_attempt", { phase: "build", cache_read_tokens: 2000000 }),
      rec("r_500_1", "2026-01-01T00:01:00Z", "run_terminal", { reason: "merged" }),
      rec("r_500_2", "2026-01-02T00:00:00Z", "phase_attempt", { phase: "build", cache_read_tokens: 1000000 }),
    ]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].finished, false);
  });
});

describe("local runs, joins, version delta and low-n", () => {
  const runs = () => readLocalRuns(fx("runs"));
  const agg = (opts = {}) => aggregate({ runs: runs() }, { releaseTimes: [], ...opts });

  it("applies the cost-report counting rules", () => {
    const r = agg();
    assert.deepEqual(r.excluded, { unfinished: 1, noUsage: 1 });
    const g = r.groups.find((x) => x.version === "1.16.0");
    assert.equal(g.n, 2);
    assert.equal(g.cost.cacheReadMean, 4500000);
    assert.equal(g.cost.perPhase.build, 4000000);
    assert.equal(g.cost.perPhase.remediate, 0);
    assert.equal(g.cost.perMergedIssue, 9000000);
    assert.equal(g.flow.mergedPct, 0.5);
    assert.equal(g.flow.needsHumanPct, 0.5);
    assert.equal(g.flow.remediationPct, 0.5);
    assert.equal(g.cost.usdN, 1);
    assert.equal(g.time.wall.p50, 1500000);
    const legacy = r.groups.find((x) => x.version === "unknown");
    assert.equal(legacy.cost.cacheReadMean, 4000000, "legacy PHASE_COMMIT usage counted when no attempt events exist");
    assert.equal(legacy.flow.codesN, 0, "old logs have no outcome codes");
  });
  it("reports introduced findings per merged issue", () => {
    const ev = (eid, scope) => ({ event: "finding_disposition", eid, repo: "o/r", pr: 1, issue: eid === "d" ? 2 : 1, version: "1.18.0", severity: "MEDIUM", disposition: "INPR_FIX", ...(scope ? { scope } : {}) });
    const issue = (number) => ({ number, repo: "o/r", isPr: false, labels: ["workflow:merged"], createdAt: "2026-10-06T00:00:00Z", closedAt: "2026-10-07T00:00:00Z" });
    const r = aggregate({ events: [ev("a", "introduced"), ev("b", "introduced"), ev("c", "pre-existing"), ev("d")], issues: [issue(1), issue(2)] }, { releaseTimes: [] });
    const g = r.groups.find((x) => x.version === "1.18.0");
    assert.equal(g.funnel.introduced, 2);
    assert.equal(g.issueFlow.introducedPerMerge, 1);
    assert.match(renderMarkdown(r), /introduced findings per merged issue/);
  });
  it("computes the delta against the previous version of the same repo", () => {
    const g = agg().groups.find((x) => x.version === "1.17.0");
    assert.equal(g.delta.against, "1.16.0");
    assert.equal(g.delta.cacheReadMean, 2000000 - 4500000);
    assert.equal(g.delta.mergedPct, 0.5);
    assert.equal(agg().groups.find((x) => x.version === "1.16.0").delta, null);
  });
  it("flags samples under 10 and honours --min-n", () => {
    assert.ok(agg().groups.every((g) => g.lowN));
    assert.equal(agg({ minN: 2 }).groups.find((x) => x.version === "1.16.0").lowN, false);
    assert.match(renderMarkdown(agg()), /low-n/);
  });
  it("agrees with scripts/cost-report.sh on the same logs", { skip: spawnSync("jq", ["--version"]).status !== 0 }, () => {
    writeFileSync(join(td, "rel.txt"), "");
    const out = spawnSync("bash", [join(here, "..", "..", "scripts", "cost-report.sh"), "--runs-dir", fx("runs"), "--release-times", join(td, "rel.txt")], { encoding: "utf8" }).stdout;
    const row = out.split("\n").find((l) => l.startsWith("| 1.16.0 |"));
    assert.ok(row?.includes("| 4500k |"), row);
    assert.ok(row?.includes("| 9000k |"), row);
  });
  it("--since filters by version or date", () => {
    assert.deepEqual(agg({ ...parseSince("1.17.0") }).groups.map((g) => g.version), ["1.17.0"]);
    assert.ok(agg({ ...parseSince("2026-10-03") }).groups.every((g) => g.version !== "1.16.0"));
  });
  it("estimates versions of unversioned records from release times", () => {
    const r = aggregate({ runs: runs().filter((x) => x.issue === 105) }, { releaseTimes: [{ v: "1.15.0", t: 1 }] });
    assert.equal(r.groups[0].version, "1.15.0~");
  });
});

describe("n/a degradation and rendering", () => {
  it("renders n/a, never NaN or undefined, for missing data and empty input", () => {
    const old = { source: "local", repo: "o/r", version: "1.0.0", issue: 1, finished: true, hydrated: false, usageEvents: 1, reason: "merged", code: null, remediated: false, phases: { build: { cr: 10, out: 0, usd: null, ms: null, attempts: 1 } } };
    const r = aggregate({ runs: [old] });
    const md = renderMarkdown(r);
    assert.match(md, /n\/a/);
    assert.doesNotMatch(md, /NaN|undefined|Infinity/);
    assert.doesNotMatch(renderCompact(r), /NaN|undefined/);
    assert.match(renderMarkdown(aggregate({})), /No data/);
    assert.equal(percentile([], 90), null);
  });
  it("json output is parseable and carries every section", async () => {
    const { gh } = fakeGh();
    const report = await buildReport({ repo: "o/r", local: false, cache: false, minN: 10 }, { gh, env: ENV, releaseTimes: [] });
    const parsed = JSON.parse(renderJson(report));
    for (const k of ["cost", "time", "flow", "funnel", "gates", "issueFlow"]) assert.ok(k in parsed.groups[0]);
    const md = renderMarkdown(report);
    for (const h of ["### Cost", "### Time", "### Flow", "### Review funnel", "### Gates", "### Issue flow"]) assert.ok(md.includes(h), h);
  });
  it("orders versions numerically", () => {
    assert.ok(compareVersions("1.9.0", "1.10.0") < 0);
    assert.ok(compareVersions("1.10.0~", "1.10.0") === 0);
  });
});

describe("cache", () => {
  it("refreshes incrementally from the updated_at watermark and survives deletion or corruption", async () => {
    const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(td, "cache") };
    const a = fakeGh();
    const first = await fetchGithubRecords({ repo: "o/r", gh: a.gh, env });
    assert.equal(first.fromCache, false);
    assert.ok(!a.calls[0].includes("since="));
    const b = fakeGh();
    const second = await fetchGithubRecords({ repo: "o/r", gh: b.gh, env });
    assert.equal(second.fromCache, true);
    assert.match(b.calls[0], /since=2026-10-06T12:55:00Z/); // watermark minus the 5 minute overlap window
    assert.deepEqual(second.records.map((r) => r.eid).sort(), first.records.map((r) => r.eid).sort());
    // corrupt cache -> treated as empty -> same result from a full fetch
    writeFileSync(join(cacheDir("o/r", env), "cache.json"), "{not json");
    const c = fakeGh();
    const third = await fetchGithubRecords({ repo: "o/r", gh: c.gh, env });
    assert.equal(third.fromCache, false);
    assert.equal(third.records.length, first.records.length);
    // --refresh ignores a good cache
    const d = fakeGh();
    await fetchGithubRecords({ repo: "o/r", gh: d.gh, env, refresh: true });
    assert.ok(!d.calls[0].includes("since="));
    assert.equal(toModel("o/r", third).issues.length, 5);
  });
  // Page-aware fake of the issues API over a synthetic store; the repo-wide comments endpoint is empty unless `comments` is given.
  const storeGh = (store, { comments = [], failOnListCall = 0 } = {}) => {
    const calls = [];
    let listCalls = 0;
    const gh = (args) => {
      const path = args.find((a) => a.startsWith("repos/"));
      calls.push(path);
      const q = new URLSearchParams(path.split("?")[1] ?? "");
      if (/issues\/comments\?/.test(path)) {
        const since = q.get("since"), page = Number(q.get("page") ?? 1);
        return JSON.stringify(comments.filter((c) => !since || c.updated_at >= since).slice((page - 1) * 100, page * 100));
      }
      const m = /issues\/(\d+)\/comments$/.exec(path);
      if (m) return JSON.stringify(comments.filter((c) => c.issue_url.endsWith(`/issues/${m[1]}`)));
      const one = /issues\/(\d+)$/.exec(path);
      if (one) return JSON.stringify(store.find((i) => i.number === Number(one[1])));
      if (++listCalls === failOnListCall) throw new Error("rate limited");
      const since = q.get("since");
      const sorted = store.filter((i) => !since || i.updated_at >= since).sort((x, y) => x.updated_at.localeCompare(y.updated_at) || x.number - y.number);
      const per = Number(q.get("per_page")), page = Number(q.get("page") ?? 1);
      return JSON.stringify(sorted.slice((page - 1) * per, page * per));
    };
    return { gh, calls };
  };
  const ts = (n) => new Date(Date.UTC(2026, 9, 1) + n * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const mkItems = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, updated_at: ts(i + 1), created_at: ts(0), state: "open", comments: 0, labels: [], user: { type: "Bot" } }));
  const telemetryComment = (issue, eid, event, updated, extra = {}) => ({ id: issue * 1000 + Number(eid.replace(/\D/g, "")), updated_at: updated, user: { type: "Bot" },
    issue_url: `https://api.github.com/repos/o/r/issues/${issue}`,
    body: `<!-- FORGE:TELEMETRY v1 -->\n\`\`\`jsonl\n${JSON.stringify({ v: 1, ts: updated, forge_version: "1.18.0", repo: "o/r", issue, run: `r_${issue}`, eid, event, phase: "build", cache_read_tokens: 100, ...extra })}\n\`\`\`` });

  it("saves a partial checkpoint on a mid-crawl failure and the next run resumes from it", async () => {
    const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(td, "cache-partial") };
    const store = mkItems(250);
    await assert.rejects(() => fetchGithubRecords({ repo: "o/r", gh: storeGh(store, { failOnListCall: 3 }).gh, env }), /rate limited/);
    const saved = JSON.parse(readFileSync(join(cacheDir("o/r", env), "cache.json"), "utf8"));
    assert.ok(saved.watermark, "partial watermark persisted");
    assert.ok(Object.keys(saved.items).length >= 100 && Object.keys(saved.items).length < 250);
    const b = storeGh(store);
    const resumed = await fetchGithubRecords({ repo: "o/r", gh: b.gh, env });
    assert.equal(resumed.fromCache, true);
    assert.ok(b.calls[0].includes("since="), "resumes from the watermark");
    assert.equal(resumed.items.length, 250);
  });
  it("a mid-crawl failure never advances the watermark past unpersisted telemetry (resume still finds it)", async () => {
    const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(td, "cache-pending-telemetry") };
    const store = mkItems(250);
    // A telemetry comment on the NEWEST issue (listed last), posted before the failing run starts.
    const comments = [telemetryComment(250, "z1", "phase_attempt", ts(250))];
    await assert.rejects(() => fetchGithubRecords({ repo: "o/r", gh: storeGh(store, { comments, failOnListCall: 3 }).gh, env }), /rate limited/);
    const saved = JSON.parse(readFileSync(join(cacheDir("o/r", env), "cache.json"), "utf8"));
    assert.ok(!saved.watermark, "watermark must not be persisted while telemetry records are unpersisted");
    // Resume: the comment is older than any watermark a buggy checkpoint would have saved.
    const resumed = await fetchGithubRecords({ repo: "o/r", gh: storeGh(store, { comments }).gh, env });
    assert.equal(resumed.items.length, 250);
    assert.deepEqual(resumed.records.map((r) => r.eid), ["z1"]);
    assert.equal(resumed.items.find((i) => i.number === 250).records.length, 1);
  });
  it("bounds the crawl by the window: API calls track the window, not the repo size", async () => {
    const store = mkItems(3000); // 3000 items, one per hour
    const from = ts(2990);
    const windowItems = store.filter((i) => i.updated_at >= from).length;
    const comments = store.slice(-5).map((i) => telemetryComment(i.number, `x${i.number}`, "phase_attempt", i.updated_at));
    const { gh, calls } = storeGh(store, { comments });
    const r = await fetchGithubRecords({ repo: "o/r", gh, useCache: false, since: from, env: ENV });
    assert.equal(r.items.length, windowItems);
    // 1 comments page + one refetch per telemetry issue + ceil(window / 100) list pages; never one call per repo item.
    const bound = 1 + comments.length + Math.ceil(windowItems / 100) + 1;
    assert.ok(r.apiCalls <= bound, `api calls ${r.apiCalls} exceed window bound ${bound}`);
    assert.equal(calls.length, r.apiCalls);
    assert.ok(calls.length < 30 && store.length > 100 * calls.length, `calls.length ${calls.length} must be far below the repo size`);
    assert.ok(calls.some((c) => /issues\/comments\?.*since=/.test(c)), "comments come from the repo-wide since= endpoint");
    assert.ok(!calls.some((c) => /issues\/\d+\/comments$/.test(c) && !comments.some((x) => x.issue_url.endsWith(c.match(/issues\/(\d+)\//)[1]))), "no comment call for items without telemetry");
    assert.equal(r.records.length, comments.length);
  });
  it("re-reads every part of an issue whose telemetry was touched in the window, and only those", async () => {
    const store = mkItems(20);
    const comments = [telemetryComment(7, "e1", "phase_attempt", ts(1)), telemetryComment(7, "e2", "run_terminal", ts(15), { reason: "merged" }),
      telemetryComment(9, "e1", "phase_attempt", ts(2))];
    const { gh, calls } = storeGh(store, { comments });
    const r = await fetchGithubRecords({ repo: "o/r", gh, useCache: false, since: ts(10), env: ENV });
    assert.deepEqual(r.records.filter((x) => x.issue === 7).map((x) => x.event).sort(), ["phase_attempt", "run_terminal"], "the pre-window part is fetched too");
    assert.equal(calls.filter((c) => /issues\/7\/comments$/.test(c)).length, 1);
    assert.equal(calls.filter((c) => /issues\/9\/comments$/.test(c)).length, 0, "issue 9 has no telemetry in the window");
  });
  it("accepts an async gh and awaits it", async () => {
    const store = mkItems(5);
    const { gh } = storeGh(store);
    const r = await fetchGithubRecords({ repo: "o/r", gh: async (a) => gh(a), useCache: false, env: ENV });
    assert.equal(r.items.length, 5);
  });
  it("records the coverage floor, crawls only the gap for a wider window and resets on --refresh", async () => {
    const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(td, "cache-floor") };
    const store = mkItems(100);
    const w1 = storeGh(store);
    const narrow = await fetchGithubRecords({ repo: "o/r", gh: w1.gh, env, since: ts(90) });
    assert.equal(narrow.items.length, 11);
    assert.equal(JSON.parse(readFileSync(join(cacheDir("o/r", env), "cache.json"), "utf8")).coveredFrom, ts(90));
    // same or narrower window: incremental from the watermark, floor unchanged
    const same = storeGh(store);
    await fetchGithubRecords({ repo: "o/r", gh: same.gh, env, since: ts(95) });
    assert.ok(/since=/.test(same.calls[0]) && !same.calls[0].includes(`since=${ts(95)}`), "resumes from the watermark, not the window start");
    assert.equal(JSON.parse(readFileSync(join(cacheDir("o/r", env), "cache.json"), "utf8")).coveredFrom, ts(90));
    // wider window: the uncovered gap is crawled (from the new start), then the floor is lowered
    const wide = storeGh(store);
    const r = await fetchGithubRecords({ repo: "o/r", gh: wide.gh, env, since: ts(50) });
    assert.ok(wide.calls[0].includes(`since=${ts(50)}`));
    assert.equal(r.items.length, 51, "the pre-window gap is not silently treated as covered");
    assert.equal(JSON.parse(readFileSync(join(cacheDir("o/r", env), "cache.json"), "utf8")).coveredFrom, ts(50));
    // no --since after a windowed run: full history is crawled and the floor becomes null
    const all = storeGh(store);
    assert.equal((await fetchGithubRecords({ repo: "o/r", gh: all.gh, env })).items.length, 100);
    assert.equal(JSON.parse(readFileSync(join(cacheDir("o/r", env), "cache.json"), "utf8")).coveredFrom, null);
    // --refresh ignores the cache and its floor
    const fresh = storeGh(store);
    await fetchGithubRecords({ repo: "o/r", gh: fresh.gh, env, refresh: true, since: ts(80) });
    assert.equal(JSON.parse(readFileSync(join(cacheDir("o/r", env), "cache.json"), "utf8")).coveredFrom, ts(80));
  });
  it("does not trust a legacy cache (no coveredFrom) for a window and never lowers the floor on failure", async () => {
    const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(td, "cache-legacy") };
    const store = mkItems(250);
    mkdirSync(cacheDir("o/r", env), { recursive: true });
    writeFileSync(join(cacheDir("o/r", env), "cache.json"), JSON.stringify({ v: 1, watermark: ts(250), items: {} }));
    const g = storeGh(store, { failOnListCall: 2 });
    await assert.rejects(() => fetchGithubRecords({ repo: "o/r", gh: g.gh, env, since: ts(10) }), /rate limited/);
    const saved = JSON.parse(readFileSync(join(cacheDir("o/r", env), "cache.json"), "utf8"));
    assert.equal(saved.watermark, ts(250), "failed gap crawl keeps the old watermark");
    assert.ok(!("coveredFrom" in saved) || saved.coveredFrom == null || saved.coveredFrom === undefined);
    const h = storeGh(store);
    const r = await fetchGithubRecords({ repo: "o/r", gh: h.gh, env, since: ts(10) });
    assert.ok(h.calls[0].includes(`since=${ts(10)}`));
    assert.equal(r.items.length, 241);
  });
  it("reports progress through onProgress and backs off when the rate limit is low", async () => {
    const store = mkItems(6000);
    const events = [];
    await fetchGithubRecords({ repo: "o/r", gh: storeGh(store).gh, useCache: false, env: ENV, onProgress: (e) => events.push(e) });
    assert.ok(events.some((e) => e.phase === "comments") && events.some((e) => e.phase === "issues" && e.done === 6000));
    const slept = [];
    const base = storeGh(store).gh;
    const gh = (args) => (args.join(" ") === "api rate_limit" ? JSON.stringify({ resources: { core: { remaining: 3, reset: 1_000_100 } } }) : base(args));
    await fetchGithubRecords({ repo: "o/r", gh, useCache: false, env: ENV, rateCheck: true, now: () => 1_000_000_000, sleep: async (ms) => { slept.push(ms); } });
    assert.ok(slept.length > 0 && slept[0] === 101000, `slept ${slept}`);
  });
  it("never skips an item updated mid-crawl (keyset crawl, not page-number pagination)", async () => {
    const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(td, "cache-midcrawl") };
    const ts = (n) => new Date(Date.UTC(2026, 9, 1) + n * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const store = Array.from({ length: 250 }, (_, i) => ({ number: i + 1, updated_at: ts(i + 1), created_at: ts(0), state: "open", comments: 0, labels: [], user: { type: "Bot" } }));
    let listCalls = 0;
    let maxUpdated = 250;
    // Page-aware fake of the real API: asc by updated_at, honours since (inclusive), per_page and page. After the first
    // listing call an already-served item is bumped, which moves it to the end of the ordering.
    const gh = (args) => {
      const path = args.find((a) => a.startsWith("repos/"));
      if (/issues\/comments\?/.test(path)) return "[]";
      const q = new URLSearchParams(path.split("?")[1]);
      listCalls++;
      const since = q.get("since");
      const sorted = store.filter((i) => !since || i.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.number - b.number);
      const per = Number(q.get("per_page")), page = Number(q.get("page") ?? 1);
      const out = JSON.stringify(sorted.slice((page - 1) * per, page * per));
      if (listCalls === 1) store[4].updated_at = ts(++maxUpdated);
      return out;
    };
    const first = await fetchGithubRecords({ repo: "o/r", gh, env });
    assert.equal(first.items.length, 250, "every item is cached after the crawl, none skipped by the shift");
    assert.equal(new Set(first.items.map((i) => i.number)).size, 250);
    // The bumped item moved past the crawl cursor, so the next incremental run (and its overlap window) still sees it.
    store[9].updated_at = ts(++maxUpdated); // another item updated after the first run
    const second = await fetchGithubRecords({ repo: "o/r", gh, env });
    assert.equal(second.fromCache, true);
    assert.equal(second.items.length, 250);
    assert.equal(second.items.find((i) => i.number === 10).updatedAt, store[9].updated_at);
    assert.equal(second.items.find((i) => i.number === 5).updatedAt, store[4].updated_at);
  });
  it("terminates and drains a full page whose items all share one updated_at", async () => {
    const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(td, "cache-sameTs") };
    const store = Array.from({ length: 230 }, (_, i) => ({ number: i + 1, updated_at: "2026-10-02T00:00:00Z", created_at: "2026-10-01T00:00:00Z", comments: 0, labels: [], user: { type: "Bot" } }));
    const gh = (args) => {
      if (/issues\/comments\?/.test(args.find((a) => a.startsWith("repos/")))) return "[]";
      const q = new URLSearchParams(args.find((a) => a.startsWith("repos/")).split("?")[1]);
      const per = Number(q.get("per_page")), page = Number(q.get("page") ?? 1);
      const since = q.get("since");
      return JSON.stringify(store.filter((i) => !since || i.updated_at >= since).slice((page - 1) * per, page * per));
    };
    assert.equal((await fetchGithubRecords({ repo: "o/r", gh, env })).items.length, 230);
  });
  it("rejects an unsafe repo before any gh call", async () => {
    const { gh, calls } = fakeGh();
    await assert.rejects(() => fetchGithubRecords({ repo: "o/r; rm -rf /", gh }), /invalid repo/);
    assert.equal(calls.length, 0);
  });
});

describe("cli", () => {
  it("parses flags and rejects bad input", () => {
    const o = parseArgs(["--since", "1.2.0", "--repo=o/r", "--json", "--refresh", "--min-n", "3"]);
    assert.deepEqual([o.since, o.repo, o.json, o.refresh, o.minN], ["1.2.0", "o/r", true, true, 3]);
    assert.throws(() => parseArgs(["--since"]), /needs a value/);
    assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
    assert.throws(() => parseSince("yesterday"), /--since must be/);
  });
  it("resolves --since to a crawl lower bound (date as is, version via release time minus a margin)", () => {
    assert.equal(sinceToTimestamp("2026-10-01").since, "2026-10-01T00:00:00Z");
    assert.equal(sinceToTimestamp(undefined).since, null);
    const v = sinceToTimestamp("v1.16.0", [{ v: "1.16.0", t: Date.parse("2026-10-05T00:00:00Z") / 1000 }]);
    assert.equal(v.since, "2026-10-04T00:00:00Z");
    const unknown = sinceToTimestamp("1.99.0", []);
    assert.equal(unknown.since, null);
    assert.match(unknown.note, /full history/);
  });
  it("prints progress to stderr only, throttled, and keeps --json stdout parseable", async () => {
    const out = [];
    let t = 0;
    const print = makeProgressPrinter((x) => out.push(x), () => t);
    print({ phase: "issues", done: 100, total: null });
    t += 500; print({ phase: "issues", done: 200, total: null });
    t += 2000; print({ phase: "issues", done: 300, total: null });
    assert.equal(out.length, 2);
    const { gh } = fakeGh();
    const realOut = process.stdout.write, realErr = process.stderr.write;
    let stdout = "", stderr = "";
    process.stdout.write = (c) => { stdout += c; return true; };
    process.stderr.write = (c) => { stderr += c; return true; };
    try { assert.equal(await runStats(["--repo", "o/r", "--json", "--no-cache", "--no-local"], { gh, env: ENV, releaseTimes: [] }), 0); } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
    assert.ok(JSON.parse(stdout).groups, "stdout is only the JSON report");
    assert.match(stderr, /forgedock stats: (comments|issues) /);
  });
  it("--help exits 0 and importing the module did not run it", () => {
    const r = spawnSync(process.execPath, [join(here, "index.mjs"), "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--since/);
    assert.match(r.stdout, /--refresh/);
  });
  it("runStats returns 2 for an unusable repo", async () => {
    const real = process.stderr.write;
    process.stderr.write = () => true;
    try { assert.equal(await runStats(["--repo", "bad repo"]), 2); } finally { process.stderr.write = real; }
  });
});

describe("audit queries (forge#4165)", () => {
  const rec = (o) => ({ v: 1, repo: "o/r", run: null, forge_version: "1.20.0", ...o });
  const RECS = [
    rec({ eid: "s1", ts: "2026-10-10T10:00:00Z", issue: 11, pr: 21, phase: "merge", event: "structure_delta", deps_added: "@s/web:@s/db", new_edges: "none", removed_edges: "none", decisions: "K1:lint", milestone: "M One" }),
    rec({ eid: "s2", ts: "2026-10-11T10:00:00Z", issue: 12, pr: 22, phase: "merge", event: "structure_delta", deps_added: "none", new_edges: "@s/web:@s/db,@s/web:@s/core", removed_edges: "@s/a:@s/b", milestone: "M One" }),
    rec({ eid: "s3", ts: "2026-10-11T11:00:00Z", issue: 13, pr: 23, phase: "merge", event: "structure_delta", deps_added: "none", new_edges: "@s/x:@s/db" }),
    rec({ eid: "s4", ts: "2026-10-09T10:00:00Z", issue: 14, phase: "implement", event: "structure_delta", edges_added: 1 }),
    rec({ eid: "t1", ts: "2026-10-10T10:01:00Z", issue: 11, pr: 21, event: "run_terminal", reason: "merged", conformance_mode: "shadow", shadow_would: "conforms", milestone: "M One" }),
    rec({ eid: "t2", ts: "2026-10-11T10:01:00Z", issue: 12, pr: 22, event: "run_terminal", reason: "merged", conformance_mode: "shadow", shadow_would: "conformance.scope" }),
    rec({ eid: "t3", ts: "2026-10-11T11:01:00Z", issue: 13, pr: 23, event: "run_terminal", reason: "merged", conformance_mode: "enforce", milestone: "M Two" }),
  ];
  const ITEMS = [{ number: 11, milestone: "M One" }, { number: 12, milestone: "M One" }, { number: 13, milestone: null }];

  it("parseEdge splits on the last colon and rejects malformed input", () => {
    assert.deepEqual(parseEdge("@s/web:@s/db"), { from: "@s/web", to: "@s/db" });
    for (const bad of ["", "nocolon", ":b", "a:"]) assert.equal(parseEdge(bad), null, bad);
  });
  it("lists the PRs that added an edge, package or import, oldest first; exact element match only", () => {
    assert.deepEqual(edgeQuery(RECS, "@s/web", "@s/db"), [
      { issue: 11, pr: 21, ts: "2026-10-10T10:00:00Z", kind: "package", milestone: "M One" },
      { issue: 12, pr: 22, ts: "2026-10-11T10:00:00Z", kind: "import", milestone: "M One" },
    ]);
    assert.deepEqual(edgeQuery(RECS, "@s/web", "@s/d"), [], "a prefix is not the edge");
    assert.deepEqual(edgeQuery(RECS, "@s/a", "@s/b"), [], "a removed edge is not an added one");
  });
  it("verdict mix and structure series for a milestone (issue metadata first, then the record's own field)", () => {
    const m = verdictMix(RECS, ITEMS, "M One");
    assert.equal(m.runs, 2);
    assert.deepEqual(m.verdicts, { conforms: 1, "conformance.scope": 1 });
    assert.deepEqual(m.modes, { shadow: 2 });
    assert.deepEqual(m.series, [{ date: "2026-10-10", merged: 1, deps_added: 1, new_edges: 0, removed_edges: 0 }, { date: "2026-10-11", merged: 1, deps_added: 0, new_edges: 2, removed_edges: 1 }]);
    assert.equal(verdictMix(RECS, [], "M Two").runs, 1, "falls back to the record's milestone");
    assert.equal(verdictMix(RECS, ITEMS, null).runs, 3, "no milestone: the whole repo");
  });
  it("buildReport --edge/--milestone answers from telemetry records alone; the version report is unchanged without them", async () => {
    const body = `<!-- FORGE:TELEMETRY v1 -->\n\`\`\`jsonl\n${RECS.filter((r) => r.issue === 11 || r.issue === 12).map((r) => JSON.stringify(r)).join("\n")}\n\`\`\``;
    const issues = [11, 12].map((n) => ({ number: n, labels: [], created_at: "2026-10-09T00:00:00Z", closed_at: null, updated_at: "2026-10-11T12:00:00Z", user: { type: "Bot" }, milestone: { title: "M One" } }));
    const gh = (args) => {
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      if (/issues\/(11|12)\/comments$/.test(path)) return JSON.stringify(path.includes("/11/") ? [{ body, user: { type: "Bot" } }] : []);
      if (/issues\/comments\?/.test(path)) return JSON.stringify(/page=1(&|$)/.test(path) ? [{ body, user: { type: "Bot" }, issue_url: "https://api.github.com/repos/o/r/issues/11" }] : []);
      return JSON.stringify(issues);
    };
    const opts = { repo: "o/r", local: false, cache: false, minN: 10, ...parseArgs(["--edge", "@s/web:@s/db", "--milestone", "M One"]) };
    const report = await buildReport({ ...opts, repo: "o/r", local: false, cache: false }, { gh, env: ENV, releaseTimes: [] });
    assert.deepEqual(report.query.edge.prs.map((p) => [p.pr, p.kind]), [[21, "package"], [22, "import"]]);
    assert.deepEqual(report.query.mix.verdicts, { conforms: 1, "conformance.scope": 1 });
    assert.ok(!("groups" in report));
    assert.throws(() => parseArgs(["--edge", "nocolon"]), /--edge must be FROM:TO/);
    assert.deepEqual([parseArgs([]).edge, parseArgs([]).milestone], [null, null]);
  });
});

describe("context-pack A/B over run logs (forge#4275)", () => {
  const use = (phase, turns, cr, usd) => ({ event: "PHASE_ATTEMPT_USAGE", phase, turns, cost_usd: usd, usage: { cache_read_input_tokens: cr, cache_creation_input_tokens: 10, output_tokens: 1 } });
  const log = (mode, lt, { reason = "merged", builds = 2, reviews = 1 } = {}) => [
    { event: "RUN_START", issue: 1, repo: "o/r", run: "r" },
    ...(mode !== "off" ? [{ event: "CONTEXT_PACK", mode, lane_type: lt, bytes: 100 }] : []),
    ...Array.from({ length: builds }, () => use("implement", 5, 1000, 0.5)),
    ...Array.from({ length: reviews }, () => use("review", 2, 100, 0.1)),
    { event: "RUN_TERMINAL", reason, code: "x", context_pack: mode, lane_type: lt },
  ];

  it("summariseLog carries mode, lane type, builder turns, cache tokens, cost and first-pass", () => {
    const s = summariseLog(log("on", "child"));
    assert.deepEqual(s.contextPack, { mode: "on", laneType: "child", ab: false });
    assert.deepEqual([s.builderTurns, s.cacheTokens, s.costUsd, s.firstPass], [10, 2130, 1.1, true]);
    assert.equal(summariseLog(log("on", "child", { builds: 4 })).firstPass, false);
    assert.equal(summariseLog(log("on", "child", { reason: "needs-human" })).firstPass, false);
    const fixed = log("on", "child"); fixed.splice(-1, 0, { event: "CI_FIX_ROUND", trigger: "build", round: 1 });
    assert.equal(summariseLog(fixed).firstPass, false);
    assert.equal(summariseLog([{ event: "RUN_START", issue: 3 }, { event: "RUN_TERMINAL", reason: "merged" }]).contextPack.mode, "off");
    assert.equal(summariseLog([{ event: "RUN_START", issue: 3 }, { event: "RUN_TERMINAL", reason: "merged" }]).size, null);
    assert.equal(summariseLog([{ event: "RUN_START", issue: 3 }, { event: "RUN_TERMINAL", reason: "merged", turns: { size: "L", budget: 100, build: 9 } }]).size, "L"); // #4409
  });

  it("reports per lane type and mode, never one blended average", () => {
    const runs = [log("on", "first"), log("on", "first", { builds: 4, reviews: 2 }), log("off", "first"), log("shadow", "rerun"),
      [{ event: "RUN_START", issue: 2 }, { event: "RUN_TERMINAL", reason: "merged" }]].map((l) => summariseLog(l));
    const ab = contextPackAb(runs);
    assert.deepEqual(Object.keys(ab), ["rerun", "child", "first", "recovery"]);
    assert.deepEqual(ab.first.on, { n: 2, first_pass_yield: 0.5, builder_turns: 15, cache_tokens: 3195, cost_usd: 1.65, merged: 2, turns_per_merge: 15, cache_read_per_merge: 3150, rework_rate: 0 });
    assert.equal(ab.first.off.n, 1); assert.equal(ab.first.off.first_pass_yield, 1);
    assert.equal(ab.rerun.shadow.n, 1); assert.equal(ab.child.on.n, 0); assert.equal(ab.child.on.cost_usd, null);
    assert.match(renderContextAb(ab), /\| first \| on \| 2 \| 0\.5 \| 15 \| 3195 \| 1\.65 \|/);
  });

  it("--context-ab reads run logs only (no GitHub crawl)", async () => {
    assert.equal(parseArgs(["--context-ab"]).contextAb, true);
    const rep = await buildReport({ repo: "o/r", contextAb: true }, { localRuns: [summariseLog(log("on", "first"))], releaseTimes: [], gh: async () => { throw new Error("no network"); } });
    assert.equal(rep.query.context_ab.first.on.n, 1);
  });
});

describe("context-pack A/B per merge, rework and recovery vs first (#4444)", () => {
  const use = (trigger, turns, cr, out) => ({ event: "PHASE_ATTEMPT_USAGE", phase: "implement", trigger, turns, cost_usd: 0.5, usage: { cache_read_input_tokens: cr, cache_creation_input_tokens: 10, output_tokens: out } });
  const slice = (issue, lt, { reason = "merged", mode = "on", ab = false, calls = [["plan", 2, 100, 10], ["build", 10, 1000, 400]], extra = [] } = {}) => [
    { event: "RUN_START", issue, repo: "o/r", run: `r${issue}${lt}`, ts: lt === "rerun" ? "2026-10-02T00:00:00Z" : "2026-10-01T00:00:00Z" },
    ...calls.map((c) => use(...c)), ...extra,
    { event: "RUN_TERMINAL", reason, code: "x", context_pack: mode, lane_type: lt, ...(ab ? { context_ab: true } : {}) },
  ];

  it("summariseLog: cache-read alone, the implement attempt without the plan call, the ab tag and the log's first-run baseline", () => {
    const s = summariseLog([...slice(5, "first"), ...slice(5, "rerun", { ab: true, calls: [["recover", 3, 50, 100]] })]);
    assert.equal(s.cacheReadTokens, 50);
    assert.deepEqual(s.implementAttempt, { turns: 3, output_tokens: 100 });
    assert.deepEqual(s.firstRunAttempt, { turns: 10, output_tokens: 400 });
    assert.equal(s.contextPack.ab, true);
    assert.equal(summariseLog(slice(5, "first")).firstRunAttempt, null);
    assert.deepEqual(summariseLog(slice(6, "first", { calls: [] })).implementAttempt, null);
  });

  it("per-merge turns and cache-read, rework rate and the same-issue recovery ratio", () => {
    const runs = [summariseLog(slice(1, "first")), summariseLog(slice(2, "first", { reason: "needs-human" })),
      summariseLog(slice(3, "first", { extra: [{ event: "PHASE_COMMIT", phase: "remediate" }] })),
      summariseLog([...slice(4, "first"), ...slice(4, "rerun", { calls: [["recover", 5, 0, 100]] })]),
      summariseLog(slice(1, "rerun", { calls: [["recover", 2, 0, 200]] }))];
    const ab = contextPackAb(runs);
    // three runs: 12 builder turns each, 1100 cache-read each, two merged
    assert.deepEqual([ab.first.on.merged, ab.first.on.turns_per_merge, ab.first.on.cache_read_per_merge, ab.first.on.rework_rate], [2, 18, 1650, 0.3333]);
    assert.equal(ab.rerun.on.rework_rate, 1);
    assert.equal(ab.child.on.turns_per_merge, null);
    // issue 4: 5/10 turns, 100/400 output (own log); issue 1: 2/10 turns, 200/400 output (earlier first run in `runs`)
    assert.deepEqual(ab.recovery, { pairs: 2, mean_turn_ratio: 0.35, mean_output_ratio: 0.375 });
    const md = renderContextAb(ab);
    assert.match(md, /\| Merged \| Turns\/merge \| Cache-read\/merge \| Rework rate \|/);
    assert.match(md, /\| first \| on \| 3 \| .* \| 2 \| 18 \| 1650 \| 0\.3333 \|/);
    assert.match(md, /Recovery vs first run \(same issue\): 2 pair\(s\), implement turns ratio 0\.35, output tokens ratio 0\.375/);
    assert.deepEqual(contextPackAb([]).recovery, { pairs: 0, mean_turn_ratio: null, mean_output_ratio: null });
  });
});

describe("builder model tiers over run logs (forge#4394)", () => {
  const use = (phase, trigger, usd = 1) => ({ event: "PHASE_ATTEMPT_USAGE", phase, trigger, cost_usd: usd, usage: { cache_read_input_tokens: 1, output_tokens: 1 } });
  const slice = (issue, { tier = "mid", cls = "small", escalated = false, reason = "merged", triggers = ["plan", "build"], review = true, shadow } = {}) => [
    { event: "RUN_START", issue, repo: "o/r", run: `r${issue}` },
    ...triggers.map((t) => use("implement", t)), ...(review ? [use("review", "review", 0.5)] : []),
    { event: "RUN_TERMINAL", reason, code: "x", ...(shadow ? { shadow_would: shadow } : {}), builder_tier: tier, builder_class: cls, builder_escalated: escalated, builder_model: tier === "mid" ? "claude-sonnet-5-5" : "default" },
  ];

  it("summariseLog reads builderRoute from RUN_TERMINAL, else the BUILDER_ROUTE/BUILDER_ESCALATED events; null before routing", () => {
    const s = summariseLog(slice(1, { escalated: true, triggers: ["plan", "build", "conformance"], shadow: "conformance.scope" }));
    assert.deepEqual(s.builderRoute, { tier: "mid", class: "small", escalated: true, model: "claude-sonnet-5-5" });
    assert.equal(s.conformanceRound, true); assert.equal(s.shadowWould, "conformance.scope"); assert.equal(s.reachedReview, true);
    const evs = [{ event: "RUN_START", issue: 2 }, { event: "BUILDER_ROUTE", tier: "mid", class: "docs-config-test", model: "m" }, { event: "BUILDER_ESCALATED", from: "m", to: "default", trigger: "ci_red" }, { event: "RUN_TERMINAL", reason: "merged" }];
    assert.deepEqual(summariseLog(evs).builderRoute, { tier: "mid", class: "docs-config-test", escalated: true, model: "m" });
    const old = summariseLog([{ event: "RUN_START", issue: 3 }, { event: "RUN_TERMINAL", reason: "merged" }]);
    assert.equal(old.builderRoute, null); assert.equal(old.conformanceRound, false); assert.equal(old.shadowWould, null);
  });

  it("reports merge, conformance and post-merge-rework rates per tier and class; unrouted runs are left out", () => {
    const reworked = [...slice(5, { tier: "top", cls: "large" }), ...slice(5, { tier: "top", cls: "large", reason: "needs-human" })]; // a later run of a merged issue
    const runs = [slice(1), slice(2, { triggers: ["plan", "build", "review"] }), slice(3, { reason: "needs-human", review: false }),
      slice(4, { escalated: true, triggers: ["plan", "build", "precheck"] }), reworked, [{ event: "RUN_START", issue: 9 }, { event: "RUN_TERMINAL", reason: "merged" }]].map((l) => summariseLog(l));
    const rep = builderTierReport(runs);
    assert.equal(rep.unrouted, 1);
    assert.deepEqual(rep.rows.map((g) => [g.tier, g.class]), [["mid", "small"], ["mid->top", "small"], ["top", "large"]]);
    const [mid, esc, top] = rep.rows;
    assert.deepEqual([mid.n, mid.merge_rate, mid.reviewed, mid.conformance_rate, mid.merges, mid.post_merge_rework_rate, mid.first_pass_yield], [3, 0.6667, 2, 0.5, 2, 0, 0.3333]);
    assert.deepEqual([esc.n, esc.merge_rate, esc.conformance_rate], [1, 1, 1]);
    assert.deepEqual([top.n, top.merge_rate, top.merges, top.post_merge_rework_rate], [1, 0, 1, 1]);
    const md = renderTiers(rep);
    assert.match(md, /\| mid \| small \| 3 \| 0\.6667 \| 0\.5 \(2\) \| 0 \(2\) \| 0\.3333 \|/);
    assert.match(md, /\| top \| large \| 1 \| 0 \| .* \| 1 \(1\) \|/);
    assert.match(md, /1 finished run\(s\) without a builder route/);
    assert.match(renderTiers(builderTierReport([])), /\| none \|/);
  });

  it("--tiers reads run logs only (no GitHub crawl); other reports carry no tiers", async () => {
    assert.equal(parseArgs(["--tiers"]).tiers, true); assert.equal(parseArgs([]).tiers, false);
    const rep = await buildReport({ repo: "o/r", tiers: true }, { localRuns: [summariseLog(slice(1))], releaseTimes: [], gh: async () => { throw new Error("no network"); } });
    assert.equal(rep.query.tiers.rows[0].n, 1);
  });
});

describe("rework by trigger and first-pass rate (#4362)", () => {
  const use = (attempt, trigger, usd, phase = "implement") => ({ event: "PHASE_ATTEMPT_USAGE", phase, attempt, ...(trigger ? { trigger } : {}), cost_usd: usd, usage: { cache_read_input_tokens: 10, output_tokens: 1 } });
  const log = (issue, attempts) => [{ event: "RUN_START", issue, repo: "o/r", run: `r${issue}`, version: "1.30.0", ts: "2026-10-20T00:00:00Z" }, ...attempts,
    { event: "RUN_TERMINAL", reason: "merged", ts: "2026-10-20T01:00:00Z" }];
  const runs = [
    log(1, [use(1, "plan", 1), use(2, "build", 3)]),
    log(2, [use(1, "plan", 1), use(2, "build", 3), use(3, "precheck", 2), use(4, "review", 4), use(1, "review", 0.2, "review")]),
    log(3, [use(1, "plan", 1), use(2, "build", 3), use(3, "timeout_restart", 1), use(4, "recovery", 1)]),
    log(4, [use(1, null, 1), use(2, null, 3), use(3, null, 5)]), // written before the field existed
    log(5, [use(1, "plan", 1)]), // closed at the plan: never reached the build
  ].map((l) => summariseLog(l));

  it("summariseLog keeps builder attempts in order with their trigger (null when untagged)", () => {
    assert.deepEqual(runs[1].builderAttempts.map((a) => a.trigger), ["plan", "build", "precheck", "review"]);
    assert.deepEqual(runs[3].builderAttempts.map((a) => [a.attempt, a.trigger, a.cost_usd]), [[1, null, 1], [2, null, 3], [3, null, 5]]);
  });

  it("aggregate counts rework by trigger (untagged as unknown, never dropped) and the first-pass rate with counts", () => {
    const g = aggregate({ runs }).groups[0];
    assert.deepEqual(g.rework.byTrigger, { precheck: { n: 1, usd: 2 }, review: { n: 1, usd: 4 }, unknown: { n: 3, usd: 9 } });
    assert.deepEqual([g.rework.n, g.rework.usd], [5, 15]);
    assert.deepEqual(g.rework.attempts.build, { n: 3, usd: 9 });
    assert.deepEqual(g.firstPass, { rate: 2 / 3, firstPass: 2, n: 3, unknown: 1 });
    const md = renderMarkdown(aggregate({ runs }));
    assert.match(md, /first-pass rate \| 67% \(2\/3 lanes that reached the build, 1 unknown\)/);
    assert.match(md, /### Rework by trigger/);
    assert.match(md, /\| unknown \| 3 \| \$9\.00 \|/);
    assert.match(md, /\| total \| 5 \| \$15\.00 \|/);
  });

  it("GitHub phase_attempt records carry the trigger into builderAttempts, ordered by attempt", () => {
    const rec = (attempt, trigger, ts) => ({ event: "phase_attempt", repo: "o/r", issue: 9, run: "r_9", phase: "implement", attempt, ...(trigger ? { trigger } : {}), cost_usd: 1, output_tokens: 1, ts });
    const [run] = runsFromRecords([rec(3, "ci_red", "t3"), rec(1, "plan", "t1"), rec(2, "build", "t2"), rec(2, "timeout_restart", "t2b"), rec(4, null, "t4"),
      { event: "run_terminal", repo: "o/r", issue: 9, run: "r_9", reason: "merged", ts: "t5" }]);
    assert.deepEqual(run.builderAttempts.map((a) => [a.attempt, a.trigger]), [[1, "plan"], [2, "build"], [2, "timeout_restart"], [3, "ci_red"], [4, null]]);
  });
});

describe("per-attempt cost deltas (#4407)", () => {
  const use = (attempt, usd, delta, phase = "implement") => ({ event: "PHASE_ATTEMPT_USAGE", phase, attempt, trigger: attempt === 1 ? "plan" : "build", cost_usd: usd,
    ...(delta === undefined ? {} : { cost_usd_delta: delta, cost_usd_session: usd }), usage: { cache_read_input_tokens: 10, output_tokens: 1 } });
  const log = (attempts) => [{ event: "RUN_START", issue: 1, repo: "o/r", run: "r1", version: "1.30.0", ts: "2026-10-20T00:00:00Z" }, ...attempts,
    { event: "RUN_TERMINAL", reason: "merged", ts: "2026-10-20T01:00:00Z" }];

  it("a local run sums cost_usd_delta when present, else cost_usd (old logs)", () => {
    const r = summariseLog(log([use(1, 2, 2), use(2, 5, 3), use(1, 0.5, 0.5, "review")]));
    assert.equal(r.costUsd, 5.5);
    assert.equal(r.phases.implement.usd, 5);
    assert.deepEqual(r.builderAttempts.map((a) => a.cost_usd), [2, 3]);
    const old = summariseLog(log([use(1, 2), use(2, 5)]));
    assert.equal(old.costUsd, 7); assert.deepEqual(old.builderAttempts.map((a) => a.cost_usd), [2, 5]);
  });

  it("GitHub phase_attempt records sum cost_usd_delta when present, else cost_usd", () => {
    const rec = (attempt, usd, delta) => ({ event: "phase_attempt", repo: "o/r", issue: 9, run: "r_9", phase: "implement", attempt, cost_usd: usd, ...(delta === undefined ? {} : { cost_usd_delta: delta }), output_tokens: 1, ts: `t${attempt}` });
    const [run] = runsFromRecords([rec(1, 2, 2), rec(2, 5, 3), rec(3, 4), { event: "run_terminal", repo: "o/r", issue: 9, run: "r_9", reason: "merged", ts: "t9" }]);
    assert.equal(run.phases.implement.usd, 9);
    assert.deepEqual(run.builderAttempts.map((a) => a.cost_usd), [2, 3, 4]);
  });
});

describe("first-pass rate with and without matching pitfalls (#4375)", () => {
  const use = (attempt, trigger) => ({ event: "PHASE_ATTEMPT_USAGE", phase: "implement", attempt, trigger, cost_usd: 1, usage: { cache_read_input_tokens: 10, output_tokens: 1 } });
  const log = (issue, attempts, { term = {}, pack = null } = {}) => [{ event: "RUN_START", issue, repo: "o/r", run: `r${issue}`, version: "1.30.0", ts: "2026-10-20T00:00:00Z" },
    ...(pack ? [{ event: "CONTEXT_PACK", mode: "shadow", pitfalls: pack }] : []), ...attempts, { event: "RUN_TERMINAL", reason: "merged", ts: "2026-10-20T01:00:00Z", ...term }];
  const clean = [use(1, "plan"), use(2, "build")], rework = [...clean, use(3, "precheck")];

  it("summariseLog reads pitfalls_matched from RUN_TERMINAL, else the CONTEXT_PACK pitfalls, else null", () => {
    assert.equal(summariseLog(log(1, clean, { term: { pitfalls_matched: 2 } })).pitfallsMatched, 2);
    assert.equal(summariseLog(log(1, clean, { pack: [{ sig: "a", match: "files" }, { sig: "b", match: "repo" }] })).pitfallsMatched, 1);
    assert.equal(summariseLog(log(1, clean)).pitfallsMatched, null, "older logs: unknown");
  });

  it("aggregate splits the first-pass rate by matching pitfalls and leaves unknown runs out; render prints both rows", () => {
    const runs = [
      log(1, clean, { term: { pitfalls_matched: 1 } }), log(2, clean, { term: { pitfalls_matched: 3 } }), log(3, rework, { term: { pitfalls_matched: 1 } }),
      log(4, rework, { term: { pitfalls_matched: 0 } }), log(5, clean, { term: { pitfalls_matched: 0 } }), log(6, rework, { term: { pitfalls_matched: 0 } }),
      log(7, clean), // no pitfall field: unknown
    ].map((l) => summariseLog(l));
    const g = aggregate({ runs }).groups[0];
    assert.deepEqual(g.firstPassByPitfalls, { with: { rate: 2 / 3, firstPass: 2, n: 3 }, without: { rate: 1 / 3, firstPass: 1, n: 3 } });
    assert.equal(g.firstPass.n, 7, "the overall rate still counts every lane");
    const md = renderMarkdown(aggregate({ runs }));
    assert.match(md, /first-pass with matching pitfalls \| 67% \(2\/3\)/);
    assert.match(md, /first-pass without matching pitfalls \| 33% \(1\/3\)/);
    const none = renderMarkdown(aggregate({ runs: [log(8, clean)].map((l) => summariseLog(l)) }));
    assert.ok(!/matching pitfalls/.test(none), "no pitfall data: no rows");
  });
});

describe("fail-soft alerts (#4354)", () => {
  const ts = (i) => new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString();
  // One lane per call; `extra` are the events after RUN_START.
  const lane = (i, extra = [], { repo = "o/r", code = "completed", reason = "merged" } = {}) => [
    { event: "RUN_START", ts: ts(i), repo, issue: 100 + i }, ...extra, ...(code ? [{ event: "RUN_TERMINAL", reason, code }] : [])];
  const deps = (eco, status, why = null) => ({ event: "DEPS_PREPARED", eco, status, reason: why });
  const lanes = (n, f, o) => Array.from({ length: n }, (_, i) => lanesOfLog(lane(i, f(i), typeof o === "function" ? o(i) : o))[0]);

  it("DEPS_PREPARED failed above 20% per ecosystem, with rate, sample and an example reason; healthy ecosystems stay quiet", () => {
    const l = lanes(10, (i) => [deps("pnpm", i < 3 ? "failed" : "hit", "tool not found: spawn pnpm ENOENT"), deps("uv", "hit")]);
    const a = computeAlerts(l, { repo: "o/r" });
    assert.deepEqual(a.map((x) => [x.event, x.count, x.sample]), [["DEPS_PREPARED failed (pnpm)", 3, 10]]);
    assert.equal(a[0].example, "tool not found: spawn pnpm ENOENT");
    assert.deepEqual(computeAlerts(lanes(10, (i) => [deps("uv", i < 2 ? "failed" : "hit")]), { repo: "o/r" }), [], "exactly 20% is not above");
    const line = renderAlerts(a)[0];
    assert.match(line, /^DEPS_PREPARED failed \(pnpm\): 30% \(3\/10 lanes, threshold 20%\), e\.g\. "tool not found: spawn pnpm ENOENT"$/);
  });

  it("deferred-to-ci above 30% of lanes and a TOOLCHAIN_WARNING repeated on more than 50% of lanes", () => {
    const pre = (deferred) => ({ event: "PRECHECK_COMMANDS", round: 0, results: [{ command: "npm test", rc: 0, ms: 5 }, ...(deferred ? [{ command: "npx tsc", status: "deferred-to-ci" }] : [])] });
    const warn = { event: "TOOLCHAIN_WARNING", warning: "host node v26 does not satisfy the .nvmrc pin \"22\"" };
    const a = computeAlerts(lanes(10, (i) => [pre(i < 4), ...(i < 6 ? [warn] : [])]), { repo: "o/r" });
    assert.deepEqual(a.map((x) => [x.event, x.count, x.sample, x.example]), [["deferred-to-ci", 4, 10, "npx tsc"], ["TOOLCHAIN_WARNING", 6, 10, warn.warning]]);
    assert.deepEqual(computeAlerts(lanes(10, (i) => [pre(i < 3), ...(i < 5 ? [warn] : [])]), { repo: "o/r" }), [], "30% and 50% are not above");
  });

  it("an outcome code whose share doubled against the previous window; needs a full previous window; completed never alerts", () => {
    // 20 lanes, window 10: previous window has 1 ci.red (10%), current has 3 (30%)
    const code = (i) => ({ code: [0, 12, 15, 18].includes(i) ? "ci.red" : "completed", reason: [0, 12, 15, 18].includes(i) ? "needs-human" : "merged" });
    const l = lanes(20, () => [], code);
    const a = computeAlerts(l, { repo: "o/r", window: 10 });
    assert.deepEqual(a.map((x) => [x.event, x.count, x.sample, x.prevRate, x.example]), [["outcome ci.red", 3, 10, 0.1, "#118 needs-human"]]);
    assert.match(renderAlerts(a)[0], /^outcome ci\.red: 30% \(3\/10 lanes, previous window 10%, threshold 2x\), e\.g\. "#118 needs-human"$/);
    assert.deepEqual(computeAlerts(l.slice(5), { repo: "o/r", window: 10 }), [], "a previous window under min_lanes never compares");
    assert.deepEqual(computeAlerts(lanes(20, () => [], (i) => ({ code: i < 15 ? "invalid" : "completed" })), { repo: "o/r", window: 10 }), []);
  });

  it("rolling window per repo, ordered by start: old failures and other repos fall out; under 10 lanes or no logs gives nothing", () => {
    const bad = lanes(10, () => [deps("pnpm", "failed", "x")]);
    const good = lanes(50, () => [deps("pnpm", "hit")]).map((l, i) => ({ ...l, startTs: ts(100 + i) }));
    assert.deepEqual(computeAlerts([...good, ...bad], { repo: "o/r" }), [], "the 50 newest lanes are healthy");
    assert.equal(computeAlerts(bad, { repo: "o/r" }).length, 1);
    assert.deepEqual(computeAlerts(bad, { repo: "x/y" }), []);
    assert.deepEqual(computeAlerts(bad.slice(1), { repo: "o/r" }), [], "9 lanes is too few");
    assert.deepEqual(computeAlerts([], { repo: "o/r" }), []);
    assert.deepEqual(readLanes(join(td, "missing")), []);
  });

  it("readLanes splits every RUN_START slice of every log (local files only) and keeps the repo", () => {
    const dir = join(td, "runs"); mkdirSync(dir);
    const text = (evs) => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(dir, "7.jsonl"), text([...lane(0, [deps("cargo", "failed", "lock drift")]), ...lane(1, [{ event: "WORKTREE_SPARSE_FALLBACK", reason: "no cone" }], { code: null })]) + "{torn");
    writeFileSync(join(dir, "8.jsonl"), text(lane(2, [], { repo: "a/b" })));
    const got = readLanes(dir);
    assert.deepEqual(got.map((l) => [l.repo, l.issue, l.code, l.deps.length, l.sparseFallback]),
      [["o/r", 100, "completed", 1, null], ["o/r", 101, null, 0, "no cone"], ["a/b", 102, "completed", 0, null]]);
  });

  it("thresholds come from forge.yaml stats.alerts.* (nested block and flat form) and change the result", () => {
    assert.deepEqual(readAlertConfig(join(td, "none")), DEFAULT_ALERTS);
    writeFileSync(join(td, "forge.yaml"), "stats:\n  alerts:\n    min_lanes: 5\n    deps_failed_pct: 50\n    alerts_window: 8\n    window: 30\n    deferred_to_ci_pct: nope\n");
    const c = readAlertConfig(td);
    assert.deepEqual(c, { ...DEFAULT_ALERTS, minLanes: 5, depsFailedPct: 50, window: 8 });
    const l = lanes(6, (i) => [deps("pnpm", i < 2 ? "failed" : "hit", "x")]);
    assert.deepEqual(computeAlerts(l, { repo: "o/r" }), [], "default min_lanes 10");
    assert.deepEqual(computeAlerts(l, { repo: "o/r", ...c }), [], "33% is under the configured 50%");
    assert.equal(computeAlerts(l, { repo: "o/r", ...c, depsFailedPct: 20 }).length, 1);
  });

  it("stats report carries alerts and renders an ALERTS section only when one fired; --no-local skips them; no gh call for alerts", async () => {
    const { gh } = fakeGh();
    const localLanes = lanes(10, () => [deps("pnpm", "failed", "spawn pnpm ENOENT")]);
    const rep = await buildReport({ repo: "o/r", local: true, cache: false, minN: 10 }, { gh, env: { ...ENV, FORGE_RUNS_DIR: join(td, "none") }, releaseTimes: [], localRuns: [], localLanes, alertConfig: {} });
    assert.equal(rep.alerts.length, 1);
    assert.match(renderMarkdown(rep), /## ALERTS\n\n- DEPS_PREPARED failed \(pnpm\): 100% \(10\/10 lanes/);
    assert.equal(JSON.parse(renderJson(rep)).alerts[0].event, "DEPS_PREPARED failed (pnpm)");
    const off = await buildReport({ repo: "o/r", local: false, cache: false, minN: 10 }, { gh, env: ENV, releaseTimes: [], localLanes });
    assert.deepEqual(off.alerts, []);
    assert.doesNotMatch(renderMarkdown(off), /ALERTS/);
    // computed from local run logs alone: no gh in scope at all
    assert.equal(computeAlerts(localLanes, { repo: "o/r" }).length, 1);
  });
});

describe("env.tool_missing per release (forge#4414)", () => {
  // The #4393 replay criterion is read as outcome-code counts per engine version; pin that the report surfaces them.
  const run = (issue, version, reason, code) => ({ issue, repo: "o/r", version, reason, code, finished: true, usageEvents: 1, endTs: "2026-10-23T10:00:00Z", phases: { implement: { cr: 1, out: 1, ms: 1 } } });
  const runs = [run(1, "1.30.0", "needs-human", "env.tool_missing"), run(2, "1.30.0", "merged", "completed"),
    run(3, "1.31.0", "merged", "completed"), run(4, "1.31.0", "needs-human", "dependency.open")];
  const codesOf = (g) => Object.fromEntries(g.flow.codes.map((c) => [c.code, c.count]));

  it("counts env.tool_missing per version and drops pre-release lanes with sinceVersion", () => {
    const all = aggregate({ runs }, { releaseTimes: [] });
    assert.equal(codesOf(all.groups.find((g) => g.version === "1.30.0"))["env.tool_missing"], 1);
    const after = aggregate({ runs }, { releaseTimes: [], sinceVersion: "1.31.0" });
    assert.deepEqual(after.groups.map((g) => g.version), ["1.31.0"]);
    assert.equal(codesOf(after.groups[0])["env.tool_missing"], undefined);
    assert.equal(after.groups[0].flow.codesN, 2);
  });
});
