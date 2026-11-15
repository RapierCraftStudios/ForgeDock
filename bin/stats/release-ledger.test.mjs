// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5718: the release ledger on a recorded-shape fixture (raw REST payloads of a neutral repo, acme/widgets). The fake `gh`
// serves raw pages and applies the caller's own --jq program with the jq binary, so the projections are exercised too.
import { tmpDir } from "../tests/_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, runStats } from "./index.mjs";
import { LEDGER_METRICS, baselineOf, compareBaseline, computeReleaseLedger, deployJobOf, gatherReleaseLedger, ledgerSince, ledgerTable, listReleasePrs, parseLedgerConfig, planLedger, renderBaselineCompare, renderReleaseLedger, runReleaseLedger } from "./release.mjs";
import { listRuns } from "../lean/release-minutes.mjs";
import { releaseRecords } from "../lean/release-ledger.mjs";

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "release-ledger", "acme-widgets.json"), "utf8"));
const HAS_JQ = spawnSync("jq", ["--version"]).status === 0;
const SINCE = Date.parse("2026-03-01T00:00:00Z"), UNTIL = Date.parse("2026-03-03T00:00:00Z"), REPO = "acme/widgets";

/** A `gh` that answers the REST paths the ledger reads from the fixture, page by page (`pageSize`), through real jq. */
function fakeGh(fx = FX, { pageSize = 100 } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(" "));
    const path = args.find((a) => a.startsWith("repos/")), jq = args[args.indexOf("--jq") + 1];
    const q = new URLSearchParams(path.split("?")[1] ?? "");
    const chunk = (rows) => { const out = []; for (let i = 0; i < Math.max(rows.length, 1); i += pageSize) out.push(rows.slice(i, i + pageSize)); return out; };
    let pages;
    if (/^repos\/[^/]+\/[^/?]+$/.test(path)) pages = [fx.repo];
    else if (/\/pulls\?/.test(path)) { const rows = fx.pulls.filter((p) => p.base.ref === q.get("base")); const n = Number(q.get("per_page")), pg = Number(q.get("page") ?? 1); pages = [rows.slice((pg - 1) * n, pg * n)]; }
    else if (/\/actions\/runs\/(\d+)\/jobs/.test(path)) { const rows = fx.jobs[/runs\/(\d+)\/jobs/.exec(path)[1]] ?? []; pages = chunk(rows).map((jobs) => ({ total_count: rows.length, jobs })); }
    else if (/\/actions\/runs\?/.test(path)) {
      const [a, b] = q.get("created").split("..").map((x) => Date.parse(x));
      const rows = fx.runs.filter((r) => Date.parse(r.created_at) >= a && Date.parse(r.created_at) <= b && (!q.get("branch") || r.head_branch === q.get("branch")) && (!q.get("event") || r.event === q.get("event")))
        .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at)).slice(0, 1000);
      pages = chunk(rows).map((workflow_runs) => ({ total_count: rows.length, workflow_runs }));
    } else throw new Error(`unexpected gh call: ${args.join(" ")}`);
    return pages.map((p) => execFileSync("jq", ["-r", jq], { input: JSON.stringify(p), encoding: "utf8" })).join("");
  };
  return { gh, calls };
}
const CFG = { releaseHead: "staging" };
const gathered = async (cfg = CFG, o = {}) => gatherReleaseLedger({ gh: fakeGh(FX, o).gh, repo: REPO, sinceMs: SINCE, untilMs: UNTIL, cfg, useCache: false });

describe("release ledger: config and arguments (#5718)", () => {
  it("parses the forge.yaml stats.ledger_* keys; the release head defaults to branches.staging", () => {
    assert.deepEqual(parseLedgerConfig(null, null), { releaseBase: null, releaseHead: null, ciWorkflows: [], deployWorkflow: null, deployJob: null });
    assert.deepEqual(parseLedgerConfig({ ledger_release_base: "trunk", ledger_ci_workflows: ["CI", "images.yml"], ledger_deploy_workflow: "deploy.yml", ledger_deploy_job: "^rollout" }, { staging: "next" }),
      { releaseBase: "trunk", releaseHead: "next", ciWorkflows: ["CI", "images.yml"], deployWorkflow: "deploy.yml", deployJob: "^rollout" });
    assert.equal(parseLedgerConfig({ ledger_release_head: "rc" }, { staging: "next" }).releaseHead, "rc");
  });
  it("--release-ledger takes --baseline save|compare; its flags need it", () => {
    const o = parseArgs(["--release-ledger", "--baseline", "save", "--since", "21d", "--deploy-workflow", "deploy.yml", "--json"]);
    assert.equal(o.releaseLedger, true); assert.equal(o.baseline, "save"); assert.equal(o.deployWorkflow, "deploy.yml");
    assert.throws(() => parseArgs(["--release-ledger", "--baseline", "reset"]), /save or compare/);
    assert.throws(() => parseArgs(["--baseline", "save"]), /need --release-ledger/);
    assert.equal(parseArgs([]).releaseLedger, undefined);
  });
  it("--since is a date or a window, default 21 days", () => {
    const now = Date.parse("2026-03-22T00:00:00Z");
    assert.equal(ledgerSince(null, now), Date.parse("2026-03-01T00:00:00Z"));
    assert.equal(ledgerSince("7d", now), now - 7 * 86400000); assert.equal(ledgerSince("36h", now), now - 36 * 3600000);
    assert.equal(ledgerSince("2026-03-10", now), Date.parse("2026-03-10"));
    assert.throws(() => ledgerSince("1.2.0", now), /date .* or a window/);
  });
});

describe("release ledger: plan (#5718)", () => {
  const runs = FX.runs.map((r) => ({ ...r, prs: r.pull_requests.map((p) => p.number) }));
  const prs = FX.pulls.map((p) => ({ number: p.number, created_at: p.created_at, merged_at: p.merged_at, closed_at: p.closed_at, merge_commit_sha: p.merge_commit_sha, head_ref: p.head.ref, base_ref: p.base.ref }));
  it("picks the release PRs, their CI runs and the deploy workflow with the most runs", () => {
    const p = planLedger({ prs, runs, base: "main", cfg: CFG, untilMs: UNTIL });
    assert.deepEqual(p.releases.map((x) => [x.pr.number, x.ci.map((r) => r.id).sort()]), [[10, [100, 101, 102, 103]], [11, [110]]]);
    assert.equal(p.deployWorkflow, ".github/workflows/deploy.yml");
    assert.deepEqual(p.deploy.map((r) => r.id), [200, 201, 210, 211]);
    assert.ok(!p.need.includes(300), "another deploy-named workflow is not read");
  });
  it("a pinned workflow, a CI workflow filter and any head are honoured", () => {
    assert.deepEqual(planLedger({ prs, runs, base: "main", cfg: { deployWorkflow: "docs.yml" } }).deploy.map((r) => r.id), [300]);
    assert.deepEqual(planLedger({ prs, runs, base: "main", cfg: { ...CFG, ciWorkflows: ["Images"] } }).releases[0].ci.map((r) => r.id), [102]);
    assert.deepEqual(planLedger({ prs, runs, base: "main", cfg: {} }).releases.map((x) => x.pr.number), [10, 11, 12]);
  });
  it("a repo whose CI runs only on push falls back to the head branch's push runs while the PR was open", () => {
    const push = runs.filter((r) => r.event !== "pull_request").concat([{ ...runs[0], id: 130, event: "push", prs: [], created_at: "2026-03-01T10:05:00Z" }]);
    assert.deepEqual(planLedger({ prs, runs: push, base: "main", cfg: CFG, untilMs: UNTIL }).releases.map((x) => x.ci.map((r) => r.id)), [[130], []]);
  });
  it("the deploy job is the configured one, else the longest job whose name says deploy", () => {
    assert.equal(deployJobOf(FX.jobs[201]).name, "deploy");
    assert.equal(deployJobOf(FX.jobs[201], { deployJob: "^pre" }).name, "pre-gate");
    assert.equal(deployJobOf(FX.jobs[211]), null, "a skipped job never deploys");
  });
});

describe("release ledger: metrics from the Actions API (#5718)", { skip: !HAS_JQ && "jq not installed" }, () => {
  it("computes every target row from runs, jobs and steps", async () => {
    const r = computeReleaseLedger(await gathered(), CFG), m = r.metrics;
    assert.deepEqual(r.n, { rounds: 3, release_prs: 2, release_prs_with_ci: 2, ci_runs: 5, ci_jobs: 7, deploy_attempts: 3, deploy_live: 2, image_build_jobs: 1, failed_runs: 1, mechanical_failures: 1, live_releases: 2, clean_releases: 1 });
    assert.equal(m.ci_round_wall_min_p50, 10); assert.equal(m.ci_round_wall_min_p90, 20); assert.equal(m.ci_round_fail_rate, 0.333);
    assert.equal(m.pushes_per_release_pr_p50, 2); assert.equal(m.pushes_per_release_pr_max, 3);
    // job seconds: failed lint 120, cancelled test 300, of 120+1140+300+115+570+356+580 = 3181
    assert.equal(m.failed_minute_share, 0.038); assert.equal(m.cancelled_minute_share, 0.094);
    assert.equal(m.deploy_live_rate, 0.667); assert.equal(m.deploy_pregate_min_p50, 15); assert.equal(m.deploy_job_min_p50, 22.5); assert.equal(m.deploy_run_min_p50, 37.5);
    assert.equal(m.image_build_min_p50, 4);
    assert.equal(m.mechanical_failure_surfaced_s, 1200); assert.equal(m.first_failed_step_s_p50, 130);
    assert.equal(m.pr_to_live_h_median, 2.38); assert.equal(m.pr_to_live_h_p90, 3.75); assert.equal(m.pr_to_live_clean_h_median, 1);
    assert.equal(m.queue_s_p90, 30); // nearest rank over 13 queue times
    assert.deepEqual(r.setup.self_hosted, { jobs: 4, checkout_s: 100, toolchain_s: 60, deps_s: 200, total_s: 360 });
    assert.deepEqual(r.setup.hosted, { jobs: 3, checkout_s: 5, toolchain_s: 15, deps_s: 30, total_s: 50 });
    assert.deepEqual(r.critical_path.map((c) => [c.job, c.rounds, c.of]), [["test", 3, 3]]);
    assert.deepEqual(r.deploy_steps, [{ step: "Roll out", min_p50: 13, n: 2 }, { step: "Smoke", min_p50: 5, n: 2 }, { step: "Tail services", min_p50: 4.5, n: 2 }]);
    assert.deepEqual(r.releases.map((x) => [x.pr, x.hours, x.pushes, x.deploy_attempts, x.clean]), [[10, 3.75, 3, 2, false], [11, 1, 1, 1, true]]);
    assert.match(r.notes.join("\n"), /deploy workflow detected: \.github\/workflows\/deploy\.yml/);
  });
  it("prints the Targets table with today vs target and a status per row", async () => {
    const r = computeReleaseLedger(await gathered(), CFG), text = renderReleaseLedger(r);
    const row = (k) => r.table.find((x) => x.key === k);
    assert.equal(row("ci_round_wall_min_p50").status, "phase1-met"); assert.equal(row("pushes_per_release_pr_p50").status, "not-met");
    assert.equal(row("pr_to_live_clean_h_median").status, "phase1-met"); assert.equal(row("failed_minute_share").status, "no-target");
    assert.match(text, /\| CI wall time per round \(p50\) \| 10 min \| <= 10 min \| <= 4 min \| phase1-met \|/);
    assert.match(text, /self-hosted: 100 s \+ 60 s \+ 200 s \(total 360 s, 4 job\(s\)\)/);
    assert.match(text, /\| Roll out \| 13 min \|/);
    assert.equal(ledgerTable({}).find((x) => x.key === "queue_s_p90").status, "n/a");
    assert.equal(ledgerTable({ deploy_live_rate: 0.5 }, [{ key: "deploy_live_rate", label: "x", unit: "pct", higherBetter: true, phase1: 0.9, end: 0.99 }])[0].status, "not-met");
    assert.equal(r.table.length, LEDGER_METRICS.length);
  });
  it("release state from the managed ledger raises the attempt count of its release", async () => {
    const data = await gathered();
    const r = computeReleaseLedger({ ...data, ledger: [{ pr: 11, deployAttempts: 3, live: true }] }, CFG);
    assert.deepEqual(r.releases.map((x) => [x.pr, x.deploy_attempts, x.clean]), [[10, 2, false], [11, 3, false]]);
    assert.equal(r.metrics.pr_to_live_clean_h_median, null);
  });
  it("without a deploy workflow, live is the merge time and the report says so", async () => {
    const data = await gathered();
    const r = computeReleaseLedger({ ...data, runs: data.runs.filter((x) => x.event === "pull_request") }, CFG);
    assert.equal(r.deploy_workflow, null); assert.deepEqual(r.releases.map((x) => x.hours), [2, 0.5]);
    assert.match(r.notes.join("\n"), /no deploy workflow found/);
    assert.equal(r.metrics.deploy_live_rate, null);
  });
  it("paginates runs, jobs and PRs: small pages give the same report", async () => {
    const a = computeReleaseLedger(await gathered(), CFG), b = computeReleaseLedger(await gathered(CFG, { pageSize: 2 }), CFG);
    assert.deepEqual(b.metrics, a.metrics);
    const many = { ...FX, pulls: Array.from({ length: 230 }, (_, i) => ({ ...FX.pulls[1], number: 1000 - i, created_at: new Date(UNTIL - i * 600000).toISOString() })) };
    assert.equal((await listReleasePrs({ gh: fakeGh(many).gh, repo: REPO, base: "main", sinceMs: SINCE })).length, 230);
    const f = fakeGh(many);
    assert.equal((await listReleasePrs({ gh: f.gh, repo: REPO, base: "main", sinceMs: UNTIL - 50 * 600000 })).length, 51);
    assert.equal(f.calls.length, 1, "stops at the page that reaches the window start");
  });
  it("a window at the runs API result cap is halved, so no run is dropped", async () => {
    const f = fakeGh();
    const runs = await listRuns({ gh: f.gh, repo: REPO, sinceMs: SINCE, untilMs: UNTIL, cap: 6 });
    assert.equal(new Set(runs.map((r) => r.id)).size, FX.runs.length); assert.equal(runs.length, FX.runs.length);
    assert.ok(f.calls.length > 1);
  });
  it("reads only scoped runs and caches the jobs of completed runs", async () => {
    const env = { FORGE_STATS_CACHE_DIR: tmpDir("ledger-cache-") };
    const f = fakeGh();
    await gatherReleaseLedger({ gh: f.gh, repo: REPO, sinceMs: SINCE, untilMs: UNTIL, cfg: CFG, env });
    assert.ok(f.calls.filter((c) => /actions\/runs\?/.test(c)).every((c) => /branch=(staging|main)&event=/.test(c)), "every runs query names a branch and an event");
    assert.equal(f.calls.filter((c) => /\/jobs\?/.test(c)).length, 9);
    const g = fakeGh();
    const again = await gatherReleaseLedger({ gh: g.gh, repo: REPO, sinceMs: SINCE, untilMs: UNTIL, cfg: CFG, env });
    assert.equal(g.calls.filter((c) => /\/jobs\?/.test(c)).length, 0, "second read: no job call");
    assert.equal(computeReleaseLedger(again, CFG).metrics.ci_round_wall_min_p50, 10);
  });
  it("--baseline save then compare shows before/after per metric, measured the same way", async () => {
    const env = { FORGE_STATS_CACHE_DIR: tmpDir("ledger-base-") }, out = [];
    const deps = { gh: fakeGh().gh, env, now: () => UNTIL, write: (s) => out.push(s), config: CFG };
    assert.equal(await runReleaseLedger({ repo: REPO, since: "2d", baseline: "compare" }, deps), 2, "no baseline yet");
    assert.equal(await runReleaseLedger({ repo: REPO, since: "2d", baseline: "save" }, deps), 0);
    const file = join(env.FORGE_STATS_CACHE_DIR, "acme_widgets", "release-ledger-baseline.json");
    assert.ok(existsSync(file)); assert.equal(JSON.parse(readFileSync(file, "utf8")).metrics.ci_round_wall_min_p50, 10);
    // after: the failed round is gone and the deploy pre-gate job is fast
    const faster = structuredClone(FX);
    faster.runs = faster.runs.filter((r) => r.id !== 100 && r.id !== 103);
    for (const id of [201, 210]) { const [pre, dep] = faster.jobs[id]; const shift = Date.parse(dep.started_at) - Date.parse(pre.started_at) - 60000; pre.completed_at = new Date(Date.parse(pre.started_at) + 55000).toISOString(); for (const x of [dep, ...dep.steps]) for (const k of ["created_at", "started_at", "completed_at"]) if (x[k]) x[k] = new Date(Date.parse(x[k]) - shift).toISOString(); }
    out.length = 0;
    assert.equal(await runReleaseLedger({ repo: REPO, since: "2d", baseline: "compare", json: true, cache: false }, { ...deps, gh: fakeGh(faster).gh }), 0);
    const cmp = Object.fromEntries(JSON.parse(out.join("")).compare.rows.map((x) => [x.key, x]));
    assert.deepEqual([cmp.deploy_pregate_min_p50.before, cmp.deploy_pregate_min_p50.after, cmp.deploy_pregate_min_p50.verdict], [15, 1.1, "improved"]);
    assert.equal(cmp.pushes_per_release_pr_p50.verdict, "improved"); assert.equal(cmp.ci_round_fail_rate.verdict, "improved");
    assert.equal(cmp.deploy_job_min_p50.verdict, "flat"); assert.deepEqual([cmp.setup_hosted_s.before, cmp.setup_hosted_s.after, cmp.setup_hosted_s.verdict], [50, 16, "improved"]);
  });
  it("forgedock stats --release-ledger --json prints the report", async () => {
    const out = [], w = process.stdout.write;
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    let code;
    try { code = await runStats(["--release-ledger", "--repo", REPO, "--since", "2026-03-01", "--no-cache", "--json"], { gh: fakeGh().gh, now: () => UNTIL, ledgerConfig: CFG }); } finally { process.stdout.write = w; }
    assert.equal(code, 0);
    const r = JSON.parse(out.join(""));
    assert.equal(r.repo, REPO); assert.equal(r.base, "main"); assert.equal(r.metrics.deploy_live_rate, 0.667); assert.equal(r.window.days, 2);
  });
});

describe("release ledger: baseline compare (pure, #5718)", () => {
  const rep = (metrics) => ({ repo: REPO, window: { since: "2026-03-01T00:00:00.000Z", until: "2026-03-03T00:00:00.000Z" }, n: {}, metrics });
  it("verdicts: lower is better except the live rate; flat inside 5% (2 points for a share); null when a side is missing", () => {
    const base = baselineOf(rep({ ci_round_wall_min_p50: 28.6, deploy_live_rate: 0.37, failed_minute_share: 0.28, queue_s_p90: 1526, pushes_per_release_pr_p50: 3.5 }), 0);
    const c = compareBaseline(base, rep({ ci_round_wall_min_p50: 9, deploy_live_rate: 0.9, failed_minute_share: 0.29, queue_s_p90: 1600, pushes_per_release_pr_p50: null }));
    const v = Object.fromEntries(c.rows.map((x) => [x.key, x.verdict]));
    assert.equal(v.ci_round_wall_min_p50, "improved"); assert.equal(v.deploy_live_rate, "improved"); assert.equal(v.failed_minute_share, "flat");
    assert.equal(v.queue_s_p90, "flat"); assert.equal(v.pushes_per_release_pr_p50, null); assert.equal(v.image_build_min_p50, null);
    assert.equal(compareBaseline(base, rep({ deploy_live_rate: 0.2, queue_s_p90: 2000 })).rows.filter((x) => x.verdict === "regressed").length, 2);
    assert.match(renderBaselineCompare(c, rep({})), /\| CI wall time per round \(p50\) \| 28\.6 min \| 9 min \| improved \|/);
  });
});

describe("release ledger: managed release state (#5718)", () => {
  it("releaseRecords reads the ledger states of the window and skips unreadable ones", async () => {
    const states = { "r20260301-100000-1": { id: "r20260301-100000-1", status: "done", startedAt: "2026-03-01T10:00:00Z", deploy: { phase: "LIVE_CHECKED", attempts: 2 }, steps: { "release-pr": { result: { pr: 10 } } } },
      "r20260302-090000-1": { id: "r20260302-090000-1", status: "stopped", deploy: { phase: "DEPLOYING", attempts: 1 }, pr: 11 }, "r20260101-000000-1": { status: "done" } };
    const reads = [];
    const api = async (method, path) => {
      reads.push(path);
      if (/matching-refs/.test(path)) return [...Object.keys(states), "r20260302-100000-9", "_active"].map((id) => ({ ref: `refs/heads/forge-ledger/${id}` }));
      const ref = /git\/ref\/heads\/forge-ledger\/(.+)$/.exec(path) ?? /ref=forge-ledger(?:%2F|\/)([^&]+)/.exec(path);
      const id = ref ? decodeURIComponent(ref[1]) : null;
      if (id && !states[id]) { const e = new Error("Not Found"); e.status = 404; throw e; }
      if (/git\/ref\//.test(path)) return { object: { sha: `sha-${id}` } };
      return { content: Buffer.from(JSON.stringify(states[id])).toString("base64"), encoding: "base64" };
    };
    const recs = await releaseRecords({ io: { api }, repo: REPO }, { sinceMs: SINCE });
    assert.deepEqual(recs, [{ id: "r20260301-100000-1", pr: 10, startedAt: "2026-03-01T10:00:00Z", status: "done", live: true, deployAttempts: 2 }, { id: "r20260302-090000-1", pr: 11, startedAt: null, status: "stopped", live: false, deployAttempts: 1 }]);
    assert.ok(!reads.some((p) => p.includes("r20260101")), "a release older than the window costs no read");
  });
});
