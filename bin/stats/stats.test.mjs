// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { aggregate, compareVersions, percentile } from "./aggregate.mjs";
import { cacheDir } from "./cache.mjs";
import { fetchGithubRecords, parseTelemetryComments, runsFromRecords, toModel } from "./github-source.mjs";
import { buildReport, parseArgs, parseSince, runStats } from "./index.mjs";
import { readLocalRuns } from "./local-source.mjs";
import { renderCompact, renderJson, renderMarkdown } from "./render.mjs";

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
    const since = /since=([^&]+)/.exec(path)?.[1];
    return JSON.stringify(issues.filter((i) => !since || i.updated_at >= since));
  };
  return { gh, calls };
}

let td;
beforeEach(() => { td = mkdtempSync(join(tmpdir(), "stats-")); });
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
  it("rebuilds cost, time, flow, funnel, gates and issue flow from GitHub alone", () => {
    const { gh } = fakeGh();
    const report = buildReport({ repo: "o/r", local: false, cache: false, minN: 10 }, { gh, env: ENV, releaseTimes: [] });
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
  it("json output is parseable and carries every section", () => {
    const { gh } = fakeGh();
    const report = buildReport({ repo: "o/r", local: false, cache: false, minN: 10 }, { gh, env: ENV, releaseTimes: [] });
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
  it("refreshes incrementally from the updated_at watermark and survives deletion or corruption", () => {
    const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(td, "cache") };
    const a = fakeGh();
    const first = fetchGithubRecords({ repo: "o/r", gh: a.gh, env });
    assert.equal(first.fromCache, false);
    assert.ok(!a.calls[0].includes("since="));
    const b = fakeGh();
    const second = fetchGithubRecords({ repo: "o/r", gh: b.gh, env });
    assert.equal(second.fromCache, true);
    assert.match(b.calls[0], /since=2026-10-06T13:00:00Z/);
    assert.deepEqual(second.records.map((r) => r.eid).sort(), first.records.map((r) => r.eid).sort());
    // corrupt cache -> treated as empty -> same result from a full fetch
    writeFileSync(join(cacheDir("o/r", env), "cache.json"), "{not json");
    const c = fakeGh();
    const third = fetchGithubRecords({ repo: "o/r", gh: c.gh, env });
    assert.equal(third.fromCache, false);
    assert.equal(third.records.length, first.records.length);
    // --refresh ignores a good cache
    const d = fakeGh();
    fetchGithubRecords({ repo: "o/r", gh: d.gh, env, refresh: true });
    assert.ok(!d.calls[0].includes("since="));
    assert.equal(toModel("o/r", third).issues.length, 5);
  });
  it("saves a partial checkpoint on a mid-crawl failure and the next run resumes from it", () => {
    const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(td, "cache-partial") };
    const ok = fakeGh();
    const full = fetchGithubRecords({ repo: "o/r", gh: ok.gh, env: { ...ENV }, useCache: false });
    const withComments = full.items.filter((i) => ok.calls.some((c) => c.includes(`/issues/${i.number}/comments`)));
    assert.ok(withComments.length >= 2, "fixture needs at least two items with comments");
    let commentCalls = 0;
    // The real API honours sort=updated&direction=asc, which the watermark resume relies on; the fixture is unsorted.
    const asc = (gh) => (args) => {
      const out = gh(args);
      return args.some((a) => /\/issues\?/.test(a)) ? JSON.stringify(JSON.parse(out).sort((x, y) => x.updated_at.localeCompare(y.updated_at))) : out;
    };
    const flaky = asc((args) => {
      if (args[args.length - 1].endsWith("/comments") && ++commentCalls === 2) throw new Error("rate limited");
      return ok.gh(args);
    });
    assert.throws(() => fetchGithubRecords({ repo: "o/r", gh: flaky, env }), /rate limited/);
    const saved = JSON.parse(readFileSync(join(cacheDir("o/r", env), "cache.json"), "utf8"));
    assert.ok(saved.watermark, "partial watermark persisted");
    assert.ok(Object.keys(saved.items).length > 0 && Object.keys(saved.items).length < full.items.length);
    const b = fakeGh();
    const resumed = fetchGithubRecords({ repo: "o/r", gh: asc(b.gh), env });
    assert.equal(resumed.fromCache, true);
    assert.match(b.calls[0], /since=/);
    assert.deepEqual(resumed.records.map((r) => r.eid).sort(), full.records.map((r) => r.eid).sort());
  });
  it("rejects an unsafe repo before any gh call", () => {
    const { gh, calls } = fakeGh();
    assert.throws(() => fetchGithubRecords({ repo: "o/r; rm -rf /", gh }), /invalid repo/);
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
