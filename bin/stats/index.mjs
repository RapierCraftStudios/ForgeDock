// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forgedock stats (forge#3835): a deterministic version-over-version report, no model in the loop.
 * GitHub is the primary source (trusted FORGE:TELEMETRY comments + labels); ~/.forge/stats-cache is an optional,
 * deletable cache; ~/.forge/runs is an optional extra source for runs that predate telemetry.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aggregate, computeAlerts, DEFAULT_ALERTS, DEFAULT_MIN_N } from "./aggregate.mjs";
import { defaultGh, fetchGithubRecords, isValidRepo, toModel } from "./github-source.mjs";
import { readLanes, readLocalLaneRuns, readLocalRuns, runsDir } from "./local-source.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";
import { renderCompact, renderJson, renderMarkdown } from "./render.mjs";
import { edgeQuery, parseEdge, verdictMix, contextPackAb, renderContextAb, builderTierReport, renderTiers, exploreAb, renderExploreAb, laneProfileReport, renderLaneProfiles } from "./query.mjs";
import { batchEfficiency, windowEfficiency, compareEfficiency, formatEfficiencyLines, formatCompareLines, parseWindows } from "./efficiency.mjs";
import { releaseMetrics, renderReleaseMetrics, metricsComment, postMetrics } from "./release.mjs";
import { experimentReport, renderExperiment } from "./experiment.mjs";
import { readExperiment } from "../experiment.mjs";
import { poolUtilisation, formatPoolLines } from "./pool.mjs";
import { batchRoot } from "../lean/batch.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const HELP = `Usage: forgedock stats [--since <version|date>] [--repo <owner/repo>] [--json] [--refresh]
                      [--compact] [--no-local] [--no-cache] [--min-n N] [--release-times FILE]
       forgedock stats --experiment <id> [--min-n N] [--repo <owner/repo>] [--json]
       forgedock stats --by version [--post-metrics <pr>] [--min-n N] [--repo <owner/repo>] [--json]
       forgedock stats --pool [--window 7d,30d] [--repo <owner/repo>] [--json]
       forgedock stats --efficiency [--batch <id>] [--window 7d,30d] [--compare <date|version>] [--offline] [--repo <owner/repo>] [--json]

Version-over-version report: Cost, Time, Flow, Review funnel, Gates and Issue flow per (version, repo), with a
delta against the previous version and a low-n flag for samples under 10. Missing data prints n/a.

  --since <v|date>      only versions >= <v> (e.g. 1.16.0) or activity on/after <date> (YYYY-MM-DD);
                        also bounds the GitHub crawl to that window
  --repo <owner/repo>   target repo (default: forge.yaml project, else the git origin remote)
  --json                machine-readable output
  --refresh             ignore the local cache and re-read everything from GitHub
  (progress is printed to stderr while crawling)
  --compact             one-row-per-version table (embedded in the staging review summary)
  --no-local            ignore ~/.forge/runs (FORGE_RUNS_DIR)
  --no-cache            do not read or write ~/.forge/stats-cache
  --min-n N             low-n threshold (default ${DEFAULT_MIN_N})
  --release-times FILE  "<version> <epoch-seconds>" lines used to estimate versions of unversioned records
                        (default: git tags v* of the ForgeDock checkout)

Per-release regression rule (forge#4628):
  --experiment <id>     arms of the forge.yaml experiment: section (arms, ratio, metrics, targets, min_n) against its targets; n/a below min n
  --emit-event          with --experiment: emit one experiment.verdict event (met or missed; docs/EVENTS.md)
  --by version          median cost per run, wall p50, first-pass rate and needs-human rate of each release against the
                        previous one; a metric under --min-n runs is null and its verdict null, never a pass
  --post-metrics <pr>   post (or update) the <!-- FORGE:METRICS v1 --> snapshot comment on that release PR

ALERTS (forge#4354; local run logs only, skipped with --no-local): fail-soft rates over the last 50 lanes of the repo
(DEPS_PREPARED failed per ecosystem, deferred-to-ci, repeated TOOLCHAIN_WARNING, outcome codes whose share doubled);
thresholds under forge.yaml stats.alerts.*. Nothing is printed when none fired or under 10 lanes.

Audit queries (forge#4165; JSON, from structure_delta / run_terminal telemetry, no comment bodies read):
  --edge FROM:TO        merged PRs that added the dependency or import edge FROM -> TO (e.g. @s/web:@s/db)
  --milestone M         conformance verdict mix and per-day structure series for milestone M

Context-pack A/B (forge#4275; local run logs only, no GitHub crawl):
  --context-ab          first-pass yield, builder turns, cache tokens and cost per lane type (rerun, child,
                        first) and context_pack mode (on, off, shadow); --json for JSON

Explorer A/B (forge#4418; local run logs only, every run of each log, no GitHub crawl):
  --explore-ab          builder turns, builder cache-read, merge and conformance rates per size (S, M, L) and
                        lean.explore mode (on, off), plus the same issues run in both modes; --json for JSON

Pool (forge#4549; local batch reports, no gh):
  --pool                remote lane minutes, lanes and share per pool agent over --window (default 7d,30d)

Efficiency (forge#4402; local batch dirs and run logs, gh only for merged issues' bodies, labels and probes):
  --efficiency          $/merge, turns/merge, context/turn per size and model, retries/merge by cause, no-action
                        lanes, issue quality vs cost and the acceptance pass rate 7 days after promotion
  --batch <id>          also report one batch (~/.forge/batches/<id>, FORGEDOCK_BATCH_DIR)
  --window <list>       trailing windows over the repo's batches (default 7d,30d)
  --compare <date|v>    before/after A/B around a deploy (date or release tag): equal-span cohorts of batches either side,
                        turns/merge, implement wall p50, calls/turn p50, re-reads/merge, merge and conformance rates,
                        their delta and full-lane cohorts matched per size (forge#4491)
  --offline             skip the GitHub crawl for merged issues (issue quality and acceptance print n/a)

Builder model tiers (forge#4394; local run logs only, no GitHub crawl):
  --tiers               merge, conformance and post-merge-rework rates, first-pass yield and cost per builder tier
                        (mid, mid->top escalated, top) and routing class; --json for JSON

Lane profile baseline (forge#4436; local run logs only, every run of each issue, no GitHub crawl):
  --lane-profile        first-turn baseline_tokens per lane profile (full, memory-off, lane) and phase, and the
                        conformance rate per profile; --json for JSON
  --issues <list>       pin the report to these issues (comma list), for a before/after on the same issue set
`;

export function parseArgs(argv) {
  const o = { since: null, repo: null, edge: null, milestone: null, contextAb: false, exploreAb: false, tiers: false, laneProfile: false, issues: null, efficiency: false, pool: false, batch: null, windows: null, compare: null, by: null, experiment: null, emitEvent: false, postMetrics: null, offline: false, json: false, refresh: false, compact: false, local: true, cache: true, minN: DEFAULT_MIN_N, releaseTimes: null, help: false };
  const val = (i, name) => {
    const v = argv[i + 1];
    if (v == null || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : null;
    const name = eq ? eq[0] : a;
    const take = () => { if (eq) return eq[1]; const v = val(i, name); i++; return v; };
    if (name === "--since") o.since = take();
    else if (name === "--repo") o.repo = take();
    else if (name === "--release-times") o.releaseTimes = take();
    else if (name === "--edge") { const v = take(); if (!parseEdge(v)) throw new Error("--edge must be FROM:TO"); o.edge = v; }
    else if (name === "--milestone") o.milestone = take();
    else if (name === "--context-ab") o.contextAb = true;
    else if (name === "--explore-ab") o.exploreAb = true;
    else if (name === "--tiers") o.tiers = true;
    else if (name === "--lane-profile") o.laneProfile = true;
    else if (name === "--issues") { const v = take(); if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(v)) throw new Error("--issues must be a comma list of issue numbers"); o.issues = v.split(",").map(Number); }
    else if (name === "--efficiency") o.efficiency = true;
    else if (name === "--pool") o.pool = true;
    else if (name === "--batch") { const v = take(); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) throw new Error(`invalid --batch id: ${v}`); o.batch = v; }
    else if (name === "--window") o.windows = parseWindows(take());
    else if (name === "--compare") { // #4491
      const v = take(), bad = () => new Error(`--compare must be a date (YYYY-MM-DD[THH:MM:SSZ]) or a version (1.32.0): ${v}`);
      try { if (!v || !Object.keys(parseSince(v)).length) throw bad(); } catch { throw bad(); }
      o.compare = v;
    }
    else if (name === "--by") { const v = take(); if (v !== "version") throw new Error("--by must be version"); o.by = v; }
    else if (name === "--experiment") { const v = take(); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) throw new Error("--experiment must be an experiment id"); o.experiment = v; }
    else if (name === "--emit-event") o.emitEvent = true;
    else if (name === "--post-metrics") { const v = take(); if (!/^[1-9]\d*$/.test(v)) throw new Error("--post-metrics must be a PR number"); o.postMetrics = Number(v); }
    else if (name === "--offline") o.offline = true;
    else if (name === "--min-n") { const v = take(); if (!/^\d+$/.test(v)) throw new Error("--min-n must be a non-negative integer"); o.minN = Number(v); o.minNSet = true; }
    else if (name === "--json") o.json = true;
    else if (name === "--refresh") o.refresh = true;
    else if (name === "--compact") o.compact = true;
    else if (name === "--no-local") o.local = false;
    else if (name === "--no-cache") o.cache = false;
    else if (name === "--help" || name === "-h") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.batch && !o.efficiency) throw new Error("--batch and --window need --efficiency");
  if (o.windows && !o.efficiency && !o.pool) throw new Error("--batch and --window need --efficiency");
  if ((o.compare || o.offline) && !o.efficiency) throw new Error("--compare and --offline need --efficiency");
  if (o.postMetrics && !o.by) throw new Error("--post-metrics needs --by version");
  return o;
}

/** "--since" is a date (YYYY-MM-DD[...]) or a version (1.16.0). */
export function parseSince(since) {
  if (!since) return {};
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
    const ms = Date.parse(since);
    if (Number.isNaN(ms)) throw new Error(`invalid --since date: ${since}`);
    return { sinceMs: ms };
  }
  if (/^v?\d+(\.\d+)*$/.test(since)) return { sinceVersion: since.replace(/^v/, "") };
  throw new Error(`--since must be a version (1.16.0) or a date (YYYY-MM-DD): ${since}`);
}

export function parseReleaseTimes(text) {
  return String(text ?? "").split("\n").map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2 && /^\d+$/.test(p[1])).map((p) => ({ v: p[0].replace(/^v/, ""), t: Number(p[1]) }));
}

// A version --since becomes the tag's release time minus this margin: unversioned records are placed by release time, so
// the crawl must start a little before the tag.
const VERSION_SINCE_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Lower-bound timestamp for the GitHub crawl from `--since`: a date as is, a version as its tag time minus a margin.
 * Returns { since: ISO | null, note }: since null means a full crawl (no --since, or a version with no known tag time).
 */
export function sinceToTimestamp(since, releaseTimes = []) {
  const p = parseSince(since);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (p.sinceMs != null) return { since: iso(p.sinceMs), note: null };
  if (p.sinceVersion) {
    const hit = releaseTimes.find((r) => r.v === p.sinceVersion);
    if (hit) return { since: iso(hit.t * 1000 - VERSION_SINCE_MARGIN_MS), note: null };
    return { since: null, note: `no release time known for ${p.sinceVersion}; crawling the full history (pass --release-times or use a date to bound it)` };
  }
  return { since: null, note: null };
}

/** #4491: `--compare` pivot in ms: a date as is, a version as its exact tag time (no crawl margin); throws when unknown. */
export function comparePivot(v, releaseTimes = []) {
  const p = parseSince(v);
  if (p.sinceMs != null) return p.sinceMs;
  const hit = releaseTimes.find((r) => r.v === p.sinceVersion);
  if (!hit) throw new Error(`--compare: no release time known for ${p.sinceVersion} (pass --release-times or a date)`);
  return hit.t * 1000;
}

/** Throttled stderr progress printer (never stdout, so --json stays parseable). */
export function makeProgressPrinter(write = (t) => process.stderr.write(t), now = Date.now) {
  let last = 0, lastPhase = null;
  return ({ phase, done, total }) => {
    const t = now();
    const final = total != null && done >= total;
    if (phase === lastPhase && !final && t - last < 2000) return;
    last = t; lastPhase = phase;
    write(`forgedock stats: ${phase} ${done}${total != null ? `/${total}` : ""}\n`);
  };
}

function gitTagTimes() {
  try {
    const out = execFileSync("git", ["-C", join(here, "..", ".."), "for-each-ref", "refs/tags", "--format=%(refname:short) %(creatordate:unix)"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseReleaseTimes(out.split("\n").filter((l) => /^v\d/.test(l)).join("\n"));
  } catch { return []; }
}

/** --repo, else forge.yaml project.owner/repo, else the git origin remote. */
export function resolveRepo(explicit, cwd = process.cwd()) {
  if (explicit) return explicit;
  for (const f of ["forge.yaml", ".forge.yaml"]) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    try {
      const m = /^project:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(readFileSync(p, "utf8"));
      const owner = /^[ \t]+owner:\s*"?([\w.-]+)"?/m.exec(m?.[1] ?? "")?.[1];
      const repo = /^[ \t]+repo:\s*"?([\w.-]+)"?/m.exec(m?.[1] ?? "")?.[1];
      if (owner && repo) return `${owner}/${repo}`;
    } catch { /* fall through */ }
  }
  try {
    const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
    if (m) return `${m[1]}/${m[2]}`;
  } catch { /* none */ }
  return null;
}

const ALERT_KEYS = { window: "window", min_lanes: "minLanes", deps_failed_pct: "depsFailedPct", deferred_to_ci_pct: "deferredPct",
  toolchain_warning_pct: "toolchainWarningPct", outcome_share_factor: "outcomeShareFactor" };

/**
 * forge.yaml `stats.alerts.*` (forge#4354). The one-level parser flattens a nested `alerts:` block under `stats:` to
 * `stats.<key>`; the flat `stats.alerts_<key>` form also works and wins. Invalid or unreadable values keep DEFAULT_ALERTS.
 */
export function readAlertConfig(cwd = process.cwd()) {
  const out = { ...DEFAULT_ALERTS };
  try {
    const s = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.stats ?? {};
    for (const [key, name] of Object.entries(ALERT_KEYS)) {
      const raw = String(s[`alerts_${key}`] ?? s[key] ?? "").trim(), n = Number(raw);
      if (raw !== "" && Number.isFinite(n) && n > 0) out[name] = n;
    }
  } catch { /* no forge.yaml: defaults */ }
  return out;
}

/** Build the report object. deps: { gh, env, localRuns, now, onProgress, warn, sleep } for tests. Never touches the network when `gh` is stubbed. */
export async function buildReport(opts, deps = {}) {
  const env = deps.env ?? process.env;
  const repo = opts.repo;
  let releaseTimes = [];
  if (opts.releaseTimes) releaseTimes = parseReleaseTimes(readFileSync(opts.releaseTimes, "utf8"));
  else if (deps.releaseTimes) releaseTimes = deps.releaseTimes;
  else releaseTimes = gitTagTimes();
  if (opts.pool) { // forge#4549: local batch reports only
    const pool = poolUtilisation({ batchRoot: deps.batchRoot ?? batchRoot(env), repo, windows: opts.windows ?? parseWindows("7d,30d"), now: deps.now?.() ?? Date.now() });
    return { repo, query: { pool } };
  }
  if (opts.efficiency) { // forge#4402: local batch dirs + run logs; gh only for merged issues
    const root = deps.batchRoot ?? batchRoot(env), rd = deps.runsDir ?? runsDir(env), now = deps.now?.() ?? Date.now(), gh = opts.offline ? null : (deps.gh ?? defaultGh);
    const efficiency = {};
    if (opts.batch) efficiency.batch = await batchEfficiency({ batchDir: join(root, opts.batch), runsDir: rd, repo, gh, now });
    efficiency.windows = await windowEfficiency({ batchRoot: root, runsDir: rd, repo, gh, now, windows: opts.windows ?? parseWindows("7d,30d") });
    if (opts.compare) efficiency.compare = await compareEfficiency({ batchRoot: root, runsDir: rd, repo, gh, now, pivot: comparePivot(opts.compare, releaseTimes) });
    return { repo, query: { efficiency } };
  }
  if (opts.contextAb) { // forge#4275: run logs only
    const runs = (deps.localRuns ?? readLocalRuns(runsDir(env))).filter((r) => r.repo == null || r.repo === repo);
    return { repo, sources: { local: { runs: runs.length } }, query: { context_ab: contextPackAb(runs) } };
  }
  if (opts.exploreAb) { // forge#4418: run logs only, every RUN_START slice
    const runs = (deps.localRuns ?? readLocalLaneRuns(runsDir(env))).filter((r) => r.repo == null || r.repo === repo);
    return { repo, sources: { local: { runs: runs.length } }, query: { explore_ab: exploreAb(runs) } };
  }
  if (opts.tiers) { // forge#4394: run logs only
    const runs = (deps.localRuns ?? readLocalRuns(runsDir(env))).filter((r) => r.repo == null || r.repo === repo);
    return { repo, sources: { local: { runs: runs.length } }, query: { tiers: builderTierReport(runs) } };
  }
  if (opts.laneProfile) { // forge#4436: run logs only, every RUN_START slice
    const runs = (deps.localRuns ?? readLocalRuns(runsDir(env), { allSlices: true })).filter((r) => r.repo == null || r.repo === repo);
    return { repo, sources: { local: { runs: runs.length } }, query: { lane_profile: laneProfileReport(runs, { issues: opts.issues }) } };
  }
  const bound = sinceToTimestamp(opts.since, releaseTimes);
  if (bound.note) (deps.warn ?? ((m) => process.stderr.write(`forgedock stats: ${m}\n`)))(bound.note);
  const gh = await fetchGithubRecords({ repo, since: bound.since, refresh: opts.refresh, useCache: opts.cache, gh: deps.gh, env,
    onProgress: deps.onProgress, sleep: deps.sleep, now: deps.now });
  if (opts.edge || opts.milestone) { // forge#4165: audit query instead of the version report
    const e = opts.edge ? parseEdge(opts.edge) : null;
    const query = { ...(e ? { edge: { ...e, prs: edgeQuery(gh.records, e.from, e.to) } } : {}), ...(opts.milestone ? { mix: verdictMix(gh.records, gh.items, opts.milestone) } : {}) };
    return { repo, sources: { github: { items: gh.items.length, records: gh.records.length, cached: gh.fromCache } }, query };
  }
  const model = toModel(repo, gh);
  const ghKeys = new Set(model.runs.map((r) => `${r.repo}#${r.issue}`));
  let local = [];
  if (opts.local) {
    local = (deps.localRuns ?? readLocalRuns(runsDir(env))).filter((r) => r.repo === repo && !ghKeys.has(`${r.repo}#${r.issue}`));
  }
  const report = aggregate({ runs: [...model.runs, ...local], events: model.events, issues: model.issues },
    { minN: opts.minN, releaseTimes, ...parseSince(opts.since) });
  if (opts.experiment) { // forge#4629
    const exp = deps.experiment ?? readExperiment();
    if (!exp || exp.id !== opts.experiment) throw new Error(`experiment ${opts.experiment} is not declared in forge.yaml (experiment: id, arms, ...)`);
    return { repo, sources: { github: { items: gh.items.length, records: gh.records.length, cached: gh.fromCache }, local: { runs: local.length } }, query: { experiment: experimentReport([...model.runs, ...local], { ...exp, minN: opts.minNSet ? opts.minN : exp.minN }) } };
  }
  if (opts.by) return { repo, sources: { github: { items: gh.items.length, records: gh.records.length, cached: gh.fromCache }, local: { runs: local.length } }, query: { release_metrics: releaseMetrics(report.groups, { minN: opts.minN, repo }) } };
  // forge#4354: fail-soft alerts from the local run logs only (no gh call)
  const alerts = opts.local ? computeAlerts(deps.localLanes ?? readLanes(runsDir(env)), { repo, ...(deps.alertConfig ?? readAlertConfig()) }) : [];
  return { repo, sources: { github: { items: gh.items.length, records: gh.records.length, cached: gh.fromCache }, local: { runs: local.length } }, ...report, alerts };
}

export async function runStats(argv, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) {
    process.stderr.write(`forgedock stats: ${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) { process.stdout.write(HELP); return 0; }
  opts.repo = resolveRepo(opts.repo);
  if (!opts.repo || !isValidRepo(opts.repo)) {
    process.stderr.write(`forgedock stats: could not resolve a valid owner/repo (pass --repo owner/repo)\n`);
    return 2;
  }
  try {
    const report = await buildReport(opts, { onProgress: makeProgressPrinter(), ...deps });
    if (report.query?.release_metrics) {
      const rm = report.query.release_metrics;
      if (opts.postMetrics) await postMetrics({ gh: deps.gh ?? defaultGh, repo: opts.repo, pr: opts.postMetrics, body: metricsComment(rm) });
      process.stdout.write(`${opts.json ? renderJson(report) : renderReleaseMetrics(rm)}\n`);
      return 0;
    }
    if (report.query?.experiment && opts.emitEvent) await (deps.emitExperiment ?? (async (r, x) => (await import("../engine-cli.mjs")).experimentEventSink(r, x)))(opts.repo, report.query.experiment);
    if (report.query?.experiment) { process.stdout.write(`${opts.json ? renderJson(report) : renderExperiment(report.query.experiment)}\n`); return 0; }
    if (report.query?.lane_profile && !opts.json) { process.stdout.write(`${renderLaneProfiles(report.query.lane_profile)}\n`); return 0; }
    if (report.query?.tiers && !opts.json) { process.stdout.write(`${renderTiers(report.query.tiers)}\n`); return 0; }
    if (report.query?.pool && !opts.json) { process.stdout.write(`${formatPoolLines(report.query.pool).join("\n")}\n`); return 0; }
    if (report.query?.efficiency && !opts.json) {
      const e = report.query.efficiency;
      const lines = [...(e.batch ? formatEfficiencyLines(e.batch, `batch ${e.batch.batch ?? opts.batch}`) : []),
        ...Object.entries(e.windows).flatMap(([w, m]) => formatEfficiencyLines(m, `${w}, ${m.batches} batch${m.batches === 1 ? "" : "es"}`)),
        ...(e.compare ? formatCompareLines(e.compare) : [])];
      process.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }
    if (report.query?.context_ab && !opts.json) { process.stdout.write(`${renderContextAb(report.query.context_ab)}\n`); return 0; }
    if (report.query?.explore_ab && !opts.json) { process.stdout.write(`${renderExploreAb(report.query.explore_ab)}\n`); return 0; }
    process.stdout.write(`${opts.json || report.query ? renderJson(report) : opts.compact ? renderCompact(report) : renderMarkdown(report)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`forgedock stats: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runStats(process.argv.slice(2));
}
