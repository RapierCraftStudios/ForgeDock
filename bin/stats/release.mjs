// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4628: per-release regression rule over the `aggregate()` groups. Each metric is null when its own sample is
 * below minN; a verdict is null when either side is null. There is no "pass" value, only regressed|improved|flat|null.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_MIN_N, UNKNOWN, compareVersions, percentile } from "./aggregate.mjs";
import { cacheDir } from "./cache.mjs";
import * as M from "../lean/release-minutes.mjs";

export const METRICS_MARKER = "<!-- FORGE:METRICS v1 -->";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
// lower is better for all but the first-pass rate
const METRICS = [
  { key: "usd_median", label: "median cost/run", lowerBetter: true, flat: 0.05 },
  { key: "wall_p50_ms", label: "wall p50", lowerBetter: true, flat: 0.05 },
  { key: "first_pass_rate", label: "first-pass rate", lowerBetter: false, flat: 0.02 },
  { key: "needs_human_rate", label: "needs-human rate", lowerBetter: true, flat: 0.02 },
];

/** The metric values of one group, each null below minN (its own n). */
function valuesOf(g, minN) {
  const pick = (n, v) => (isNum(n) && n >= minN && isNum(v) ? v : null);
  return {
    n: g.n,
    usd_median: pick(g.cost?.usdN, g.cost?.usdMedian),
    wall_p50_ms: pick(g.time?.wall?.n, g.time?.wall?.p50),
    first_pass_rate: pick(g.firstPass?.n, g.firstPass?.rate),
    needs_human_rate: pick(g.flow?.n, g.flow?.needsHumanPct),
  };
}

/** Relative change for cost and time, absolute for rates; flat inside the tolerance. */
function verdict(m, cur, prev) {
  if (!isNum(cur) || !isNum(prev)) return null;
  const rate = m.key.endsWith("_rate");
  const d = rate ? cur - prev : prev === 0 ? (cur === 0 ? 0 : Infinity) : (cur - prev) / prev;
  if (Math.abs(d) <= m.flat) return "flat";
  return (d < 0) === m.lowerBetter ? "improved" : "regressed";
}

/** Known versions of one repo, oldest first, each with its metrics and the verdicts against the previous one. */
export function releaseMetrics(groups, { minN = DEFAULT_MIN_N, repo = null } = {}) {
  const known = groups.filter((g) => g.version !== UNKNOWN && (repo == null || g.repo === repo))
    .sort((a, b) => compareVersions(a.version, b.version));
  const versions = known.map((g, i) => {
    const metrics = valuesOf(g, minN), prev = i ? valuesOf(known[i - 1], minN) : null;
    const verdicts = Object.fromEntries(METRICS.map((m) => [m.key, prev ? verdict(m, metrics[m.key], prev[m.key]) : null]));
    return { version: g.version, against: i ? known[i - 1].version : null, ...metrics, verdicts };
  });
  return { repo, minN, versions };
}

const fmt = (key, v) => (v == null ? "n/a" : key === "usd_median" ? `$${v.toFixed(2)}` : key === "wall_p50_ms" ? `${(v / 60000).toFixed(1)}m` : `${(v * 100).toFixed(0)}%`);

export function renderReleaseMetrics(rm) {
  const rows = rm.versions.map((v) => [v.version, String(v.n), ...METRICS.map((m) => `${fmt(m.key, v[m.key])} (${v.verdicts[m.key] ?? "n/a"})`)]);
  const head = ["version", "n", ...METRICS.map((m) => m.label)];
  const line = (r) => `| ${r.join(" | ")} |`;
  return [`Release metrics (min n ${rm.minN}; n/a below it)`, line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

/** The FORGE:METRICS comment: marker, table and the snapshot as fenced JSON. */
export function metricsComment(rm) {
  return `${METRICS_MARKER}\n${renderReleaseMetrics(rm)}\n\n\`\`\`json\n${JSON.stringify(rm)}\n\`\`\`\n`;
}

/** Create the FORGE:METRICS comment on the PR, or update the existing one (argv-based gh). */
export async function postMetrics({ gh, repo, pr, body }) {
  const raw = await gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`]);
  const pages = String(raw ?? "").trim().replace(/\]\s*\[/g, ",");
  const list = pages ? JSON.parse(pages.startsWith("[") ? pages : `[${pages}]`) : [];
  const mine = list.filter((c) => typeof c?.body === "string" && c.body.startsWith(METRICS_MARKER)).pop();
  if (mine) await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${mine.id}`, "-f", `body=${body}`]);
  else await gh(["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`]);
  return mine ? "updated" : "created";
}

// ---- Release ledger (#5718, Forge CI W8): the plan's "Today (measured)" numbers from the Actions runs/jobs/steps API plus release state. ----

const CI_EVENTS = ["pull_request", "pull_request_target", "merge_group"];
const DEPLOY_EVENTS = ["push", "workflow_dispatch", "release", "workflow_run"];
const DEPLOY_NAME_RE = /deploy|rollout|publish|release|ship/i;
const t = (s) => Date.parse(s);
const p50 = (v) => percentile(v, 50), p90 = (v) => percentile(v, 90);
const lcs = (v) => String(v ?? "").toLowerCase();
const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);
const re = (s) => { try { return s ? new RegExp(s, "i") : null; } catch { return null; } };

/**
 * The plan's Targets table: today vs phase 1 vs end. `higherBetter` flips the verdict; a metric without targets is
 * reported and compared against a baseline only. Units: s, min, h, n (a count), pct (a 0..1 share).
 */
export const LEDGER_METRICS = Object.freeze([
  { key: "mechanical_failure_surfaced_s", label: "Mechanical failure surfaced (run start -> run end)", unit: "s", phase1: 60, end: 30 },
  { key: "setup_self_hosted_s", label: "Job setup, self-hosted (checkout + toolchain + dependencies)", unit: "s", phase1: 30, end: 10 },
  { key: "setup_hosted_s", label: "Job setup, hosted (checkout + toolchain + dependencies)", unit: "s" },
  { key: "ci_round_wall_min_p50", label: "CI wall time per round (p50)", unit: "min", phase1: 10, end: 4 },
  { key: "pushes_per_release_pr_p50", label: "Pushes per release PR (p50)", unit: "n", phase1: 1.5, end: 1 },
  { key: "deploy_pregate_min_p50", label: "Deploy pre-gate (run start -> deploy job start)", unit: "min", phase1: 5, end: 1 },
  { key: "image_build_min_p50", label: "Image build (p50 per job)", unit: "min", phase1: 4, end: 1.5 },
  { key: "deploy_job_min_p50", label: "Deploy job (rollout)", unit: "min", phase1: 15, end: 5 },
  { key: "pr_to_live_clean_h_median", label: "Release PR opened -> live (clean, median)", unit: "h", phase1: 1, end: 0.5 },
  { key: "pr_to_live_h_median", label: "Release PR opened -> live (all, median)", unit: "h" },
  { key: "pr_to_live_h_p90", label: "Release PR opened -> live (all, p90)", unit: "h" },
  { key: "queue_s_p90", label: "Queue time (p90)", unit: "s", phase1: 30, end: 30 },
  { key: "failed_minute_share", label: "CI minutes in failed jobs", unit: "pct" },
  { key: "cancelled_minute_share", label: "CI minutes in cancelled jobs", unit: "pct" },
  { key: "snapshot_rounds_per_release_p50", label: "Snapshot rounds per release (p50)", unit: "n", phase1: 3, end: 2 },
  { key: "ci_round_fail_rate", label: "CI rounds that fail", unit: "pct" },
  { key: "deploy_live_rate", label: "Deploy attempts that reached live", unit: "pct", higherBetter: true },
]);

/**
 * forge.yaml `stats:` keys of the ledger (all optional) -> config. `ledger_release_base` (default: the repo's default
 * branch), `ledger_release_head` (default: `branches.staging` when set, else any head), `ledger_ci_workflows` (names or
 * file names; default every workflow), `ledger_deploy_workflow` (name or file; default: detected), `ledger_deploy_job`
 * (regex on the job name; default: detected).
 */
export function parseLedgerConfig(stats, branches) {
  const s = stats && typeof stats === "object" ? stats : {};
  const str = (k) => String(s[k] ?? "").trim() || null;
  return { releaseBase: str("ledger_release_base"), releaseHead: str("ledger_release_head") ?? (String(branches?.staging ?? "").trim() || null),
    ciWorkflows: list(s.ledger_ci_workflows), deployWorkflow: str("ledger_deploy_workflow"), deployJob: str("ledger_deploy_job") };
}

const wfMatch = (run, name) => { const n = lcs(name), p = lcs(run.path); return lcs(run.name) === n || p === n || p.endsWith(`/${n}`); };
const ranRun = (r) => r.status === "completed" && !["skipped", "action_required", "stale"].includes(lcs(r.conclusion));

/**
 * Which runs belong to the ledger (pure): the CI runs of each release PR and the deploy runs. A release PR is a PR into
 * `base` (from `cfg.releaseHead` when set) opened in the window. Its CI runs are the PR-event runs that name it (or, for
 * runs that name no PR, its head branch while it was open); a repo whose CI only runs on push falls back to the push runs
 * of the head branch while the PR was open. The deploy workflow is `cfg.deployWorkflow`, else the non-PR workflow on `base`
 * whose name or file says deploy/publish/release with the most runs.
 * @returns {{releases: {pr: object, ci: object[]}[], deploy: object[], deployWorkflow: string|null, need: number[]}}
 */
export function planLedger({ prs = [], runs = [], base, cfg = {}, untilMs = Date.now() }) {
  const wanted = (r) => !cfg.ciWorkflows?.length || cfg.ciWorkflows.some((n) => wfMatch(r, n));
  const nonPr = runs.filter((r) => DEPLOY_EVENTS.includes(r.event));
  let deployWorkflow = cfg.deployWorkflow ?? null;
  if (!deployWorkflow) {
    const counts = new Map();
    for (const r of nonPr) if ((r.head_branch === base || r.event !== "push") && (DEPLOY_NAME_RE.test(r.name ?? "") || DEPLOY_NAME_RE.test(r.path ?? "")) && ranRun(r)) counts.set(r.path ?? r.name, (counts.get(r.path ?? r.name) ?? 0) + 1);
    deployWorkflow = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? null;
  }
  const isDeploy = (r) => Boolean(deployWorkflow) && wfMatch(r, deployWorkflow);
  const deploy = nonPr.filter(isDeploy).sort((a, b) => t(a.created_at) - t(b.created_at));
  const rel = prs.filter((p) => p.base_ref === base && (!cfg.releaseHead || p.head_ref === cfg.releaseHead)).sort((a, b) => t(a.created_at) - t(b.created_at));
  const releases = rel.map((pr) => {
    const from = t(pr.created_at), to = t(pr.closed_at ?? pr.merged_at) || untilMs;
    const open = (r) => r.head_branch === pr.head_ref && t(r.created_at) >= from && t(r.created_at) <= to;
    let ci = runs.filter((r) => CI_EVENTS.includes(r.event) && wanted(r) && ((r.prs ?? []).includes(pr.number) || (!(r.prs ?? []).length && open(r))));
    if (!ci.length) ci = runs.filter((r) => r.event === "push" && wanted(r) && !isDeploy(r) && open(r));
    return { pr, ci };
  });
  const need = [...new Set([...releases.flatMap((x) => x.ci), ...deploy].filter(ranRun).map((r) => r.id))];
  return { releases, deploy, deployWorkflow, need };
}

const round1 = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const latest = (run, jobs) => (jobs ?? []).filter((j) => (j.run_attempt ?? 1) === (run.run_attempt ?? 1));
const first = (jobs) => (jobs ?? []).filter((j) => (j.run_attempt ?? 1) === 1);
/** Wall span of a run's first attempt: created -> the end of its first-attempt jobs (a later rerun must not stretch the round). */
function runSpan(run, jobs) {
  const start = t(run.created_at);
  const ends = (run.run_attempt ?? 1) > 1 ? first(jobs).filter(M.jobRan).map((j) => t(j.completed_at)) : [t(run.updated_at)];
  const end = ends.length ? Math.max(...ends) : t(run.updated_at);
  return { start, end };
}
/** The job that rolls out: `cfg.deployJob` (regex), else the longest ran job whose name says deploy, else the longest ran job. */
export function deployJobOf(jobs, cfg = {}) {
  const ran = (jobs ?? []).filter(M.jobRan).sort((a, b) => M.jobSeconds(b) - M.jobSeconds(a));
  const want = re(cfg.deployJob);
  if (want) return ran.find((j) => want.test(j.name)) ?? null;
  return ran.find((j) => DEPLOY_NAME_RE.test(j.name)) ?? ran[0] ?? null;
}

/**
 * The ledger report (pure). `data`: {repo, sinceMs, untilMs, base, prs, runs, jobs: {<run id>: job[]}, ledger?: [{pr, deployAttempts, live}]}.
 * Every metric is null without a sample; `n` carries each sample size. Nothing is estimated.
 */
export function computeReleaseLedger(data, cfg = {}) {
  const { repo, sinceMs, untilMs, base, jobs = {} } = data;
  const plan = planLedger({ prs: data.prs, runs: data.runs, base, cfg, untilMs });
  const jobsOf = (r) => jobs[r.id] ?? [];
  const n = {}, m = {}, notes = [];
  const ciRuns = [...new Map(plan.releases.flatMap((x) => x.ci).filter(ranRun).map((r) => [r.id, r])).values()];
  const ciJobs = ciRuns.flatMap(jobsOf);

  // rounds: one per (release PR, head sha)
  const rounds = [], pushes = [];
  for (const { pr, ci } of plan.releases) {
    const bySha = new Map();
    for (const r of ci) { if (!bySha.has(r.head_sha)) bySha.set(r.head_sha, []); bySha.get(r.head_sha).push(r); }
    if (bySha.size) pushes.push({ pr: pr.number, pushes: bySha.size });
    for (const [sha, rs] of bySha) {
      const done = rs.filter(ranRun);
      if (!done.length || rs.some((r) => r.status !== "completed")) continue;
      const spans = done.map((r) => runSpan(r, jobsOf(r)));
      const outcome = done.some((r) => M.isFailedConclusion(r.conclusion)) ? "fail" : done.some((r) => lcs(r.conclusion) === "cancelled") ? "cancelled" : "pass";
      rounds.push({ pr: pr.number, sha, outcome, runs: done, wallMin: (Math.max(...spans.map((s) => s.end)) - Math.min(...spans.map((s) => s.start))) / 60000,
        jobMin: done.flatMap((r) => first(jobsOf(r))).reduce((a, j) => a + M.jobSeconds(j), 0) / 60 });
    }
  }
  const judged = rounds.filter((r) => r.outcome !== "cancelled");
  m.ci_round_wall_min_p50 = round1(p50(judged.map((r) => r.wallMin))); m.ci_round_wall_min_p90 = round1(p90(judged.map((r) => r.wallMin)));
  m.ci_round_job_min_p50 = round1(p50(judged.map((r) => r.jobMin)));
  m.ci_round_fail_rate = judged.length ? round1(judged.filter((r) => r.outcome === "fail").length / judged.length, 3) : null;
  n.rounds = judged.length;
  // ledger rounds (#6013): snapshots per release, wall time and cause of each round
  const led = (data.ledger ?? []).filter((l) => l.snapshots > 0);
  m.snapshot_rounds_per_release_p50 = round1(p50(led.map((l) => l.snapshots)));
  m.snapshot_rounds_per_release_max = led.length ? Math.max(...led.map((l) => l.snapshots)) : null;
  m.snapshot_wall_min_total = round1(led.reduce((a, l) => a + (l.wallMin || 0), 0));
  for (const c of ["regression", "flake", "runner"]) m[`snapshot_rounds_${c}`] = led.reduce((a, l) => a + (l.causes?.[c] || 0), 0);
  m.pushes_per_release_pr_p50 = round1(p50(pushes.map((x) => x.pushes))); m.pushes_per_release_pr_max = pushes.length ? Math.max(...pushes.map((x) => x.pushes)) : null;
  n.release_prs = plan.releases.length; n.release_prs_with_ci = pushes.length;

  const sh = M.minuteShares(ciJobs);
  m.failed_minute_share = round1(sh.failedShare, 3); m.cancelled_minute_share = round1(sh.cancelledShare, 3); m.ci_job_minutes = round1(sh.seconds / 60, 0);
  n.ci_runs = ciRuns.length; n.ci_jobs = ciJobs.filter(M.jobRan).length;

  // critical path: the job that ends last in each judged round (latest attempt of every run of that head)
  const crit = new Map(), byName = new Map();
  for (const r of ciRuns) for (const j of latest(r, jobsOf(r)).filter(M.jobRan)) { if (!byName.has(j.name)) byName.set(j.name, []); byName.get(j.name).push(j); }
  let critRuns = 0;
  for (const rd of judged) {
    const c = M.criticalJob(rd.runs.flatMap((r) => latest(r, jobsOf(r))));
    if (c) { critRuns++; crit.set(c.name, (crit.get(c.name) ?? 0) + 1); }
  }
  const critical_path = [...crit].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([job, runs]) => {
    const js = byName.get(job) ?? [];
    return { job, rounds: runs, of: critRuns, min_p50: round1(p50(js.map((j) => M.jobSeconds(j) / 60))), fail_rate: js.length ? round1(js.filter((j) => M.isFailedConclusion(j.conclusion)).length / js.length, 3) : null };
  });

  // deploy
  const deployRuns = plan.deploy.filter(ranRun).filter((r) => jobsOf(r).some(M.jobRan));
  const attempts = deployRuns.map((r) => {
    const js = latest(r, jobsOf(r)), dj = deployJobOf(js, cfg);
    const live = lcs(r.conclusion) === "success" && Boolean(dj) && lcs(dj.conclusion) === "success";
    return { run: r, jobs: js, dj, live, liveAt: live ? t(dj.completed_at) : null };
  });
  const liveAttempts = attempts.filter((a) => a.live);
  n.deploy_attempts = attempts.length; n.deploy_live = liveAttempts.length;
  m.deploy_live_rate = attempts.length ? round1(liveAttempts.length / attempts.length, 3) : null;
  m.deploy_pregate_min_p50 = round1(p50(liveAttempts.map((a) => (t(a.dj.started_at) - t(a.run.run_started_at ?? a.run.created_at)) / 60000)));
  m.deploy_job_min_p50 = round1(p50(liveAttempts.map((a) => M.jobSeconds(a.dj) / 60)));
  m.deploy_run_min_p50 = round1(p50(liveAttempts.map((a) => (t(a.run.updated_at) - t(a.run.run_started_at ?? a.run.created_at)) / 60000)));
  const stepSecs = new Map();
  for (const a of liveAttempts) for (const s of a.dj.steps ?? []) {
    const sec = (t(s.completed_at) - t(s.started_at)) / 1000;
    if (!(sec > 0)) continue;
    if (!stepSecs.has(s.name)) stepSecs.set(s.name, []);
    stepSecs.get(s.name).push(sec);
  }
  const deploy_steps = [...stepSecs].map(([step, v]) => ({ step, min_p50: round1(p50(v) / 60, 2), n: v.length })).sort((a, b) => b.min_p50 - a.min_p50).slice(0, 10);

  // setup, queue, image build: over every ledger job that ran
  const allJobs = [...ciJobs, ...deployRuns.flatMap(jobsOf)].filter(M.jobRan);
  m.queue_s_p90 = round1(p90(allJobs.map(M.queueSeconds).filter((x) => x != null)), 0); m.queue_s_p50 = round1(p50(allJobs.map(M.queueSeconds).filter((x) => x != null)), 0);
  const setup = {};
  for (const [kind, js] of [["self_hosted", allJobs.filter(M.isSelfHosted)], ["hosted", allJobs.filter((j) => !M.isSelfHosted(j))]]) {
    const per = js.map(M.jobSetup).filter((s) => s.total > 0);
    const cls = (k) => round1(p50(per.map((s) => s[k]).filter((x) => x > 0)), 0);
    setup[kind] = { jobs: per.length, checkout_s: cls("checkout"), toolchain_s: cls("toolchain"), deps_s: cls("deps"), };
    setup[kind].total_s = per.length ? (setup[kind].checkout_s ?? 0) + (setup[kind].toolchain_s ?? 0) + (setup[kind].deps_s ?? 0) : null; // the sum of the three class medians, as the plan states it
    m[`setup_${kind}_s`] = setup[kind].total_s;
  }
  const img = allJobs.map((j) => (j.steps ?? []).filter((s) => M.classifyStep(s.name) === "image-build").reduce((a, s) => a + Math.max(0, t(s.completed_at) - t(s.started_at)) / 60000, 0)).filter((x) => x > 0);
  m.image_build_min_p50 = round1(p50(img)); n.image_build_jobs = img.length;

  // failure surfacing: when a failed run ends (what an agent sees today) vs when its first failed step ended
  const surfaced = [], firstStep = [], mech = [];
  for (const r of ciRuns.filter((x) => M.isFailedConclusion(x.conclusion))) {
    const ff = M.firstFailedStep(latest(r, jobsOf(r)));
    if (!ff) continue;
    const start = t(r.run_started_at ?? r.created_at), end = (t(r.updated_at) - start) / 1000;
    surfaced.push(end); firstStep.push((t(ff.at) - start) / 1000);
    if (M.MECHANICAL_CLASSES.includes(ff.cls)) mech.push(end);
  }
  m.failure_surfaced_s_p50 = round1(p50(surfaced), 0); m.first_failed_step_s_p50 = round1(p50(firstStep), 0);
  m.mechanical_failure_surfaced_s = round1(p50(mech), 0); n.failed_runs = surfaced.length; n.mechanical_failures = mech.length;

  // releases: opened -> live
  const merged = plan.releases.map((x) => x.pr).filter((p) => p.merged_at);
  const ledgerBy = new Map((data.ledger ?? []).filter((l) => l?.pr != null).map((l) => [Number(l.pr), l]));
  const releases = merged.map((pr, i) => {
    const next = merged[i + 1] ? t(merged[i + 1].merged_at) : Infinity;
    let own = attempts.filter((a) => a.run.head_sha === pr.merge_commit_sha);
    if (!own.length) own = attempts.filter((a) => t(a.run.created_at) >= t(pr.merged_at) && t(a.run.created_at) < next);
    const firstLive = own.find((a) => a.live);
    const liveAt = plan.deployWorkflow ? firstLive?.liveAt ?? null : t(pr.merged_at);
    const led = ledgerBy.get(pr.number);
    const tries = Math.max(own.length, Number(led?.deployAttempts) || 0);
    return { pr: pr.number, opened: pr.created_at, merged: pr.merged_at, live: liveAt ? new Date(liveAt).toISOString() : null, hours: liveAt ? round1((liveAt - t(pr.created_at)) / 3600000, 2) : null,
      pushes: pushes.find((x) => x.pr === pr.number)?.pushes ?? null, deploy_attempts: tries, clean: Boolean(liveAt) && tries <= 1 && (!own.length || own[0].live) };
  });
  if (!plan.deployWorkflow) notes.push("no deploy workflow found: live = the release PR's merge time (set stats.ledger_deploy_workflow)");
  else if (!cfg.deployWorkflow) notes.push(`deploy workflow detected: ${plan.deployWorkflow} (set stats.ledger_deploy_workflow to pin it)`);
  const wentLive = releases.filter((r) => r.hours != null), clean = wentLive.filter((r) => r.clean);
  m.pr_to_live_h_median = round1(p50(wentLive.map((r) => r.hours)), 2); m.pr_to_live_h_p90 = round1(p90(wentLive.map((r) => r.hours)), 2);
  m.pr_to_live_clean_h_median = round1(p50(clean.map((r) => r.hours)), 2); m.pr_to_live_clean_h_p90 = round1(p90(clean.map((r) => r.hours)), 2);
  n.live_releases = wentLive.length; n.clean_releases = clean.length;
  const missing = plan.need.filter((id) => !jobs[id]).length;
  if (missing) notes.push(`${missing} run(s) without job data (not fetched): job-level metrics exclude them`);

  return { v: 1, repo, base, window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), days: round1((untilMs - sinceMs) / 86400000) },
    deploy_workflow: plan.deployWorkflow, n, metrics: m, table: ledgerTable(m), critical_path, setup, deploy_steps, releases, notes };
}

const fmtVal = (unit, v) => (v == null ? "n/a" : unit === "pct" ? `${(v * 100).toFixed(1)}%` : unit === "n" ? String(v) : `${v} ${unit}`);
/** Rows of the Targets table: today vs phase 1 vs end, with `status` end-met | phase1-met | not-met | no-target | n/a. */
export function ledgerTable(metrics, defs = LEDGER_METRICS) {
  return defs.map((d) => {
    const v = metrics[d.key] ?? null;
    const meets = (target) => (d.higherBetter ? v >= target : v <= target);
    const status = d.end == null ? "no-target" : v == null ? "n/a" : meets(d.end) ? "end-met" : meets(d.phase1) ? "phase1-met" : "not-met";
    return { key: d.key, label: d.label, unit: d.unit, today: v, phase1: d.phase1 ?? null, end: d.end ?? null, status };
  });
}

const mdTable = (head, rows) => { const line = (r) => `| ${r.join(" | ")} |`; return [line(head), line(head.map(() => "---")), ...rows.map(line)]; };
const tgt = (unit, v, hb) => (v == null ? "-" : `${hb ? ">=" : "<="} ${fmtVal(unit, v)}`);
export function renderReleaseLedger(r) {
  const defs = new Map(LEDGER_METRICS.map((d) => [d.key, d]));
  const out = [`Release ledger: ${r.repo}, ${r.window.since.slice(0, 10)} to ${r.window.until.slice(0, 10)} (${r.window.days} days), release base ${r.base}`,
    `${r.n.release_prs} release PR(s), ${r.n.live_releases} live (${r.n.clean_releases} clean); ${r.n.ci_runs} CI run(s), ${r.n.ci_jobs} job(s), ${r.n.rounds} round(s); ${r.n.deploy_attempts} deploy attempt(s), ${r.n.deploy_live} reached live`, "",
    ...mdTable(["Stage", "Today (measured)", "Phase 1 target", "End target", "Status"], r.table.map((x) => { const hb = defs.get(x.key)?.higherBetter; return [x.label, fmtVal(x.unit, x.today), tgt(x.unit, x.phase1, hb), tgt(x.unit, x.end, hb), x.status]; }))];
  const s = r.setup;
  out.push("", "Job setup p50 (checkout + toolchain + dependencies):");
  for (const k of ["self_hosted", "hosted"]) out.push(`  ${k.replace("_", "-")}: ${s[k].jobs ? `${s[k].checkout_s ?? "n/a"} s + ${s[k].toolchain_s ?? "n/a"} s + ${s[k].deps_s ?? "n/a"} s (total ${s[k].total_s} s, ${s[k].jobs} job(s))` : "n/a"}`);
  out.push(`CI round: wall p50 ${fmtVal("min", r.metrics.ci_round_wall_min_p50)}, p90 ${fmtVal("min", r.metrics.ci_round_wall_min_p90)}, ${fmtVal("min", r.metrics.ci_round_job_min_p50)} of jobs p50; pushes per release PR p50 ${r.metrics.pushes_per_release_pr_p50 ?? "n/a"} (max ${r.metrics.pushes_per_release_pr_max ?? "n/a"})`);
  out.push(`Failures: surfaced at run end p50 ${fmtVal("s", r.metrics.failure_surfaced_s_p50)}; the first failed step ended at p50 ${fmtVal("s", r.metrics.first_failed_step_s_p50)} (${r.n.failed_runs} failed run(s), ${r.n.mechanical_failures} mechanical)`);
  out.push(`Queue: p50 ${fmtVal("s", r.metrics.queue_s_p50)}, p90 ${fmtVal("s", r.metrics.queue_s_p90)}`);
  if (r.critical_path.length) out.push("", "Critical path (the job that ends last):", ...mdTable(["Job", "Rounds", "p50", "Fails"], r.critical_path.map((c) => [c.job, `${c.rounds} of ${c.of}`, fmtVal("min", c.min_p50), fmtVal("pct", c.fail_rate)])));
  if (r.deploy_steps.length) out.push("", `Deploy job by step (p50 over ${r.n.deploy_live} live deploy(s); run p50 ${fmtVal("min", r.metrics.deploy_run_min_p50)}):`, ...mdTable(["Step", "p50"], r.deploy_steps.map((d) => [d.step, fmtVal("min", d.min_p50)])));
  for (const note of r.notes) out.push("", `note: ${note}`);
  return out.join("\n");
}

/** Baseline record of a report: what `--baseline compare` reads back. */
export const baselineOf = (r, now = Date.now()) => ({ v: 1, saved_at: new Date(now).toISOString(), repo: r.repo, window: r.window, n: r.n, metrics: r.metrics });
/** Before/after per metric, measured the same way: verdict improved | regressed | flat (within 5%, or 2 points for a share) | null when either side is missing. */
export function compareBaseline(base, r, defs = LEDGER_METRICS) {
  const rows = defs.map((d) => {
    const before = base?.metrics?.[d.key] ?? null, after = r.metrics[d.key] ?? null;
    let verdict = null, delta = null;
    if (before != null && after != null) {
      delta = round1(after - before, 3);
      const rel = d.unit === "pct" ? Math.abs(delta) <= 0.02 : before === 0 ? after === 0 : Math.abs(delta / before) <= 0.05;
      verdict = rel ? "flat" : (delta < 0) === !d.higherBetter ? "improved" : "regressed";
    }
    return { key: d.key, label: d.label, unit: d.unit, before, after, delta, verdict };
  });
  return { baseline: { saved_at: base?.saved_at ?? null, window: base?.window ?? null, n: base?.n ?? null }, rows };
}
export function renderBaselineCompare(c, r) {
  const w = (x) => (x ? `${x.since.slice(0, 10)} to ${x.until.slice(0, 10)}` : "n/a");
  return [`Release ledger before/after: ${r.repo}`, `before: ${w(c.baseline.window)} (saved ${c.baseline.saved_at ?? "n/a"}); after: ${w(r.window)}`, "",
    ...mdTable(["Stage", "Before", "After", "Verdict"], c.rows.map((x) => [x.label, fmtVal(x.unit, x.before), fmtVal(x.unit, x.after), x.verdict ?? "n/a"]))].join("\n");
}

const PR_JQ = ".[] | {number, title, state, created_at, merged_at, closed_at, merge_commit_sha, head_ref: .head.ref, head_sha: .head.sha, base_ref: .base.ref} | @json";
const jsonLines = (out) => String(out ?? "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
/** PRs into `base` opened since `sinceMs`, newest first; stops paging at the first page that reaches the window's start. */
export async function listReleasePrs({ gh, repo, base, sinceMs }) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const rows = jsonLines(await gh(["api", `repos/${repo}/pulls?state=all&base=${encodeURIComponent(base)}&sort=created&direction=desc&per_page=100&page=${page}`, "--jq", PR_JQ]));
    out.push(...rows.filter((p) => t(p.created_at) >= sinceMs));
    if (rows.length < 100 || t(rows[rows.length - 1].created_at) < sinceMs) break;
  }
  return out;
}

const JOBS_CACHE = "actions-jobs.json";
function loadJobsCache(repo, env) { try { const c = JSON.parse(readFileSync(join(cacheDir(repo, env), JOBS_CACHE), "utf8")); return c?.v === 1 && c.runs ? c : { v: 1, runs: {} }; } catch { return { v: 1, runs: {} }; } }
function saveJobsCache(repo, cache, env) { try { const dir = cacheDir(repo, env); mkdirSync(dir, { recursive: true }); const tmp = join(dir, `${JOBS_CACHE}.${process.pid}.tmp`); writeFileSync(tmp, JSON.stringify(cache)); renameSync(tmp, join(dir, JOBS_CACHE)); } catch { /* the cache is optional */ } }

/**
 * Reads everything the ledger needs: the release PRs, the runs of the release head branches and of the base (paginated, one
 * query per branch and event) and the jobs of the ledger's runs only (4 at a time). Jobs of a completed run never change, so they are cached per (run, attempt) next to the stats cache;
 * `maxRuns` bounds the job fetches of one call (newest first) and the report notes what was left out.
 */
export async function gatherReleaseLedger({ gh, repo, sinceMs, untilMs = Date.now(), cfg = {}, env = process.env, useCache = true, maxRuns = 600, onProgress = () => {}, ledger = [] }) {
  const base = cfg.releaseBase ?? String(await gh(["api", `repos/${repo}`, "--jq", ".default_branch"])).trim();
  const prs = await listReleasePrs({ gh, repo, base, sinceMs });
  // Scoped reads: PR-event runs of each release head branch (push runs only where a head has none) and the non-PR runs of the base.
  const heads = [...new Set(prs.filter((p) => !cfg.releaseHead || p.head_ref === cfg.releaseHead).map((p) => p.head_ref))], seen = new Map();
  const read = async (branch, event) => { for (const r of await M.listRuns({ gh, repo, sinceMs, untilMs, branch, event })) seen.set(r.id, r); };
  for (const head of heads) {
    const before = seen.size;
    for (const e of CI_EVENTS) await read(head, e);
    if (seen.size === before) await read(head, "push");
  }
  for (const e of DEPLOY_EVENTS) await read(base, e);
  const runs = [...seen.values()];
  const plan = planLedger({ prs, runs, base, cfg, untilMs });
  const byId = new Map(runs.map((r) => [r.id, r]));
  const cache = useCache ? loadJobsCache(repo, env) : { v: 1, runs: {} };
  const key = (r) => `${r.id}:${r.run_attempt ?? 1}`;
  const jobs = {}, todo = [];
  for (const id of plan.need) { const r = byId.get(id), hit = cache.runs[key(r)]; if (hit) jobs[id] = hit; else todo.push(r); }
  todo.sort((a, b) => t(b.created_at) - t(a.created_at));
  const batch = todo.slice(0, maxRuns);
  let done = 0;
  const worker = async () => { for (let r; (r = batch.shift());) { jobs[r.id] = await M.listRunJobs({ gh, repo, runId: r.id }); cache.runs[key(r)] = jobs[r.id]; onProgress({ done: ++done, total: done + batch.length }); } };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (useCache && done) saveJobsCache(repo, cache, env);
  return { repo, sinceMs, untilMs, base, prs, runs, jobs, ledger };
}

/** `--since` of the ledger: a date (YYYY-MM-DD[T...]) or a window (`21d`, `36h`); default 21 days. */
export function ledgerSince(since, now = Date.now()) {
  if (!since) return now - 21 * 86400000;
  const w = /^(\d+)([dh])$/.exec(since);
  if (w) return now - Number(w[1]) * (w[2] === "d" ? 86400000 : 3600000);
  const ms = /^\d{4}-\d{2}-\d{2}/.test(since) ? Date.parse(since) : NaN;
  if (Number.isNaN(ms)) throw new Error(`--since must be a date (YYYY-MM-DD) or a window (21d, 36h) with --release-ledger: ${since}`);
  return ms;
}
export const baselinePath = (repo, file, env = process.env) => file ?? join(cacheDir(repo, env), "release-ledger-baseline.json");

/** `forgedock stats --release-ledger`: 0, 1 on a read failure, 2 when `--baseline compare` has no baseline. */
export async function runReleaseLedger(opts, deps = {}) {
  const now = deps.now?.() ?? Date.now(), env = deps.env ?? process.env, write = deps.write ?? ((s) => process.stdout.write(s));
  const cfg = { ...(deps.config ?? {}), ...(opts.deployWorkflow ? { deployWorkflow: opts.deployWorkflow } : {}), ...(opts.releaseHead ? { releaseHead: opts.releaseHead === "any" ? null : opts.releaseHead } : {}) };
  const data = await gatherReleaseLedger({ gh: deps.gh, repo: opts.repo, sinceMs: ledgerSince(opts.since, now), untilMs: now, cfg, env, useCache: opts.cache !== false, onProgress: deps.onProgress, ledger: deps.ledger ?? [] });
  const report = computeReleaseLedger(data, cfg);
  const file = baselinePath(opts.repo, opts.baselineFile, env);
  if (opts.baseline === "compare") {
    let base = null;
    try { base = JSON.parse(readFileSync(file, "utf8")); } catch { /* reported below */ }
    if (!base?.metrics) { process.stderr.write(`forgedock stats: no baseline at ${file} (run --release-ledger --baseline save first)\n`); return 2; }
    const cmp = compareBaseline(base, report);
    write(`${opts.json ? JSON.stringify({ ...report, compare: cmp }, null, 2) : `${renderBaselineCompare(cmp, report)}\n\n${renderReleaseLedger(report)}`}\n`);
    return 0;
  }
  if (opts.baseline === "save") { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(baselineOf(report, now), null, 2)}\n`); }
  write(`${opts.json ? JSON.stringify(report, null, 2) : renderReleaseLedger(report)}\n`);
  if (opts.baseline === "save" && !opts.json) write(`\nbaseline saved: ${file}\n`);
  return 0;
}
